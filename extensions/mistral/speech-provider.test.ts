import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMistralSpeechProvider } from "./speech-provider.js";

describe("mistral speech provider", () => {
  const originalFetch = globalThis.fetch;
  const provider = buildMistralSpeechProvider();

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.MISTRAL_API_KEY;
    delete process.env.MISTRAL_TTS_BASE_URL;
  });

  it("treats configured Mistral auth profiles as TTS-ready", () => {
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            profiles: {
              "mistral:default": {
                provider: "mistral",
                mode: "api_key",
              },
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(true);
  });

  it("reuses the Mistral model provider baseUrl when no TTS override is configured", () => {
    const providerConfig = provider.resolveConfig?.({
      cfg: {
        models: {
          providers: {
            mistral: {
              baseUrl: "https://custom.mistral.example/v1",
            },
          },
        },
      } as never,
      rawConfig: {},
      timeoutMs: 5000,
    });

    expect(providerConfig).toMatchObject({
      baseUrl: "https://custom.mistral.example/v1",
      model: "voxtral-mini-tts-2603",
    });
  });

  it("falls back to provider auth when no explicit TTS API key is configured", async () => {
    const audio = Buffer.from("fake-opus-audio");
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-mistral-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("voxtral-mini-tts-2603");
      expect(body.voice_id).toBeUndefined();
      expect(body.response_format).toBe("opus");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer resolved-mistral-key",
      });
      return new Response(JSON.stringify({ audio_data: audio.toString("base64") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize({
      text: "hello",
      cfg: {
        auth: {
          profiles: {
            "mistral:default": {
              provider: "mistral",
              mode: "api_key",
            },
          },
        },
      } as never,
      providerConfig: {
        baseUrl: "https://api.mistral.ai/v1",
        model: "voxtral-mini-tts-2603",
        voice: "",
      },
      target: "voice-note",
      timeoutMs: 5000,
    });

    expect(result.audioBuffer.equals(audio)).toBe(true);
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
  });
});
