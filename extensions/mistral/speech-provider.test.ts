import * as providerAuthRuntime from "openclaw/plugin-sdk/provider-auth-runtime";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMistralSpeechProvider } from "./speech-provider.js";

describe("mistral speech provider", () => {
  const originalFetch = globalThis.fetch;
  const provider = buildMistralSpeechProvider();

  function buildSynthesisRequest(
    overrides: Partial<SpeechSynthesisRequest> = {},
  ): SpeechSynthesisRequest {
    return {
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
      ...overrides,
    };
  }

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

  it("does not treat auth.order alone as TTS-ready", () => {
    expect(
      provider.isConfigured({
        cfg: {
          auth: {
            order: {
              mistral: ["mistral:default"],
            },
          },
        } as never,
        providerConfig: {},
        timeoutMs: 5000,
      }),
    ).toBe(false);
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

  it("prefers provider auth resolution over the raw env fallback", async () => {
    const audio = Buffer.from("fake-opus-audio");
    process.env.MISTRAL_API_KEY = "env-mistral-key";
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
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
        Authorization: "Bearer resolved-profile-key",
      });
      return new Response(JSON.stringify({ audio_data: audio.toString("base64") }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider.synthesize(buildSynthesisRequest());

    expect(result.audioBuffer.equals(audio)).toBe(true);
    expect(result.outputFormat).toBe("opus");
    expect(result.fileExtension).toBe(".opus");
    expect(result.voiceCompatible).toBe(true);
  });

  it("surfaces Mistral API error details from non-2xx responses", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "bad credentials",
            type: "invalid_request",
            code: "bad_auth",
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;

    await expect(provider.synthesize(buildSynthesisRequest())).rejects.toThrow(
      "Mistral TTS API error (401): bad credentials [type=invalid_request, code=bad_auth]",
    );
  });

  it("throws when Voxtral omits audio_data from the response envelope", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "resolved-profile-key",
      source: "profile:mistral:default",
      mode: "api-key",
      profileId: "mistral:default",
    });
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ id: "tts_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(provider.synthesize(buildSynthesisRequest())).rejects.toThrow(
      "Mistral TTS response missing audio_data",
    );
  });

  it("throws when no Mistral API key can be resolved", async () => {
    vi.spyOn(providerAuthRuntime, "resolveApiKeyForProvider").mockResolvedValue({
      source: "env: MISTRAL_API_KEY",
      mode: "api-key",
    });

    await expect(
      provider.synthesize(
        buildSynthesisRequest({
          cfg: {} as never,
        }),
      ),
    ).rejects.toThrow('No API key resolved for provider "mistral" (auth mode: api-key).');
  });
});
