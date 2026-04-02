import { describe, expect, it, vi } from "vitest";
import { pcmToMulaw } from "../telephony-audio.js";
import type { MistralRealtimeSTTConfig } from "./stt-mistral-realtime.js";
import { MistralRealtimeSTTProvider } from "./stt-mistral-realtime.js";

type ProviderInternals = {
  model: string;
  silenceDurationMs: number;
  targetStreamingDelayMs: number;
  baseUrl: string;
};

function readProviderInternals(config: MistralRealtimeSTTConfig): ProviderInternals {
  const provider = new MistralRealtimeSTTProvider(config) as unknown as Record<string, unknown>;
  return {
    model: provider["model"] as string,
    silenceDurationMs: provider["silenceDurationMs"] as number,
    targetStreamingDelayMs: provider["targetStreamingDelayMs"] as number,
    baseUrl: provider["baseUrl"] as string,
  };
}

describe("MistralRealtimeSTTProvider constructor defaults", () => {
  it("uses the default Mistral model when none is provided", () => {
    const provider = readProviderInternals({ apiKey: "mk-test" }); // pragma: allowlist secret
    expect(provider.model).toBe("voxtral-mini-transcribe-realtime-2602");
  });

  it("uses the configured model when provided", () => {
    const provider = readProviderInternals({
      apiKey: "mk-test", // pragma: allowlist secret
      model: "voxtral-mini-transcribe-realtime-2602",
    });
    expect(provider.model).toBe("voxtral-mini-transcribe-realtime-2602");
  });

  it("uses the default silenceDurationMs when not configured", () => {
    const provider = readProviderInternals({ apiKey: "mk-test" }); // pragma: allowlist secret
    expect(provider.silenceDurationMs).toBe(800);
  });

  it("uses silenceDurationMs: 0 when explicitly configured", () => {
    const provider = readProviderInternals({
      apiKey: "mk-test", // pragma: allowlist secret
      silenceDurationMs: 0,
    });
    expect(provider.silenceDurationMs).toBe(0);
  });

  it("uses the default targetStreamingDelayMs when not configured", () => {
    const provider = readProviderInternals({ apiKey: "mk-test" }); // pragma: allowlist secret
    expect(provider.targetStreamingDelayMs).toBe(240);
  });

  it("uses the default base URL when not configured", () => {
    const provider = readProviderInternals({ apiKey: "mk-test" }); // pragma: allowlist secret
    expect(provider.baseUrl).toBe("https://api.mistral.ai/v1");
  });

  it("normalizes trailing slashes from baseUrl", () => {
    const provider = readProviderInternals({
      apiKey: "mk-test", // pragma: allowlist secret
      baseUrl: "https://api.mistral.ai/v1///",
    });
    expect(provider.baseUrl).toBe("https://api.mistral.ai/v1");
  });

  it("throws when no API key is provided", () => {
    expect(() => new MistralRealtimeSTTProvider({ apiKey: "" })).toThrow(
      "Mistral API key required",
    );
  });

  it("createSession returns a session with the expected interface", () => {
    const provider = new MistralRealtimeSTTProvider({ apiKey: "mk-test" }); // pragma: allowlist secret
    const session = provider.createSession();
    expect(typeof session.connect).toBe("function");
    expect(typeof session.sendAudio).toBe("function");
    expect(typeof session.onTranscript).toBe("function");
    expect(typeof session.onPartial).toBe("function");
    expect(typeof session.onSpeechStart).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(typeof session.isConnected).toBe("function");
    expect(session.isConnected()).toBe(false);
  });
});

describe("MistralRealtimeSTTSession silence detection", () => {
  function makeSession() {
    const provider = new MistralRealtimeSTTProvider({ apiKey: "mk-test" }); // pragma: allowlist secret
    const session = provider.createSession() as unknown as Record<string, unknown>;
    // Stub the WebSocket send so sendAudio does not throw when disconnected
    session["sendEvent"] = vi.fn();
    session["connected"] = true;
    return session;
  }

  function makePcmBuf(rms: number, samples = 160): Buffer {
    // Build a s16le buffer whose RMS equals the requested value
    const amplitude = Math.round(rms * Math.sqrt(2));
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const v = i % 2 === 0 ? amplitude : -amplitude;
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
    }
    return buf;
  }

  it("resets the silence timer on a high-energy (speech) chunk", () => {
    const session = makeSession();
    const resetSpy = vi.spyOn(session as never, "resetSilenceTimer");
    const speechPcm = makePcmBuf(1000);
    const mulawBuf = pcmToMulaw(speechPcm);
    (session as { sendAudio: (b: Buffer) => void }).sendAudio(mulawBuf);
    expect(resetSpy).toHaveBeenCalledOnce();
  });

  it("does not reset the silence timer on a low-energy (silence) chunk", () => {
    const session = makeSession();
    const resetSpy = vi.spyOn(session as never, "resetSilenceTimer");
    const silencePcm = makePcmBuf(10); // well below 300 threshold
    const mulawBuf = pcmToMulaw(silencePcm);
    (session as { sendAudio: (b: Buffer) => void }).sendAudio(mulawBuf);
    expect(resetSpy).not.toHaveBeenCalled();
  });
});
