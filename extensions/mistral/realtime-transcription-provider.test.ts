import { describe, expect, it, vi } from "vitest";
import { buildMistralRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

describe("buildMistralRealtimeTranscriptionProvider", () => {
  it("normalizes Mistral config defaults", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          mistral: {
            apiKey: "mk-test", // pragma: allowlist secret
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "mk-test",
    });
  });

  it("keeps provider-owned transcription settings configurable via raw provider config", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          mistral: {
            model: "voxtral-mini-transcribe-realtime-2602",
            silenceDurationMs: 600,
            targetStreamingDelayMs: 300,
            baseUrl: "https://custom.mistral.ai/v1",
          },
        },
      },
    });

    expect(resolved).toEqual({
      model: "voxtral-mini-transcribe-realtime-2602",
      silenceDurationMs: 600,
      targetStreamingDelayMs: 300,
      baseUrl: "https://custom.mistral.ai/v1",
    });
  });

  it("accepts the legacy mistral-realtime alias", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("mistral-realtime");
  });

  it("reads apiKey from the legacy mistralApiKey path", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        mistralApiKey: "mk-legacy", // pragma: allowlist secret
      },
    });

    expect(resolved).toEqual({
      apiKey: "mk-legacy",
    });
  });

  it("reads model from the legacy mistralSttModel path", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        mistralSttModel: "voxtral-custom",
      },
    });

    expect(resolved).toEqual({
      model: "voxtral-custom",
    });
  });

  it("isConfigured returns true when provider config has apiKey", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    expect(
      provider.isConfigured({
        providerConfig: {
          providers: { mistral: { apiKey: "mk-test" } }, // pragma: allowlist secret
        },
      }),
    ).toBe(true);
  });

  it("isConfigured returns true when MISTRAL_API_KEY env is set", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const original = process.env.MISTRAL_API_KEY;
    try {
      process.env.MISTRAL_API_KEY = "mk-env"; // pragma: allowlist secret
      expect(provider.isConfigured({ providerConfig: {} })).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.MISTRAL_API_KEY;
      } else {
        process.env.MISTRAL_API_KEY = original;
      }
    }
  });

  it("isConfigured returns false when no key is available", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const original = process.env.MISTRAL_API_KEY;
    try {
      delete process.env.MISTRAL_API_KEY;
      expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env.MISTRAL_API_KEY = original;
      }
    }
  });

  it("createSession throws when no API key is provided", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const original = process.env.MISTRAL_API_KEY;
    try {
      delete process.env.MISTRAL_API_KEY;
      expect(() => provider.createSession({ providerConfig: {} })).toThrow(
        "Mistral API key missing",
      );
    } finally {
      if (original !== undefined) {
        process.env.MISTRAL_API_KEY = original;
      }
    }
  });

  it("createSession returns a session with the expected interface", () => {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        providers: { mistral: { apiKey: "mk-test" } }, // pragma: allowlist secret
      },
    });
    expect(typeof session.connect).toBe("function");
    expect(typeof session.sendAudio).toBe("function");
    expect(typeof session.close).toBe("function");
    expect(typeof session.isConnected).toBe("function");
    expect(session.isConnected()).toBe(false);
  });
});

describe("MistralRealtimeTranscriptionSession silence detection", () => {
  function makeSession() {
    const provider = buildMistralRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        providers: { mistral: { apiKey: "mk-test" } }, // pragma: allowlist secret
      },
    }) as unknown as Record<string, unknown>;
    // Stub WebSocket send so sendAudio works without a real connection
    session["sendEvent"] = vi.fn();
    session["connected"] = true;
    // Mock the ws property with correct readyState so sendAudio doesn't bail out
    session["ws"] = { readyState: 1 /* WebSocket.OPEN */ };
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

  /** Convert PCM S16LE to mu-law (the format Twilio sends). */
  function pcmToMulaw(pcm: Buffer): Buffer {
    const samples = Math.floor(pcm.length / 2);
    const mulaw = Buffer.alloc(samples);
    for (let i = 0; i < samples; i++) {
      mulaw[i] = linearToMulaw(pcm.readInt16LE(i * 2));
    }
    return mulaw;
  }

  function linearToMulaw(sample: number): number {
    const BIAS = 132;
    const CLIP = 32635;
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--) {
      expMask >>= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
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
