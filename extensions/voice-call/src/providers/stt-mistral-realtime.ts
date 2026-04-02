/**
 * Mistral Realtime STT Provider
 *
 * Uses the Mistral Realtime Transcription API for streaming transcription with:
 * - PCM S16LE audio (converted from mu-law on the fly)
 * - Client-side silence detection for turn segmentation (Mistral has no server VAD)
 * - Low-latency streaming transcription via target_streaming_delay_ms
 * - Partial transcript callbacks for real-time UI updates
 *
 * @see https://docs.mistral.ai/capabilities/audio/speech_to_text/realtime_transcription
 */

import WebSocket from "ws";
import { mulawToPcm } from "../telephony-audio.js";
import type { RealtimeSTTProvider, RealtimeSTTSession } from "./stt-openai-realtime.js";

const DEFAULT_MODEL = "voxtral-mini-transcribe-realtime-2602";
const DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_SILENCE_DURATION_MS = 800;
/** Low-latency preset; trades some accuracy for faster partial results. */
const DEFAULT_TARGET_STREAMING_DELAY_MS = 240;

export interface MistralRealtimeSTTConfig {
  /** Mistral API key */
  apiKey: string;
  /** Base URL (default: https://api.mistral.ai/v1) */
  baseUrl?: string;
  /** Model to use (default: voxtral-mini-transcribe-realtime-2602) */
  model?: string;
  /** Silence duration in ms before flushing and emitting a transcript (default: 800) */
  silenceDurationMs?: number;
  /** target_streaming_delay_ms passed to the Mistral session (default: 240) */
  targetStreamingDelayMs?: number;
}

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

/**
 * Provider factory for Mistral Realtime STT sessions.
 */
export class MistralRealtimeSTTProvider implements RealtimeSTTProvider {
  readonly name = "mistral-realtime";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly silenceDurationMs: number;
  private readonly targetStreamingDelayMs: number;

  constructor(config: MistralRealtimeSTTConfig) {
    if (!config.apiKey) {
      throw new Error("Mistral API key required for Realtime STT");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl?.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.silenceDurationMs = config.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS;
    this.targetStreamingDelayMs =
      config.targetStreamingDelayMs ?? DEFAULT_TARGET_STREAMING_DELAY_MS;
  }

  createSession(): RealtimeSTTSession {
    return new MistralRealtimeSTTSession(
      this.apiKey,
      this.baseUrl,
      this.model,
      this.silenceDurationMs,
      this.targetStreamingDelayMs,
    );
  }
}

/**
 * WebSocket-based session for Mistral real-time speech-to-text.
 *
 * Audio flow:
 *   Twilio mu-law 8kHz → mulawToPcm() → PCM S16LE 8kHz → base64 → input_audio.append
 *
 * Turn detection:
 *   No server-side VAD. A silence timer is reset on every sendAudio() call.
 *   When it fires, an input_audio.flush is sent to the server. The server
 *   responds with transcription.done containing the full utterance text.
 */
class MistralRealtimeSTTSession implements RealtimeSTTSession {
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly RECONNECT_DELAY_MS = 1000;
  /** Minimum RMS energy to treat a PCM chunk as speech rather than silence/background. */
  private static readonly SPEECH_ENERGY_THRESHOLD = 300;

  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingTranscript = "";
  private speechStarted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;

  private onTranscriptCallback: ((transcript: string) => void) | null = null;
  private onPartialCallback: ((partial: string) => void) | null = null;
  private onSpeechStartCallback: (() => void) | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly silenceDurationMs: number,
    private readonly targetStreamingDelayMs: number,
  ) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = buildWsUrl(this.baseUrl, this.model);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      this.ws.on("open", () => {
        console.log("[MistralSTT] WebSocket connected");
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
            target_streaming_delay_ms: this.targetStreamingDelayMs,
          },
        });

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as {
            type: string;
            text?: string;
            error?: unknown;
          };
          this.handleEvent(event);
        } catch (e) {
          console.error("[MistralSTT] Failed to parse event:", e);
        }
      });

      this.ws.on("error", (error) => {
        console.error("[MistralSTT] WebSocket error:", error);
        if (!this.connected) {
          reject(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        const reasonText = reason?.toString() || "none";
        console.log(`[MistralSTT] WebSocket closed (code: ${code}, reason: ${reasonText})`);
        this.connected = false;
        // Clear in-flight speech state so a reconnected session starts clean.
        // Any partial transcript accumulated before the drop is unrecoverable.
        this.resetSpeechState();

        if (!this.closed) {
          void this.attemptReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Mistral Realtime STT connection timeout"));
        }
      }, 10000);
    });
  }

  private async attemptReconnect(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.reconnectAttempts >= MistralRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS) {
      console.error(
        `[MistralSTT] Max reconnect attempts (${MistralRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS}) reached`,
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = MistralRealtimeSTTSession.RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempts - 1);
    console.log(
      `[MistralSTT] Reconnecting ${this.reconnectAttempts}/${MistralRealtimeSTTSession.MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.closed) {
      return;
    }

    try {
      await this.doConnect();
      console.log("[MistralSTT] Reconnected successfully");
    } catch (error) {
      console.error("[MistralSTT] Reconnect failed:", error);
    }
  }

  private handleEvent(event: { type: string; text?: string; error?: unknown }): void {
    switch (event.type) {
      case "session.created":
      case "session.updated":
        console.log(`[MistralSTT] ${event.type}`);
        break;

      case "transcription.text.delta":
        if (event.text) {
          // First delta signals that speech is being transcribed
          if (!this.speechStarted) {
            this.speechStarted = true;
            this.onSpeechStartCallback?.();
          }
          this.pendingTranscript += event.text;
          this.onPartialCallback?.(this.pendingTranscript);
        }
        break;

      case "transcription.done":
        // Full utterance text from the server (after input_audio.flush)
        if (event.text) {
          console.log(`[MistralSTT] Transcript: ${event.text}`);
          this.onTranscriptCallback?.(event.text);
        }
        this.pendingTranscript = "";
        this.speechStarted = false;
        break;

      case "error": {
        const err = event.error as Record<string, unknown> | null | undefined;
        const msg = typeof err?.message === "string" ? err.message : JSON.stringify(event.error);
        const code = err?.code != null ? ` (code: ${err.code})` : "";
        console.error(`[MistralSTT] Server error${code}: ${msg}`);
        break;
      }
    }
  }

  private sendEvent(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  sendAudio(muLawData: Buffer): void {
    if (!this.connected) {
      return;
    }
    // Mistral expects PCM S16LE; Twilio sends mu-law 8kHz
    const pcm = mulawToPcm(muLawData);
    this.sendEvent({
      type: "input_audio.append",
      audio: pcm.toString("base64"),
    });
    // Twilio sends audio continuously (including background silence between turns),
    // so resetting the silence timer on every chunk would prevent it from ever
    // firing. Only reset when the chunk contains actual speech energy.
    if (this.hasSpeechEnergy(pcm)) {
      this.resetSilenceTimer();
    }
  }

  /**
   * Returns true when the PCM chunk has RMS energy above the speech threshold.
   * Mu-law decoded silence is very close to 0; speech on a typical phone call
   * is well above 300 RMS.
   */
  private hasSpeechEnergy(pcm: Buffer): boolean {
    const samples = Math.floor(pcm.length / 2);
    if (samples === 0) {
      return false;
    }
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const s = pcm.readInt16LE(i * 2);
      sumSq += s * s;
    }
    return Math.sqrt(sumSq / samples) >= MistralRealtimeSTTSession.SPEECH_ENERGY_THRESHOLD;
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.flushAudio();
    }, this.silenceDurationMs);
  }

  /**
   * Flush the audio buffer, prompting Mistral to finalize the current utterance.
   * The server will respond with a transcription.done event.
   */
  private flushAudio(): void {
    this.sendEvent({ type: "input_audio.flush" });
  }

  /**
   * Clear in-flight speech state. Called when the WebSocket drops so that a
   * reconnected session does not inherit stale transcript/timer state.
   */
  private resetSpeechState(): void {
    this.speechStarted = false;
    this.pendingTranscript = "";
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  onPartial(callback: (partial: string) => void): void {
    this.onPartialCallback = callback;
  }

  onTranscript(callback: (transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onSpeechStart(callback: () => void): void {
    this.onSpeechStartCallback = callback;
  }

  async waitForTranscript(timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.onTranscriptCallback = null;
        reject(new Error("Transcript timeout"));
      }, timeoutMs);

      this.onTranscriptCallback = (transcript) => {
        clearTimeout(timeout);
        this.onTranscriptCallback = null;
        resolve(transcript);
      };
    });
  }

  close(): void {
    this.closed = true;
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
