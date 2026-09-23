import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SAMPLE_RATE, linesFor, type Plan, type ServerEvent, type Settings, type PlaybackDiagnostics } from '../shared/protocol.ts';
import { ContextFull, Planner } from './planner.ts';
import { KeyPool, PublicError, safeError } from './keys.ts';
import { NarrationPipeline } from './narration-pipeline.ts';
import { BoundedQueue } from './queue.ts';

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
  rate = 1;
  lastProgress = Date.now();
  update(played: number, paused: boolean, generated: number) {
    this.played = Math.max(this.played, Math.min(played, generated));
    this.paused = paused;
    this.lastProgress = Date.now();
  }
  canProduce(generated: number) { return !this.paused && generated - this.played < SAMPLE_RATE * 45 * this.rate; }
  async wait(generated: () => number, signal: AbortSignal) {
    while (!this.canProduce(generated())) {
      signal.throwIfAborted();
      if (Date.now() - this.lastProgress > 120_000) throw new PublicError('Playback stopped reporting progress. The episode was stopped.');
      await delay(100, undefined, { signal });
    }
    signal.throwIfAborted();
  }
}
export type EpisodeConfig = { plannerModel: string; plannerFallbackModels?: string[]; plannerTimeoutMs?: number;
  liveModel: string; contextLimit: number; dataDir: string; plannerPool: KeyPool; livePool: KeyPool };
export class Episode {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly gate = new PlaybackGate();
  totalSamples = 0;
  readonly folder: string;
  readonly planner: Planner;
  private playback?: PlaybackDiagnostics;
  private musicChosen = false;
  private chooseMusic(prompt: string, source: 'writer' | 'custom') {
    if (!this.settings.music || this.musicChosen || !prompt) return;
    this.musicChosen = true;
    const event = { type: 'musicPrompt' as const, prompt, source };
    writeFileSync(join(this.folder, 'music.json'), JSON.stringify(event, null, 2));
    this.record(event); this.emit(event);
  }
  constructor(readonly settings: Settings, private config: EpisodeConfig, private emit: (event: ServerEvent) => void) {
    if (!settings.topic) settings.topic = seeds[randomInt(seeds.length)];
    this.folder = join(config.dataDir, this.id);
    mkdirSync(this.folder, { recursive: true });
    this.planner = new Planner(config.plannerModel, config.plannerPool, settings, config.contextLimit, undefined, undefined, {
      fallbacks: config.plannerFallbackModels, timeoutMs: config.plannerTimeoutMs,
      onSwitch: change => { this.record({ type: 'writerModel', ...change, at: new Date().toISOString() }); this.emit({ type: 'writer', model: change.to }); },
    });
    this.gate.rate = settings.speed;
    writeFileSync(join(this.folder, 'episode.json'), JSON.stringify({ version: 2, id: this.id, createdAt: new Date().toISOString(), settings,
      plannerModel: config.plannerModel, plannerFallbackModels: config.plannerFallbackModels, plannerTimeoutMs: config.plannerTimeoutMs,
      liveModel: config.liveModel, sampleRate: SAMPLE_RATE }, null, 2));
  }
  private record(event: unknown) { appendFileSync(join(this.folder, 'ledger.jsonl'), JSON.stringify(event) + '\n'); }
  stop() { this.controller.abort(new DOMException('Stopped', 'AbortError')); }
  progress(played: number, paused: boolean, playback?: PlaybackDiagnostics, rate?: number) {
    this.gate.update(played, paused, this.totalSamples);
    if (rate !== undefined) this.gate.rate = Math.min(2, Math.max(1, rate));
    if (playback) this.playback = playback;
  }
  /** maxPlans bounds writing calls for finite live verification, not individual voice turns. */
  async run(maxPlans = Infinity) {
    const signal = this.controller.signal;
    let reason = 'stopped';
    let failure: unknown;
    const queue = new BoundedQueue<Plan>(1);
    const fail = (error: unknown) => { if (!signal.aborted) { failure = error; this.controller.abort(error); } queue.close(); };
    const pipeline = new NarrationPipeline({ model: this.config.liveModel, voice: this.settings.voice, pool: this.config.livePool, signal,
      emit: event => {
        if (event.type === 'audio') {
          const bytes = Buffer.from(event.data, 'base64');
          appendFileSync(join(this.folder, 'audio.pcm'), bytes);
          this.totalSamples = event.startSample + bytes.length / 2;
        }
        this.emit(event);
      },
      record: event => this.record(event), fail,
      receipt: (turn, result) => this.planner.observe(`Narration receipt ${turn}: ${JSON.stringify({ actualTranscript: result.transcript, complete: true })}. Generated audio; some may still be buffered.`),
    });
    const context = () => this.emit({ type: 'context', used: this.planner.used, limit: this.planner.limit,
      cumulativeInput: this.planner.cumulativeInput, cumulativeOutput: this.planner.cumulativeOutput });
    let writer: Promise<void> | undefined;
    try {
      this.emit({ type: 'session', id: this.id, topic: this.settings.topic, plannerModel: this.config.plannerModel, liveModel: this.config.liveModel });
      this.chooseMusic(this.settings.musicPrompt, 'custom');
      this.emit({ type: 'status', state: 'planning', detail: 'Finding the first thread' });
      await this.planner.initialize(signal);
      this.emit({ type: 'writer', model: this.planner.model });
      writer = (async () => {
        try {
          for (let index = 0; index < maxPlans; index++) {
            await queue.space(signal);
            await this.gate.wait(() => pipeline.producedSamples, signal);
            const plan = await this.planner.next(signal, context);
            signal.throwIfAborted();
            if (plan.musicPrompt) this.chooseMusic(plan.musicPrompt, 'writer');
            if (index === 2 && this.settings.music && !this.musicChosen) this.emit({ type: 'musicStatus', state: 'unavailable', detail: 'The writer did not supply a valid music prompt. Speech continues.' });
            this.record({ type: 'plan', index, model: this.planner.model, plan });
            await queue.put(plan, signal);
          }
        } catch (error) {
          if (error instanceof ContextFull) reason = 'context-full';
          else fail(error);
        } finally { queue.close(); }
      })();
      let opening = true;
      while (true) {
        const plan = await queue.take(signal);
        if (!plan) break;
        const batches: Plan['pairs'][] = [];
        // Prepare two short opening turns together: a long second turn can outlast the first.
        let pairIndex = 0;
        if (opening) {
          for (; pairIndex < Math.min(2, plan.pairs.length); pairIndex++) batches.push(plan.pairs.slice(pairIndex, pairIndex + 1));
        }
        for (; pairIndex < plan.pairs.length; pairIndex += 2) batches.push(plan.pairs.slice(pairIndex, pairIndex + 2));
        for (const pairs of batches) {
          await pipeline.slot();
          await this.gate.wait(() => pipeline.producedSamples, signal);
          pipeline.enqueue(linesFor({ ...plan, pairs }, this.settings));
        }
        opening = false;
      }
      await writer;
      await pipeline.drain();
      if (reason !== 'context-full') reason = 'complete';
    } catch (error) {
      const cause = failure ?? error;
      if (cause instanceof ContextFull) reason = 'context-full';
      else if (failure || !signal.aborted) { reason = 'error'; this.emit({ type: 'error', message: safeError(cause) }); }
    } finally {
      this.controller.abort(); queue.close();
      await writer;
      await pipeline.settled();
      writeFileSync(join(this.folder, 'memory.json'), JSON.stringify({ model: this.planner.model, system: this.planner.system, history: this.planner.history,
        inputTokens: this.planner.used, contextLimit: this.planner.limit, cumulativeInput: this.planner.cumulativeInput, cumulativeOutput: this.planner.cumulativeOutput }, null, 2));
      this.record({ type: 'ended', reason, generatedSamples: this.totalSamples, playedSamples: this.gate.played, playback: this.playback, at: new Date().toISOString() });
      this.emit({ type: 'end', reason, endSample: this.totalSamples });
    }
  }
}
