---
summary: "Use Mistral models plus Voxtral speech with OpenClaw"
read_when:
  - You want to use Mistral models in OpenClaw
  - You need Mistral API key onboarding and model refs
  - You want Voxtral transcription or text-to-speech
title: "Mistral"
---

# Mistral

OpenClaw supports Mistral for text/image model routing (`mistral/...`), audio
transcription via Voxtral in media understanding, and Voxtral text-to-speech.
Mistral can also be used for memory embeddings (`memorySearch.provider = "mistral"`).

## CLI setup

```bash
openclaw onboard --auth-choice mistral-api-key
# or non-interactive
openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## Config snippet (LLM provider)

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
}
```

## Built-in LLM catalog

OpenClaw currently ships this bundled Mistral catalog:

| Model ref                        | Input       | Context | Max output | Notes                                                            |
| -------------------------------- | ----------- | ------- | ---------- | ---------------------------------------------------------------- |
| `mistral/mistral-large-latest`   | text, image | 262,144 | 16,384     | Default model                                                    |
| `mistral/mistral-medium-2508`    | text, image | 262,144 | 8,192      | Mistral Medium 3.1                                               |
| `mistral/mistral-small-latest`   | text, image | 128,000 | 16,384     | Mistral Small 4; adjustable reasoning via API `reasoning_effort` |
| `mistral/pixtral-large-latest`   | text, image | 128,000 | 32,768     | Pixtral                                                          |
| `mistral/codestral-latest`       | text        | 256,000 | 4,096      | Coding                                                           |
| `mistral/devstral-medium-latest` | text        | 262,144 | 32,768     | Devstral 2                                                       |
| `mistral/magistral-small`        | text        | 128,000 | 40,000     | Reasoning-enabled                                                |

## Config snippet (audio transcription with Voxtral)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## Adjustable reasoning (`mistral-small-latest`)

`mistral/mistral-small-latest` maps to Mistral Small 4 and supports [adjustable reasoning](https://docs.mistral.ai/capabilities/reasoning/adjustable) on the Chat Completions API via `reasoning_effort` (`none` minimizes extra thinking in the output; `high` surfaces full thinking traces before the final answer).

OpenClaw maps the session **thinking** level to Mistral’s API:

- **off** / **minimal** → `none`
- **low** / **medium** / **high** / **xhigh** / **adaptive** → `high`

Other bundled Mistral catalog models do not use this parameter; keep using `magistral-*` models when you want Mistral’s native reasoning-first behavior.

## Config snippet (text-to-speech with Voxtral)

See the [Voxtral TTS documentation](https://docs.mistral.ai/capabilities/audio/text_to_speech) for available models and voices.

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "mistral",
      providers: {
        mistral: {
          voice: "gb_oliver_excited",
          model: "voxtral-mini-tts-2603",
          apiKey: "mistral_api_key",
          baseUrl: "https://api.mistral.ai/v1",
        },
      },
    },
  },
}
```

## Notes

- Mistral auth uses `MISTRAL_API_KEY` for models, Voxtral transcription, and Voxtral TTS.
- `openclaw onboard --auth-choice mistral-api-key` makes the same key available to Mistral TTS. Set `messages.tts.provider` to `"mistral"` or use `/tts provider mistral`; no separate TTS API key is required.
- Provider base URL defaults to `https://api.mistral.ai/v1`.
- Onboarding default model is `mistral/mistral-large-latest`.
- Media-understanding default audio model for Mistral is `voxtral-mini-latest`.
- Media transcription path uses `/v1/audio/transcriptions`.
- TTS path uses `/v1/audio/speech`.
- Memory embeddings path uses `/v1/embeddings` (default model: `mistral-embed`).
