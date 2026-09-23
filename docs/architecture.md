# Design decisions

## Why separate writing from speaking?

The voice model should have a small, unambiguous script. It should not invent the topic, translate while speaking, or remember an entire episode. The normal text model has the full ledger, generates coherent new content, and produces both language versions together. Short sentence/translation pairs limit the learner's working-memory load; proficiency level influences wording.

The writer's structured output is intentionally not rendered. Only observed output transcription becomes visible, paced by the audio clock. This gives an honest failure mode if the narrator omits or changes words.

## Continuity without an infinite-memory claim

The full ledger is carried as model/user history, with fixed podcast instructions in the system prompt. No rolling summary replaces it. Exact/near-duplicate gates complement model reasoning. Explicit language fields and a conservative local detector catch obvious reversals. Each prefetched voice passage remains private until it passes its own transcript checks. Token counting stops the run with an explicit `context-full` event.

This retains all history in the request; it cannot guarantee perfect semantic recall or eliminate every loop. A later version could add an embedding-based fact ledger for additional semantic duplicate detection, while retaining the full original history as requested.

## Latency and cost

Fresh Live connections give strong isolation and allow a complete script in the system prompt, as MaestroTutor does. Two concurrent readers hide connection overhead while preserving script order. The writer has a separate single-entry queue. A 45-second production threshold plus at most two in-flight passages bounds audio lookahead; pause prevents starting further work.

The writer benchmark favored Flash-Lite 2.5: a full four-pair batch completed in 1.7 seconds versus 35.6 seconds for 3.5. Partial JSON admission would save little on that measured 2.5 response and add another validation boundary. The complete plan is therefore validated before narration.

Live's `generationComplete` closes each reader promptly. Waiting for `turnComplete` unnecessarily held the next passage behind the provider's assumed playback clock. The API guarantees the final output transcript precedes generation completion. Actual cues are still anchored to the received PCM cursor, with no final-duration normalization.

Controlled reproduction found language-code markers could cause missing transcript spans even when repeated renders produced audio of similar duration. The normal prompt uses plain bilingual sentences and explicitly requests complete original-language transcription. A short opening pair limits startup checking time. Subsequent turns contain at most two pairs; no line quota is sent to Live. Every turn is checked before publication, with bounded private retries and a marked-script fallback. Failed attempts remain recorded but never reach the listener. This adds initial waiting time in exchange for preventing incomplete passages from becoming visible or audible.

The browser schedules all accepted PCM contiguously and gradually reveals the actual words against its audible output clock. Diagnostics use a read-only buffer calculation so they cannot accidentally advance captions. Background planning and natural breaths do not toggle loading indicators; follow-scrolling uses a small per-frame step and yields to manual scrolling.

Long full-context sessions incur increasing input costs. Explicit prompt caching could reduce this for suitably sized stable prefixes, but cache resources are project-specific and interact with key failover. This version uses ordinary requests, exposes cumulative usage, and does not promise cache savings.

## References inspected on 2026-09-23

- [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS), npm 2.1.1 (MPL-2.0): unmodified worklet base/core and Lanczos interpolation strategy. Web Audio source playback rate changes duration; the worklet compensates the pitch shift. Original PCM and transcript sample coordinates remain unchanged. A continuous silent input keeps the processor warm and flushes its tail; inserted buffering frames are measured for the audible caption clock.
- MaestroTutor's `src/core/config/prompts.ts`, `VOICE_TAG_PERSONA_GUIDELINES`: audible-only inline directions, placement before a phrase for delivery or after it for a reaction, sparse use, and examples. Radio's non-Live writer supplies these tags only when requested; Live is explicitly told to perform them without speaking their names. Known tags are stripped from actual output captions and expected-word coverage. The raw transcript remains archived.

- [MaestroTutor](https://github.com/RONITERVO/MaestroTutor), local checkout commit `36d338243411656f7f085eaeaed172253ef3d780`: `src/core-sdk/media/triggeredTts.ts`, `src/features/speech/services/geminiLiveTts.ts`, `public/gemini-models.json`. The voice instruction is adapted from its Apache-2.0 prompt. Actual words are matched forward to locate target/native rows; the plan is never used as substitute captions.
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
