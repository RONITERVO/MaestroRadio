# Verification — 2026-09-23

## Playback speed, storytelling style and vocal directions

TypeScript check, production build and **38 tests** pass; the production dependency audit reports zero vulnerabilities. Added regressions cover source-sample mapping across speed changes, changing speed while paused, retaining the same wall-clock production reserve at 2×, split vocal tags in actual transcripts, repetition checks that ignore delivery tags, and fresh story events under a recurring title.

Browser rendering of a 440 Hz reference tone through the real SoundTouch worklet preserved **440 Hz at 1×, 1.5× and 2×**. A two-second source tone lasted approximately 2.00, 1.33 and 0.99 seconds respectively. The processor measured 99–141 ms of buffering delay, which is subtracted from the caption clock. These measurements establish pitch/duration behavior; they are not a subjective assessment of voice quality.

A production-browser replay of the existing Spanish/Finnish archive `5d51036e-ecb7-4d5d-9b94-059a44c5e170` played all **334.04 source seconds / 15 turns**, with **zero scheduling underruns, zero gap milliseconds and zero stream errors**. The run changed 1× → 2×, paused, changed to 1.5× while paused, then resumed to completion. A three-second sample at 2× advanced the audible source clock at **2.003×** wall time. Captions stayed frozen during pause and after completion. A separate rapid-change check exercised 2× → 1.25× → 1.75× → 1× and End without errors. Mobile setup and transport checks at 390 × 844 had no horizontal overflow. Replay uses recorded PCM and actual captions; it does not test live provider throughput.

The Flash-Lite 2.5 writer produced a requested second-person comic folk tale with matching Spanish/English vocal directions. This exposed an overstrict repetition check: several fresh passages reused the whole story/style as their angle. An angle-only repeat no longer rejects fresh events; repeated facts and exact/near-identical spoken sentences remain rejected.

A finite Live A/B reused the writer's `[curious]` fox sentence and English translation. Both versions had **100% per-line transcript coverage**. Neutral generated 11.60 seconds of audio in 8.883 seconds; expressive generated 11.48 seconds in 7.348 seconds. The expressive output transcript included bracketed metadata, which the caption adapter removes. Local audio and raw evidence are in `test-results/voice-experiment-1790178526307/`. Requests are stochastic, and transcript coverage alone cannot establish perceived emotion or independently prove what the waveform contains; the two WAVs are provided for listening.

Earlier live story attempts encountered a missing native-language transcript (caught before publication) and writer quota failures. A later browser story accepted two voice turns with full coverage before hitting quota. The final three-batch, expressive 2× soak (`cd0cc18c-7ac9-4d84-b5c0-ed1a61a2d8e3`) stopped at the writer quota with no audio. **Sustained live generation at 2× is therefore unverified on this account.** The speed-aware reserve, player replay and separate tagged Live request passed; those do not remove this provider limitation.

## Continuity refinement

TypeScript check, production build, **32 tests**, and the production dependency audit pass (zero reported vulnerabilities). New tests exercise ordered concurrent readers, discarded private attempts, bounded queues, language reversal, generation completion, output-clock diagnostics, and an observed 31-second delivery stall.

A fixed-prompt writer benchmark measured Flash-Lite 2.5 at 728 ms to first text / 1,718 ms total, versus 3.5 at 34,637 ms / 35,590 ms. These are single requests on this account, not population-level latency statistics. The default is now 2.5, with thinking disabled.

The real-time soak runner acknowledges only elapsed playback, uses the browser's actual scheduling algorithm, and saves every packet arrival. Successful plain-text voice runs:

| Languages | Writer batches / voice turns | Audio | First scheduled playback | Underruns | Transcript coverage | Silence at joins |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Spanish → English, bakery | 6 / 13 | 240.04 s | 6.49 s | 0 | 100% each turn | 180–340 ms |
| Spanish → Finnish, tree water transport | 4 / 9 | 216.96 s | 10.31 s | 0 | 100% each turn | 220–300 ms |
| Spanish → English, star navigation | 1 / 3 | 40.68 s | 9.82 s | 0 | 100% each turn | 300–320 ms |

Evidence archive IDs: `7d3afccf-16e9-4eb9-977f-f0fc369224a6`, `bf13160c-aafa-4cd6-9869-6f0a61a474e1`, and `72dd7d52-ec09-4c27-aa7a-83a6259c82de`, under ignored `test-results/soak/`. The first run preceded the final change to two single-pair opening turns. The first two used a 30-second production threshold; the release increases it to 45 seconds after a separate browser run encountered a 31-second generation delay. The 0.4-second browser scheduling lead is separate from this background reserve.

These successes followed failures, rather than being the only samples attempted. Earlier versions exposed missing language transcripts, reversed writer fields, and opening or midstream gaps. Language-code markers repeatedly lost the same Spanish span in a controlled reproduction; removing markers recovered the full transcript. The implementation now uses plain bilingual sentences, validates every turn before publication, and allows bounded private regeneration. Waiting for `generationComplete` instead of `turnComplete` removed the provider's simulated-playback wait. Two short opening turns avoid putting a long second generation behind a short first sentence.

Waveform silence estimates use 20 ms RMS windows with an amplitude threshold of 90 on signed 16-bit PCM. They distinguish normal short breaths at joins from scheduling underruns, but do not measure subjective prosody or independently verify spoken words. Soak audio duration includes queued audio after generation finishes; the browser checks exercise physical AudioContext scheduling separately.

Browser checks also confirmed alternating Spanish/Finnish rows, one text node per row, stable manual scroll position, and transcript freezing during pause. Per-episode archives now save the browser's final reported playback diagnostics for future reproduction.

The final production-browser run used the released 45-second threshold and both short opening turns. It played **301.55 seconds** of Spanish/Finnish audio, accepted **15 voice turns at 100% transcript coverage**, and recorded **zero underruns, zero gap milliseconds, and zero stream errors**. Pause/resume and End kept text stable when stopped. An active-window sample recorded 132 animation frames in 2.2 seconds (maximum interval 17 ms); the earlier background-window measurement was throttled and is not a foreground animation benchmark. There was no horizontal overflow. The persisted episode archive is `data/5d51036e-ecb7-4d5d-9b94-059a44c5e170/`.

That final run also demonstrates the remaining startup limit: first audio reached the browser at **15.98 seconds**, scheduled at **16.4 seconds**, after a 12-second first voice generation. Other successful runs scheduled playback in 6.49–10.31 seconds. Startup is measured separately from uninterrupted playback and is not described as instantaneous.

Initial waiting time still varies with provider latency and validation. These changes target continuous playback after startup; they cannot guarantee immediate startup, prevent provider outages, or prove coherence through a million-token episode.

## Initial release baseline

## Automated

TypeScript check, Vite production build, and all **20 backend/player/server tests** passed. The final production dependency audit reported zero known vulnerabilities. Tests cover real behavior boundaries rather than snapshotting implementation text, including a real server/WebSocket origin and validation test.

## Live Gemini checks

The existing local SyncVoice Gemini key file was used without logging credentials. Both passes used `gemini-3.5-flash-lite` and `gemini-2.5-flash-native-audio-preview-12-2025`, Kore voice, Spanish → English, B1.

| Run | Turns | Generated audio | First audio | Total generation | Transcript coverage |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial sequential baseline | 2 | 48.76 s | 18.97 s | 86.97 s | 100% in both turns |
| One-passage writer lookahead | 2 | 76.00 s | 20.70 s | 99.38 s | 100% in both turns |

In the lookahead run, the first script was ready at 19.065 s and audio began at 20.695 s. The second script was ready at 56.301 s, before the first voice turn ended at 61.918 s. This verifies that subsequent planning overlaps narration. These are two short runs with different generated passages, not a controlled latency benchmark. Provider latency and content length vary. The smoke client acknowledges generated audio immediately and does not measure physical speaker output latency.

The script produces full raw evidence and WAVs in ignored `test-results/live/`. The writer's model metadata reported a 1,048,576-token input limit. A separate live token-count comparison confirmed that longer system instructions increase REST full-request counts.

## Browser checks

Real browser on the local app, using a separate live bakery topic:

- Target Spanish sentence appeared first, followed by English from actual output transcription.
- Pause at 00:11 froze transcript text over a 1.5-second observation window.
- Resume advanced the text; End stopped it, with no text changes during the following second.
- Browser localStorage held only `maestro-radio-preferences`, with no API keys.
- Desktop layout inspected at 1912 px and 1200 px; mobile at 390 × 844 had no horizontal overflow.
- Initial page and listening screenshots were visually inspected; artifacts are in ignored `test-results/`.

The generated transcript was matched against the supplied script, not independently transcribed from the waveform. Long-session soak testing, semantic novelty across hundreds of passages, and an actual full-million-token episode have not been run.
