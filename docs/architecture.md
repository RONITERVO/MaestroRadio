# Design decisions

## Why separate writing from speaking?

The voice model should have a small, unambiguous script. It should not invent the topic, translate while speaking, or remember an entire episode. The normal text model has the full ledger, generates coherent new content, and produces both language versions together. Short sentence/translation pairs limit the learner's working-memory load; proficiency level influences wording.

The writer's structured output is intentionally not rendered. Only observed output transcription becomes visible, paced by the audio clock. This gives an honest failure mode if the narrator omits or changes words.

## Continuity without an infinite-memory claim

The full ledger is carried as model/user history, with fixed podcast instructions in the system prompt. No rolling summary replaces it. Exact/near-duplicate gates complement model reasoning. The bounded prefetch is provisional until the current voice passage passes its transcript checks. Token counting stops the run with an explicit `context-full` event.

This retains all history in the request; it cannot guarantee perfect semantic recall or eliminate every loop. A later version could add an embedding-based fact ledger for additional semantic duplicate detection, while retaining the full original history as requested.

## Latency and cost

Fresh Live connections give strong isolation and allow a complete script in the system prompt, as MaestroTutor does. They add connection overhead. A single persistent connection would be cheaper to open, but would need client-content script updates, change the established TTS behavior, and eventually require resumption/compression. The current implementation chooses short independent narration turns with bounded lookahead.

The initial tests show writer latency dominates startup. The next useful optimization is a streaming writer that admits a validated first bilingual pair before the entire structured batch finishes. That requires careful partial-JSON admission and voice grouping; it is not simulated by showing unspoken planner output.

Long full-context sessions incur increasing input costs. Explicit prompt caching could reduce this for suitably sized stable prefixes, but cache resources are project-specific and interact with key failover. This version uses ordinary requests, exposes cumulative usage, and does not promise cache savings.

## References inspected on 2026-09-23

- [MaestroTutor](https://github.com/RONITERVO/MaestroTutor), local checkout commit `36d338243411656f7f085eaeaed172253ef3d780`: `src/core-sdk/media/triggeredTts.ts`, `src/features/speech/services/geminiLiveTts.ts`, `public/gemini-models.json`. The voice instruction is adapted from its Apache-2.0 prompt. The language markers are silent metadata; the app falls back to forward text matching for line boundaries when output transcription omits them.
- [Spanish Quick Apps](https://github.com/RONITERVO/Spanish-Quick-Apps), local checkout commit `21a6ff75df64412c269489f177e8ddbad837c044`: `learning-narration.js` and `docs/syncvoice-production.md`. Used the audio-clock-driven character-reveal principle.
- Local SyncVoice: `lib/client/gemini-tts.ts`, `agent/gemini-tts.mjs`, and `app/tts-studio.tsx`. Used observed sample positions, without a final-duration normalization pass or scripted-caption fallback.
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): published 1,048,576 input-token limit, structured output, caching, text-only output.
- [Live capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities): 24 kHz mono PCM output, outputAudioTranscription, processing all content parts, supported model-specific thinking configuration.
- [Live API reference](https://ai.google.dev/api/live): transcription fields and server turn completion.
- [Token counting REST API](https://ai.google.dev/api/tokens): complete `generateContentRequest` counting, including system instructions.
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): quotas apply to projects, not individual API keys.
- [Current model catalog](https://ai.google.dev/gemini-api/docs/models): the configured newer alternative `gemini-3.8-live`; the default retains the reference app's narrator.

## Scope

Implemented: real provider backend, multi-key BYOK and env files, validated planning, full context accounting, bounded lookahead, actual transcription only, PCM streaming, pause/end, private archives, testable timing, simple responsive void UI.

Not implemented: microphone conversation, publishing/hosting, accounts, cross-device sessions, automatic crash recovery, explicit cache resource management, independent forced alignment, arbitrary provider APIs, or offline narration. BYOK here means multiple Gemini keys; writer and Live model IDs are configurable within Gemini's APIs.
