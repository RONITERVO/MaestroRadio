import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SAMPLE_RATE, linesFor, type Plan, type ServerEvent, type Settings } from '../shared/protocol.ts';
import { ContextFull, Planner } from './planner.ts';
import { KeyPool, PublicError, safeError } from './keys.ts';
import { narrate } from './live.ts';

const seeds = [
  'How a city wakes up before sunrise: follow the hidden work behind an ordinary morning.',
  'The secret journeys of everyday objects: begin with a ceramic cup and follow its materials and history.',
  'Small inventions that changed ordinary life: start with the humble zipper.',
  'What forests do after dark: begin with a moth finding a flower.',
  'A slow journey through the science and culture of food: begin with bread rising.',
  'How people found their way before GPS: begin with a sailor watching the night sky.',
  'Explore the surprising physics of everyday life: begin with a bicycle taking a corner.',
  'A journey through unusual homes and the reasons people built them.',
];
export class PlaybackGate {
  played = 0;
  paused = false;
  lastProgress = Date.now();
  update(played: number, paused: boolean, generated: number) {
    this.played = Math.max(this.played, Math.min(played, generated));
    this.paused = paused;
    this.lastProgress = Date.now();
  }
  canProduce(generated: number) { return !this.paused && generated - this.played < SAMPLE_RATE * 12; }
  async wait(generated: number, signal: AbortSignal) {
    while (!this.canProduce(generated)) {
      signal.throwIfAborted();
      if (Date.now() - this.lastProgress > 120_000) throw new PublicError('Playback stopped reporting progress. The episode was stopped.');
      await delay(100, undefined, { signal });
    }
  }
}
export type EpisodeConfig = { plannerModel: string; liveModel: string; contextLimit: number; dataDir: string; plannerPool: KeyPool; livePool: KeyPool };
export class Episode {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly gate = new PlaybackGate();
  totalSamples = 0;
  readonly folder: string;
  readonly planner: Planner;
  constructor(readonly settings: Settings, private config: EpisodeConfig, private emit: (event: ServerEvent) => void) {
    if (!settings.topic) settings.topic = seeds[randomInt(seeds.length)];
    this.folder = join(config.dataDir, this.id);
    mkdirSync(this.folder, { recursive: true });
    this.planner = new Planner(config.plannerModel, config.plannerPool, settings, config.contextLimit);
    writeFileSync(join(this.folder, 'episode.json'), JSON.stringify({ version: 1, id: this.id, createdAt: new Date().toISOString(), settings,
      plannerModel: config.plannerModel, liveModel: config.liveModel, sampleRate: SAMPLE_RATE }, null, 2));
  }
  private record(event: unknown) { appendFileSync(join(this.folder, 'ledger.jsonl'), JSON.stringify(event) + '\n'); }
  stop() { this.controller.abort(new DOMException('Stopped', 'AbortError')); }
  progress(played: number, paused: boolean) { this.gate.update(played, paused, this.totalSamples); }
  async run(maxTurns = Infinity) {
    const signal = this.controller.signal;
    let reason = 'stopped';
    let turn = 0;
    let prefetch: Promise<{ plan: Plan; error?: never } | { plan?: never; error: unknown }> | undefined;
    const context = () => this.emit({ type: 'context', used: this.planner.used, limit: this.planner.limit,
      cumulativeInput: this.planner.cumulativeInput, cumulativeOutput: this.planner.cumulativeOutput });
    try {
      this.emit({ type: 'session', id: this.id, topic: this.settings.topic, plannerModel: this.config.plannerModel, liveModel: this.config.liveModel });
      this.emit({ type: 'status', state: 'planning', detail: 'Finding the first thread' });
      await this.planner.initialize(signal);
      while (turn < maxTurns) {
        await this.gate.wait(this.totalSamples, signal);
        signal.throwIfAborted();
        this.emit({ type: 'status', state: 'planning', detail: turn ? 'Following the next thread' : 'Writing the opening passage' });
        const prepared = prefetch ? await prefetch : { plan: await this.planner.next(signal, context) };
        prefetch = undefined;
        if (prepared.error) throw prepared.error;
        const plan = prepared.plan!;
        this.record({ type: 'plan', turn, plan });
        // Pause may have arrived while the HTTP writer request was in flight.
        await this.gate.wait(this.totalSamples, signal);
        const startSample = this.totalSamples;
        this.emit({ type: 'turn', turn, startSample });
        this.emit({ type: 'status', state: 'streaming' });
        const result = await this.config.livePool.run(key => narrate({ key, model: this.config.liveModel, voice: this.settings.voice,
          lines: linesFor(plan, this.settings), signal,
          onAudio: (data, localSample) => {
            signal.throwIfAborted();
            const bytes = Buffer.from(data, 'base64');
            appendFileSync(join(this.folder, 'audio.pcm'), bytes);
            this.totalSamples = startSample + localSample + bytes.length / 2;
            this.emit({ type: 'audio', turn, startSample: startSample + localSample, data });
            if (!prefetch && !this.gate.paused && turn + 1 < maxTurns) {
              prefetch = this.planner.next(signal, context).then(plan => ({ plan }), error => ({ error }));
            }
          },
          onCue: localCue => {
            const cue = { ...localCue, startSample: startSample + localCue.startSample, endSample: startSample + localCue.endSample,
              observedAtSample: startSample + localCue.observedAtSample };
            this.record({ type: 'cue', turn, cue });
            this.emit({ type: 'cue', turn, cue });
          },
        }), signal, () => this.totalSamples === startSample);
        this.record({ type: 'narrated', turn, transcript: result.transcript, coverage: result.coverage, lineCoverage: result.lineCoverage, startSample, endSample: this.totalSamples });
        this.planner.observe(`Narration receipt for passage ${turn}: ${JSON.stringify({ actualTranscript: result.transcript, coverage: result.coverage, complete: true })}. This is generated audio; playback may still be buffered.`);
        this.emit({ type: 'turnEnd', turn, endSample: this.totalSamples, coverage: result.coverage });
        // A strong mismatch should be visible and stop continuation, never trigger a duplicate audio replay.
        if (result.coverage < 0.82 || result.lineCoverage.some(coverage => coverage < 0.55)) throw new PublicError('The voice departed too far from the bilingual script. The episode stopped; actual captions and audio are saved.');
        turn++;
      }
      reason = 'complete';
    } catch (error) {
      if (error instanceof ContextFull) reason = 'context-full';
      else if (!signal.aborted) { reason = 'error'; this.emit({ type: 'error', message: safeError(error) }); }
    } finally {
      this.controller.abort();
      if (prefetch) await prefetch;
      // Persist complete writer memory, including rejected drafts, with no keys.
      writeFileSync(join(this.folder, 'memory.json'), JSON.stringify({ system: this.planner.system, history: this.planner.history,
        inputTokens: this.planner.used, contextLimit: this.planner.limit, cumulativeInput: this.planner.cumulativeInput, cumulativeOutput: this.planner.cumulativeOutput }, null, 2));
      this.record({ type: 'ended', reason, generatedSamples: this.totalSamples, playedSamples: this.gate.played, at: new Date().toISOString() });
      this.emit({ type: 'end', reason, endSample: this.totalSamples });
    }
  }
}
