/**
 * Mistral Realtime Transcription Provider
 *
 * Uses the Mistral Realtime Transcription API for streaming speech-to-text with:
 * - PCM S16LE audio (converted from mu-law on the fly)
 * - Client-side silence detection for turn segmentation (Mistral has no server VAD)
 * - Low-latency streaming transcription via target_streaming_delay_ms
 * - Partial transcript callbacks for real-time UI updates
 *
 * @see https://docs.mistral.ai/capabilities/audio/speech_to_text/realtime_transcription
 */

import type {
  RealtimeTranscriptionProviderConfig,
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import WebSocket from "ws";

const DEFAULT_MODEL = "voxtral-mini-transcribe-realtime-2602";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_SILENCE_DURATION_MS = 800;
/** Low-latency preset; trades some accuracy for faster partial results. */
const DEFAULT_TARGET_STREAMING_DELAY_MS = 240;
/** Minimum RMS energy to treat a PCM chunk as speech rather than silence/background. */
const SPEECH_ENERGY_THRESHOLD = 300;

// ---------------------------------------------------------------------------
// Config normalization (plugin-owned blob in streaming.providers.mistral)
// ---------------------------------------------------------------------------

type MistralRealtimeTranscriptionProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  silenceDurationMs?: number;
  targetStreamingDelayMs?: number;
};

type MistralRealtimeTranscriptionSessionConfig = RealtimeTranscriptionSessionCreateRequest & {
  apiKey: string;
  baseUrl: string;
  model: string;
  silenceDurationMs: number;
  targetStreamingDelayMs: number;
};

function trimToUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeProviderConfig(
  config: RealtimeTranscriptionProviderConfig,
): MistralRealtimeTranscriptionProviderConfig {
  const providers = asObject(config.providers);
  const raw = asObject(providers?.mistral) ?? asObject(config.mistral) ?? asObject(config);
  return {
    apiKey:
      normalizeResolvedSecretInputString({
        value: raw?.apiKey,
        path: "plugins.entries.voice-call.config.streaming.providers.mistral.apiKey",
      }) ??
      normalizeResolvedSecretInputString({
        value: raw?.mistralApiKey,
        path: "plugins.entries.voice-call.config.streaming.mistralApiKey",
      }),
    baseUrl: trimToUndefined(raw?.baseUrl),
    model: trimToUndefined(raw?.model) ?? trimToUndefined(raw?.mistralSttModel),
    silenceDurationMs: asNumber(raw?.silenceDurationMs),
    targetStreamingDelayMs: asNumber(raw?.targetStreamingDelayMs),
  };
}

function readProviderConfig(
  providerConfig: RealtimeTranscriptionProviderConfig,
): MistralRealtimeTranscriptionProviderConfig {
  return normalizeProviderConfig(providerConfig);
}

// ---------------------------------------------------------------------------
// Mu-law → PCM conversion (Twilio sends mu-law 8kHz; Mistral needs PCM S16LE)
// ---------------------------------------------------------------------------

function mulawToLinear(mulaw: number): number {
  mulaw = ~mulaw & 0xff;
  const sign = mulaw & 0x80;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0f;
  let sample = ((mantissa << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

function mulawToPcm(mulaw: Buffer): Buffer {
  const pcm = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    pcm.writeInt16LE(mulawToLinear(mulaw[i]!), i * 2);
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// WebSocket URL construction
// ---------------------------------------------------------------------------

function buildWsUrl(baseUrl: string, model: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${normalized}/audio/transcriptions/realtime`);
  url.searchParams.set("model", model);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Session implementation
// ---------------------------------------------------------------------------

type MistralRealtimeEvent = {
  type: string;
  text?: string;
  error?: unknown;
};

/**
 * WebSocket-based session for Mistral real-time speech-to-text.
 *
 * Audio flow:
 *   Twilio mu-law 8kHz → mulawToPcm() → PCM S16LE 8kHz → base64 → input_audio.append
 *
 * Turn detection:
 *   No server-side VAD. A silence timer fires when no speech-energy chunks
 *   arrive within the configured window. On expiry an input_audio.flush is
 *   sent; the server responds with transcription.done containing the full
 *   utterance text.
 */
class MistralRealtimeTranscriptionSession implements RealtimeTranscriptionSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private speechStarted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: MistralRealtimeTranscriptionSessionConfig) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }

    // Mistral expects PCM S16LE; Twilio sends mu-law 8kHz
    const pcm = mulawToPcm(audio);
    this.sendEvent({
      type: "input_audio.append",
      audio: pcm.toString("base64"),
    });

    // Only reset the silence timer when the chunk contains actual speech energy.
    // Twilio streams audio continuously (including background silence between
    // turns), so resetting on every chunk would prevent the timer from ever
    // firing after the user stops talking.
    if (hasSpeechEnergy(pcm)) {
      this.resetSilenceTimer();
    }
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.resetSpeechState();
    if (this.ws) {
      this.ws.close(1000, "Transcription session closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const wsUrl = buildWsUrl(this.config.baseUrl, this.config.model);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error("Mistral realtime transcription connection timeout"));
      }, MistralRealtimeTranscriptionSession.CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.reconnectAttempts = 0;

        // Configure the transcription session
        this.sendEvent({
          type: "session.update",
          session: {
            audio_format: {
              encoding: "pcm_s16le",
              sample_rate: 8000,
            },
            target_streaming_delay_ms: this.config.targetStreamingDelayMs,
          },
        });

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          this.handleEvent(JSON.parse(data.toString()) as MistralRealtimeEvent);
        } catch (error) {
          this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.ws.on("error", (error) => {
        if (!this.connected) {
          clearTimeout(connectTimeout);
          reject(error);
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      this.ws.on("close", () => {
        this.connected = false;
        // Clear in-flight speech state so a reconnected session starts clean.
        this.resetSpeechState();
        if (this.closed) {
          return;
        }
        void this.attemptReconnect();
      });
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.reconnectAttempts >= MistralRealtimeTranscriptionSession.MAX_RECONNECT_ATTEMPTS) {
      this.config.onError?.(new Error("Mistral realtime transcription reconnect limit reached"));
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      MistralRealtimeTranscriptionSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.closed) {
      return;
    }
    try {
      await this.doConnect();
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect();
    }
  }

  private handleEvent(event: MistralRealtimeEvent): void {
    switch (event.type) {
      case "transcription.text.delta":
        if (event.text) {
          if (!this.speechStarted) {
            this.speechStarted = true;
            this.config.onSpeechStart?.();
          }
          this.pendingTranscript += event.text;
          this.config.onPartial?.(this.pendingTranscript);
        }
        return;

      case "transcription.done":
        if (event.text) {
          this.config.onTranscript?.(event.text);
        }
        this.pendingTranscript = "";
        this.speechStarted = false;
        return;

      case "error": {
        const err = event.error as Record<string, unknown> | null | undefined;
        const msg = typeof err?.message === "string" ? err.message : JSON.stringify(event.error);
        const code = err?.code != null ? ` (code: ${err.code})` : "";
        this.config.onError?.(new Error(`Mistral realtime error${code}: ${msg}`));
        return;
      }

      default:
        return;
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      // Flush the audio buffer, prompting Mistral to finalize the current utterance.
      this.sendEvent({ type: "input_audio.flush" });
    }, this.config.silenceDurationMs);
  }

  private resetSpeechState(): void {
    this.speechStarted = false;
    this.pendingTranscript = "";
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the PCM chunk has RMS energy above the speech threshold.
 * Mu-law decoded silence is very close to 0; speech on a typical phone call
 * is well above the configured threshold.
 */
function hasSpeechEnergy(pcm: Buffer): boolean {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return false;
  }
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples) >= SPEECH_ENERGY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function buildMistralRealtimeTranscriptionProvider(): RealtimeTranscriptionProviderPlugin {
  return {
    id: "mistral",
    label: "Mistral Realtime Transcription",
    aliases: ["mistral-realtime"],
    autoSelectOrder: 20,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      Boolean(readProviderConfig(providerConfig).apiKey || process.env.MISTRAL_API_KEY),
    createSession: (req) => {
      const config = readProviderConfig(req.providerConfig);
      const apiKey = config.apiKey || process.env.MISTRAL_API_KEY;
      if (!apiKey) {
        throw new Error("Mistral API key missing");
      }
      return new MistralRealtimeTranscriptionSession({
        ...req,
        apiKey,
        baseUrl: config.baseUrl?.replace(/\/+$/, "") || DEFAULT_BASE_URL,
        model: config.model || DEFAULT_MODEL,
        silenceDurationMs: config.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS,
        targetStreamingDelayMs: config.targetStreamingDelayMs ?? DEFAULT_TARGET_STREAMING_DELAY_MS,
      });
    },
  };
}
