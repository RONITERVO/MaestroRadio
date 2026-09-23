# Initial verification — 2026-09-23

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
