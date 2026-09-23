# Maestro Radio

An unfolding bilingual podcast. Pick a subject or choose a random starting point. Each short target-language sentence is immediately followed by its spoken translation, with a transcript that appears as you listen.

The writer keeps the complete episode history. The voice reads small passages. An episode ends before the writer's context window fills; history is never silently summarized or dropped.

## Run locally

Node.js **22.13+** is required.

```powershell
git clone https://github.com/RONITERVO/MaestroRadio.git
cd MaestroRadio
npm install
Copy-Item .env.example .env
# Add your Gemini key(s) to .env, or paste them into Settings in the app.
npm run dev
```

Open **http://127.0.0.1:4317**. Start listening with a deliberate click to unlock browser audio.

```powershell
npm test
npm run build
npm start
```

`npm start` serves the built client and backend together. The app binds to loopback. This release is for a local, single-user server; it is not a public hosted service.

For a Windows desktop and Start menu shortcut, run `powershell -ExecutionPolicy Bypass -File scripts/Install-Shortcut.ps1`. **Maestro Radio** (or **Ctrl+Alt+M**) starts the local server if needed and opens the app. Run `npm run build` after updating; the shortcut prefers the built client.

## Android (native Kotlin)

The `android/` project runs the writer, Gemini Live narrator and Lyria **directly on the phone**. It needs no PC, Node server, WebView or ADB reverse connection. Native `AudioTrack` playback drives the transcript clock, with independent stereo music, pitch-preserving 1–2× speech, a foreground media service, headphone/audio-focus handling and lock-screen pause/end controls.

Build with JDK 17 or 21 and Android SDK 36:

```powershell
npm run android:prompts
cd android
# Set ANDROID_HOME or sdk.dir in your untracked local.properties.
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
cd ..
npm run android:install
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`. This is a locally signed **debug/test APK**, not a Play Store release. Set `ADB` if your adb executable is somewhere other than `C:/adb/adb.exe` on Windows or `adb` on other platforms. Installation targets one USB-authorized device.

Use Settings to paste multiple Gemini keys or import a `.env` file. Keys are encrypted using Android Keystore; cloud backup and device transfer are disabled. No keys are bundled in the APK. For your own connected development phone, `npm run android:install -- --with-keys` can provision the desktop shared key pool through stdin into the app-private sandbox; the app encrypts it on launch and deletes the temporary import. The installer never prints keys or includes them in shell arguments.

The native writer shares generated prompt templates and the desktop default/fallback model order. It checks every full-history request against the selected model's actual context limit, validates repetition, and rejects missing spoken translations before playing a voice turn. The desktop additionally uses `franc` for a conservative language-reversal check; the native app currently relies on explicit language field contracts and transcript coverage. Native archives (plans, complete memory, actual transcripts and heard-text export) stay in the app's private storage; raw voice/music PCM is not retained. An interrupted/killed app does not automatically resume an old episode.

## Lyria background music

Music is enabled by default and can be turned off under **Music** (Android: **Style & music**) for the next episode. Leave the music description blank for **automatic scoring**: the writer composes a new prompt for the podcast's subject and storytelling style, using actual DrawnExplainers video scores as examples. It chooses concrete instruments, playing techniques, space and mood, with room for narration. You can still enter a custom description to override it. Existing installations replace the old stock description with automatic mode once; custom descriptions are preserved.

The score prompt arrives in the normal opening passage, without a separate LLM request. Lyria connects in parallel with speech generation and retains the same prompt throughout the episode and any music reconnects. Settings shows the chosen prompt; it never enters spoken lines or the transcript. If the writer returns malformed music metadata, valid narration continues and the next normal passage asks again, up to three passages, after which music is skipped with a status message. Volume changes immediately in Settings; music remains at its natural speed when speech speeds up.

The stream uses [`lyria-realtime-exp`](https://ai.google.dev/gemini-api/docs/realtime-music-generation), **QUALITY** mode, guidance 4.5 and temperature 1.0, with sparse arrangement settings. The approach comes from DrawnExplainers: a continuous instrumental bed, a gradual entrance, and speech-driven compression (threshold 0.06, ratio 9, attack 12 ms, release 420 ms). The browser uses a stereo audio worklet and a soft limiter. Android uses hardware playback, speech-level tracking and reserved mixing headroom. Offline FFmpeg loudness normalization cannot be reproduced exactly in a causal live stream, so this is an adaptation of that mix, not identical mastered output.

Music buffers independently, pauses provider generation when the listener pauses or the buffer is full, and attempts bounded reconnections. Lyria access/quota failures only disable the music; narration continues. Lyria is experimental and must be available to at least one configured project. Music generation uses additional API quota/cost; muting volume alone does not turn generation off.

## Keys and configuration

Accepted shared key formats:

```dotenv
GEMINI_API_KEYS=first-key,second-key,third-key
# Or individual variables, with no fixed numbering limit:
GEMINI_API_KEY1=first-key
GEMINI_API_KEY2=second-key
GEMINI_API_KEY37=another-key
```

`GEMINI_API_KEY`, `GEMINI_API_KEY_1`, and `GOOGLE_API_KEY` also work. `.env.local` takes precedence over `.env`; process environment takes precedence over both. `GEMINI_KEYS_FILE` can reference an existing local env file, avoiding duplicated credentials. Only shared key variables are read from that file.

Optional `PLANNER_API_KEYS`, `LIVE_API_KEYS` and `MUSIC_API_KEYS` give each model family separate pools. Browser-pasted keys replace these pools for that connection and remain only in tab/server memory. Keys are never included in episode files, browser page URLs, localStorage, or client bundles.

Pool behavior: deduplication, rotation, model-specific access quarantine and cooldowns, bounded retries, and cancellation. Available keys are tried immediately; waiting happens only when every usable key for that model is cooling down. Every configured key can be tried, including pools larger than eight keys. Concurrent requests prefer idle keys, and a writer quota failure does not prevent using that key for Live.

Google's [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) apply per project and vary by model. Keys from separate projects can therefore provide independent capacity. The app learns availability from actual requests and remembers cooldowns in memory; it cannot know a project's remaining quota in advance. It honors provider retry delays, and daily-exhausted keys are parked until midnight Pacific rather than retried every few seconds. When all keys for a writer model are unavailable, the configured next model can take over. Incomplete voice attempts are retried privately before publication; already published speech is never replayed.

| Setting | Default | Purpose |
| --- | --- | --- |
| `PLANNER_MODEL` | `gemini-2.5-flash` | Full Flash writer, with thinking disabled |
| `PLANNER_FALLBACK_MODELS` | `gemini-3-flash-preview,gemini-2.5-flash-lite` | Ordered writer fallbacks; set empty to disable |
| `PLANNER_TIMEOUT_MS` | `12000` | Deadline per writer model attempt, including token counting and key rotation |
| `LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | MaestroTutor's established narrator |
| `MUSIC_MODEL` | `lyria-realtime-exp` | Continuous instrumental background music |
| `CONTEXT_LIMIT` | `1048576` | Optional smaller ceiling; also capped by actual model metadata |
| `PORT` | `4317` | Local HTTP/WebSocket port |
| `DATA_DIR` | `./data` | Private episode archives |

`gemini-3.8-live` is a configurable newer Live alternative; the default deliberately follows MaestroTutor's tested model. Availability varies by key and model lifecycle. The Live narrator stays fixed during an episode. Writer fallback updates the active model in Settings and is recorded in the archive.

Writer routing tries available keys for the current model within its deadline, then moves to the next configured model on quota, access, service or timeout failures. It keeps the successful fallback for subsequent passages. Each handoff sends the complete, unchanged ledger, including provider signatures, and checks the new model's actual context limit. Context exhaustion stops the episode; it never truncates history to make a fallback fit. Invalid requests and repeated invalid passages remain errors. Setting a custom `PLANNER_MODEL` alone pins it; set `PLANNER_FALLBACK_MODELS` explicitly to enable fallbacks for that custom choice. Restart the local server after changing `.env`.

## Listening

- Choose target and native languages, level, topic, and optionally voice/buffer settings.
- Use **Style & expression** to describe the episode in your own words: a folk tale, a comedy, the listener as the main character, or another approach. Leave it blank for the usual conversational podcast. Style applies to the next episode.
- Optionally enable **Expressive voice**. The writer adds sparse delivery cues such as curiosity, whispers, or a chuckle, using MaestroTutor-style placement examples. The narrator performs those cues; captions omit the bracketed instructions. This is an experimental model-guided performance, not a guaranteed emotion control.
- Change playback speed from **1× to 2×** in the listening bar or Settings, including while paused. Pitch is preserved, and transcript timing follows the changed audio speed. Your speed and style preferences are saved locally.
- The ↝ button starts a randomly selected topic; an empty request does the same.
- Pause suspends the audio clock and transcript together. In-flight passages may finish generating, but the backend stops starting additional voice turns.
- End cancels the active work and scheduled audio immediately.
- Save text exports only text revealed during playback, including any partial last sentence.
- The listening surface displays Live's actual output transcription. Planned text is never substituted if transcription fails.

The default browser scheduling buffer is **0.4 seconds**, adjustable up to 4 seconds. Startup also includes writing and checking a short opening sentence/translation. Later passages are generated by two overlapping readers and checked before publication, while earlier audio plays. There is no extra startup delay at each passage boundary. Provider outages or repeated failed generations can still exhaust the queue.

Full **2.5 Flash** is the default after six accepted factual/story passages took **2.2–2.7 seconds** in a local comparison. Gemini 3 Flash is the first fallback, with minimal thinking; 2.5 Flash-Lite remains an emergency fallback. 3.1 Flash-Lite and 3.8 Flash returned service errors during this comparison, while 3.5 Flash-Lite was slow despite minimal thinking, so they are configurable rather than default fallbacks. These are account- and workload-specific measurements. Higher daily quotas do not guarantee lower latency. See the verification report for results, including an audio-generation gap observed at 2×.

## Backend design

```text
Listener request + language pair
               |
     Flash writer <---------- complete chronological ledger
               |                     ^
     validated bilingual passage     | plans + actual transcripts
               |                     |
     two overlapping Live readers --+
               |
     private transcript validation + bounded repair
               |
     PCM + observed transcript positions
               |
     browser audio buffer / output clock --> gradually revealed text
               |
     playback progress and pause --------> bounded production
```

The writer returns structured pairs, a concrete angle, new facts, and a next-topic thread. Explicit field descriptions and a local language check catch clear target/native reversals. Validation also rejects malformed passages, exact duplicate facts/sentences, and near-identical sentences, with at most three drafts. A recurring passage title alone does not reject fresh story events. Vocal tags are excluded from repetition and language checks. A writer batch has up to four pairs. The first two voice turns each have one pair and begin generating together; later turns have at most two. The Live instruction never specifies a line count. Both languages are spoken in the **same turn and voice**.

Writing runs independently into a single-entry queue. The writer knows the latest planned script may still be speaking. Accepted narration receipts enter the permanent ledger; they may reach a later request if writing is already in flight. Every request uses an immutable snapshot so its token count and generation agree.

The backend starts a new voice turn only when produced-but-unplayed audio is below 45 seconds of listening time and playback is not paused. At 2× this reserves up to 90 seconds of source audio before the threshold is reached. At most two readers generate concurrently; those in-flight passages can take the reserve above the threshold. Completed passages are published strictly in script order. All audio and actual captions are checked before publication, with up to three voice attempts. Discarded attempts cannot duplicate heard speech. The normal script omits language-code markers, which caused transcript omissions in controlled tests; a final repair can try the marked format.

Each connection closes on `generationComplete`, after all output transcription has arrived, instead of waiting for Live's simulated playback to reach `turnComplete`. The browser owns the real playback clock. Fresh short connections keep Live's context small without compression or reconnection memory loss.

Before every writer request, the app counts the full system instruction and ledger using the REST `countTokens.generateContentRequest` endpoint. This avoids the JS SDK's Developer API restriction on `countTokens.config.systemInstruction`. An 8,192-token reserve covers a final output, schema overhead, and receipt. It stops cleanly at the smaller of the configured ceiling and model-reported limit.

Full history is **not perfect model recall**. The repetition guard catches obvious loops; semantic restatements can still pass. Longer episodes also cost more: resending growing history gives roughly quadratic cumulative input without effective caching. The context meter exposes cumulative writer input/output as well as current context. Provider implicit caching may help but is not assumed or guaranteed; explicit cache lifecycle management is not implemented.

## Timing contract

Gemini output transcription is evidence of generated speech, not independent acoustic word alignment. This adapter uses observed audio sample positions, not provider word timestamps.

The backend records the PCM sample cursor when each transcript fragment arrives. Characters within a fragment are paced between successive observed cursors. Text arriving before audio waits for real samples. Existing cues are never stretched to fit final audio duration, and planned words are never filled in. A forward text matcher places the observed words on the target/native lines; it does not rewrite them. Per-line and overall coverage checks reject significant departures or missing translations before playback.

The browser maps absolute samples to scheduled AudioContext output time, including startup delay, pauses, underrun gaps, and speed changes. A pitch-compensating SoundTouchJS worklet keeps the narrator's pitch stable at faster speeds; its measured buffering delay is subtracted from the caption clock. Speed changes reschedule only unplayed samples, preserving historical timestamps. It reveals Unicode characters progressively. This is approximate, low-latency synchronization. Exact word timestamps would require forced alignment of completed audio and more buffering.

## Local archives

Each episode creates an ignored `data/<uuid>/` folder:

- `episode.json`: languages, topic, voice, models, creation time.
- `ledger.jsonl`: accepted plans, observed cues, completed/rejected transcripts, coverage, voice timing, terminal reason, last acknowledged playback position and browser playback diagnostics.
- `audio.pcm`: raw 24 kHz, mono, signed 16-bit little-endian generated audio.
- `memory.json`: complete writer conversation and usage at graceful shutdown.
- `music.json`: the selected music prompt and whether it came from the writer or a custom description (when music is enabled and a prompt was selected). Android stores this in its private episode folder too.

Generated and actually played audio are distinguished; ending may leave unplayed generated audio in the archive. These files contain your listening content. They remain on this machine until you remove them. Disconnect ends generation. This version supports pause/resume within a tab, **not automatic episode resumption after closing the tab or restarting the server**. Archives make that extension possible without pretending unheard material was played.

To listen to archived PCM with FFmpeg tools:

```powershell
ffplay -f s16le -ar 24000 -ac 1 data/<episode-id>/audio.pcm
```

## Verification

`npm test` covers context exhaustion, complete-history counting, bounded repair, language reversals, key handling, split transcription, real-audio gating, CJK text, immutable cue timing, playback backpressure, ordered concurrent narration, private voice repair, Live completion/cancellation, and browser audio scheduling through pauses/underruns.

`npm run bench:music-prompts` performs three finite live writer requests for contrasting subjects/styles, saving the generated score prompts and opening-passage latency under `test-results/music/`. It uses your configured keys and consumes writer quota, but does not generate audio. Unit tests cover automatic/custom/off modes, selecting only an accepted passage's score, keeping music metadata out of speech, and bounded recovery from malformed music fields on both platforms.

Optional paid live check (two writer batches, finite and separately archived):

```powershell
npm run smoke -- --env D:/path/to/keys.env
```

Set `SMOKE_TURNS` to another small number if needed. The script produces a WAV, raw ledger, complete memory and timing evidence under ignored `test-results/live/`. It checks observed transcript coverage; it does not perform an independent acoustic transcription.

For a real-time test with playback backpressure, use the same scheduler as the browser:

```powershell
npm run test:soak
# Optional: SOAK_PLANS=6, SOAK_NATIVE=fi, SOAK_TOPIC=...
# Also: SOAK_SPEED=2, SOAK_STYLE=..., SOAK_EXPRESSIVE=1
npm run bench:writer
npm run bench:models
```

The soak test reports initial delay, scheduler underruns, silence at joins, coverage and peak buffered audio. Its ignored `test-results/soak/` archives include packet arrival times for reproduction. It fails on underruns or an incomplete episode. The older smoke script acknowledges audio immediately and cannot measure playback continuity. `bench:models` is a finite paid comparison of five Flash-family writers across factual Spanish/English and expressive Spanish/Finnish fiction, with two consecutive passages per case. It saves full plans and histories under ignored `test-results/model-comparison-*`; pass model IDs after `--` to narrow the comparison and `BENCH_KEY_OFFSET` to select another starting project key.

To test browser playback, speed changes and captions without more API calls, replay an existing local archive after building. This serves a separate test app at `http://127.0.0.1:4319`:

```powershell
npm run build
npm run replay -- data/<episode-id>
```

For a finite, paid vocal-direction comparison, reuse a writer plan from an episode with Expressive voice enabled:

```powershell
npm run experiment:voice -- data/<episode-id>
```

This generates neutral and expressive WAVs with the same bilingual words, plus raw transcripts and coverage under ignored `test-results/voice-experiment-*`. Generation is stochastic; listen to the samples to judge prosody. Automated transcript coverage alone cannot prove an emotion was performed correctly.

See [docs/verification.md](docs/verification.md) for measured live and browser results and [docs/architecture.md](docs/architecture.md) for design decisions and sources.

## Release

Source and lockfile are published at [RONITERVO/MaestroRadio](https://github.com/RONITERVO/MaestroRadio). Keep `.env*`, `data/`, and `test-results/` ignored. The app runs locally; no hosted deployment is included. The prompt adaptation follows MaestroTutor's Apache-2.0 license; see `NOTICE` and `LICENSE`.
