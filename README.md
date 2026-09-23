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

Pool behavior: deduplication, rotation, invalid-key quarantine, exponential cooldown, bounded retries, and cancellation. The app will not retry a voice turn after any audio was delivered. **Google quotas apply per project, not per key**; extra keys in one project do not create extra quota.

| Setting | Default | Purpose |
| --- | --- | --- |
| `PLANNER_MODEL` | `gemini-3.5-flash-lite` | Non-Live writer with a complete episode ledger |
| `LIVE_MODEL` | `gemini-2.5-flash-native-audio-preview-12-2025` | MaestroTutor's established narrator |
| `CONTEXT_LIMIT` | `1048576` | Optional smaller ceiling; also capped by actual model metadata |
| `PORT` | `4317` | Local HTTP/WebSocket port |
| `DATA_DIR` | `./data` | Private episode archives |

`gemini-3.8-live` is a configurable newer Live alternative; the default deliberately follows MaestroTutor's tested model. Availability varies by key and model lifecycle. No silent model fallback changes an episode's behavior.

## Listening

- Choose target and native languages, level, topic, and optionally voice/buffer settings.
- The ↝ button starts a randomly selected topic; an empty request does the same.
- Pause suspends the audio clock and transcript together. An in-flight passage may finish generating, but the backend stops starting additional voice turns.
- End cancels the active work and scheduled audio immediately.
- Save text exports only text revealed during playback, including any partial last sentence.
- The listening surface displays Live's actual output transcription. Planned text is never substituted if transcription fails.

The default playback buffer is **1.4 seconds**, adjustable from 0.7 to 4 seconds. This is a transcript/jitter buffer, **not a promise of 1.4-second startup**. Initial writing is a separate request. In the initial local live tests, startup took about 19–21 seconds, with Live audio beginning roughly 1.6 seconds after a completed script was ready. One-passage lookahead hides most subsequent writing time behind narration, but slower provider responses can still cause gaps.

## Backend design

```text
Listener request + language pair
               |
     Flash-Lite writer <----- complete chronological ledger
               |                     ^
     validated bilingual passage     | plans + actual transcripts
               |                     |
     fresh Live reader per passage --+
               |
     PCM + observed transcript positions
               |
     browser audio buffer / output clock --> gradually revealed text
               |
     playback progress and pause --------> bounded production
```

The writer returns structured pairs, a concrete angle, new facts, and a next-topic thread. Validation rejects malformed passages, exact duplicate facts/angles/sentences, and near-identical sentences, with at most three drafts. Each voice script contains at most four bilingual pairs; the Live instruction never specifies a line count. Both languages are spoken in the **same turn and voice**.

Once audio for a passage begins, the writer prepares **one** following passage. The writer knows the current script is still being narrated. Completed narration receipts enter the permanent ledger; they may reach the writer one passage later if a request is already in flight. Every request uses an immutable snapshot so its token count and generation agree. A narration mismatch stops the stream before the prefetched passage is used.

The backend starts a new voice turn only when queued audio is below 12 seconds and playback is not paused. One in-flight voice passage and one planned passage are the maximum lookahead. The voice connection ends at each passage, keeping Live's context small and avoiding long-session compression or reconnection memory loss.

Before every writer request, the app counts the full system instruction and ledger using the REST `countTokens.generateContentRequest` endpoint. This avoids the JS SDK's Developer API restriction on `countTokens.config.systemInstruction`. An 8,192-token reserve covers a final output, schema overhead, and receipt. It stops cleanly at the smaller of the configured ceiling and model-reported limit.

Full history is **not perfect model recall**. The repetition guard catches obvious loops; semantic restatements can still pass. Longer episodes also cost more: resending growing history gives roughly quadratic cumulative input without effective caching. The context meter exposes cumulative writer input/output as well as current context. Provider implicit caching may help but is not assumed or guaranteed; explicit cache lifecycle management is not implemented.

## Timing contract

Gemini output transcription is evidence of generated speech, not acoustic word alignment. The Live API transcription object has no word timestamp fields.

The backend records the PCM sample cursor when each transcript fragment arrives. Characters within a fragment are paced between successive observed cursors. Text arriving before audio waits for real samples. Existing cues are never stretched to fit final audio duration, and planned words are never filled in. A forward text matcher places the observed words on the target/native lines; it does not rewrite them. Per-line and overall coverage checks stop significant departures or missing translations.

The browser maps absolute samples to scheduled AudioContext output time, including startup delay, pauses, and underrun gaps. It reveals Unicode characters progressively. This is approximate, low-latency synchronization. Exact word timestamps would require forced alignment of completed audio and more buffering.

## Local archives

Each episode creates an ignored `data/<uuid>/` folder:

- `episode.json`: languages, topic, voice, models, creation time.
- `ledger.jsonl`: accepted plans, observed cues, completed transcripts, coverage, terminal reason, last acknowledged playback position.
- `audio.pcm`: raw 24 kHz, mono, signed 16-bit little-endian generated audio.
- `memory.json`: complete writer conversation and usage at graceful shutdown.

Generated and actually played audio are distinguished; ending may leave unplayed generated audio in the archive. These files contain your listening content. They remain on this machine until you remove them. Disconnect ends generation. This version supports pause/resume within a tab, **not automatic episode resumption after closing the tab or restarting the server**. Archives make that extension possible without pretending unheard material was played.

To listen to archived PCM with FFmpeg tools:

```powershell
ffplay -f s16le -ar 24000 -ac 1 data/<episode-id>/audio.pcm
```

## Verification

`npm test` covers context exhaustion, complete-history counting, bounded duplicate repair, key handling, split transcription, real-audio gating, CJK text, immutable cue timing, playback backpressure, Live multipart events, connection cancellation, and browser audio scheduling through pauses/underruns.

Optional paid live check (two passages, finite and separately archived):

```powershell
npm run smoke -- --env D:/path/to/keys.env
```

Set `SMOKE_TURNS` to another small number if needed. The script produces a WAV, raw ledger, complete memory and timing evidence under ignored `test-results/live/`. It checks observed transcript coverage; it does not perform an independent acoustic transcription.

See [docs/verification.md](docs/verification.md) for the initial live and browser results and [docs/architecture.md](docs/architecture.md) for design decisions and sources.

## Release

Source and lockfile are published at [RONITERVO/MaestroRadio](https://github.com/RONITERVO/MaestroRadio). Keep `.env*`, `data/`, and `test-results/` ignored. The app runs locally; no hosted deployment is included. The prompt adaptation follows MaestroTutor's Apache-2.0 license; see `NOTICE` and `LICENSE`.
