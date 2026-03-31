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

## Config snippet (text-to-speech with Voxtral)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "mistral",
      providers: {
        mistral: {
          model: "voxtral-mini-tts-2603",
          voice: "your-voice-id",
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
- TTS default model for Mistral is `voxtral-mini-tts-2603`.
- Media transcription path uses `/v1/audio/transcriptions`.
- TTS path uses `/v1/audio/speech`.
- Memory embeddings path uses `/v1/embeddings` (default model: `mistral-embed`).
