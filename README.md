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

Optional `PLANNER_API_KEYS` and `LIVE_API_KEYS` give the writer and narrator separate pools. Browser-pasted keys replace both pools for that connection and remain only in tab/server memory. Keys are never included in episode files, URLs, localStorage, or client bundles.

Pool behavior: deduplication, rotation, model-specific access quarantine and cooldowns, bounded retries, and cancellation. Available keys are tried immediately; waiting happens only when every usable key for that model is cooling down. Every configured key can be tried, including pools larger than eight keys. Concurrent requests prefer idle keys, and a writer quota failure does not prevent using that key for Live.

Google's [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) apply per project and vary by model. Keys from separate projects can therefore provide independent capacity. The app learns availability from actual requests and remembers cooldowns in memory; it cannot know a project's remaining quota in advance. It honors provider retry delays, and daily-exhausted keys are parked until midnight Pacific rather than retried every few seconds. If all keys for the writer model have exhausted their daily quota, another project key or the reset is needed. Incomplete voice attempts are retried privately before publication; already published speech is never replayed.

| Setting | Default | Purpose |
| --- | --- | --- |
| `PLANNER_MODEL` | `gemini-2.5-flash-lite` | Fast non-Live writer with a complete episode ledger |
| `LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | MaestroTutor's established narrator |
| `CONTEXT_LIMIT` | `1048576` | Optional smaller ceiling; also capped by actual model metadata |
| `PORT` | `4317` | Local HTTP/WebSocket port |
| `DATA_DIR` | `./data` | Private episode archives |

`gemini-3.8-live` is a configurable newer Live alternative; the default deliberately follows MaestroTutor's tested model. Availability varies by key and model lifecycle. No silent model fallback changes an episode's behavior.

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

Flash-Lite 2.5 is the default after a local identical-prompt benchmark completed in **1.7 seconds**, versus **35.6 seconds** for 3.5. This is one measured comparison, not a universal model speed claim; override `PLANNER_MODEL` to compare on your own account. See the verification report for end-to-end results.

## Backend design

```text
Listener request + language pair
               |
     Flash-Lite writer <----- complete chronological ledger
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

Generated and actually played audio are distinguished; ending may leave unplayed generated audio in the archive. These files contain your listening content. They remain on this machine until you remove them. Disconnect ends generation. This version supports pause/resume within a tab, **not automatic episode resumption after closing the tab or restarting the server**. Archives make that extension possible without pretending unheard material was played.

To listen to archived PCM with FFmpeg tools:

```powershell
ffplay -f s16le -ar 24000 -ac 1 data/<episode-id>/audio.pcm
```

## Verification

`npm test` covers context exhaustion, complete-history counting, bounded repair, language reversals, key handling, split transcription, real-audio gating, CJK text, immutable cue timing, playback backpressure, ordered concurrent narration, private voice repair, Live completion/cancellation, and browser audio scheduling through pauses/underruns.

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
```

The soak test reports initial delay, scheduler underruns, silence at joins, coverage and peak buffered audio. Its ignored `test-results/soak/` archives include packet arrival times for reproduction. It fails on underruns or an incomplete episode. The older smoke script acknowledges audio immediately and cannot measure playback continuity.

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
