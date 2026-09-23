import type { Cue, Line, ServerEvent } from '../shared/protocol.ts';
import { KeyPool, PublicError } from './keys.ts';
import { narrate, type LiveOptions, type LiveResult } from './live.ts';
import { Pulse } from './queue.ts';

type LocalEvent = { type: 'audio'; data: string; sample: number } | { type: 'cue'; cue: Cue };
type Options = { model: string; voice: string; pool: KeyPool; signal: AbortSignal;
  emit: (event: ServerEvent) => void; record: (event: unknown) => void;
  receipt: (turn: number, result: LiveResult) => void; fail: (error: unknown) => void };

/** Two readers may generate together; their output is published strictly in script order. */
export class NarrationPipeline {
  producedSamples = 0;
  publishedSamples = 0;
  private nextTurn = 0;
  private tail: Promise<void> = Promise.resolve();
  private jobs = new Set<Promise<void>>();
  private requests = new Set<Promise<unknown>>();
  private pulse = new Pulse();
  constructor(private options: Options, private synthesize: (options: LiveOptions) => Promise<LiveResult> = narrate) {}
  get pending() { return this.jobs.size; }
  async slot() {
    while (this.jobs.size >= 2) await this.pulse.wait(this.options.signal);
    this.options.signal.throwIfAborted();
  }
  enqueue(lines: Line[]) {
    this.options.signal.throwIfAborted();
    if (this.pending >= 2) throw new Error('Narration lookahead exceeded');
    const turn = this.nextTurn++;
    const held: LocalEvent[] = [];
    let publishing = false;
    let offset = 0;
    let attemptSamples = 0;
    const publish = (event: LocalEvent) => {
      if (event.type === 'audio') {
        this.publishedSamples = offset + event.sample + Buffer.from(event.data, 'base64').length / 2;
        this.options.emit({ type: 'audio', turn, startSample: offset + event.sample, data: event.data });
      } else {
        const cue = { ...event.cue, startSample: offset + event.cue.startSample, endSample: offset + event.cue.endSample,
          observedAtSample: offset + event.cue.observedAtSample };
        this.options.record({ type: 'cue', turn, cue });
        this.options.emit({ type: 'cue', turn, cue });
      }
    };
    const accept = (event: LocalEvent) => {
      this.options.signal.throwIfAborted();
      if (publishing) publish(event); else held.push(event);
    };
    const generate = async () => {
      for (let repair = 0; repair < 3; repair++) {
        const result = await this.options.pool.run(key => {
          // Future turns remain private until validated, so a discarded attempt cannot be heard twice.
          this.producedSamples -= attemptSamples;
          attemptSamples = 0; held.length = 0;
          const requestedAt = Date.now();
          let firstAudioAt = 0;
          return this.synthesize({ key, model: this.options.model, voice: this.options.voice, lines, signal: this.options.signal, plainText: repair < 2,
            onAudio: (data, sample) => {
              firstAudioAt ||= Date.now();
              const count = Buffer.from(data, 'base64').length / 2;
              attemptSamples += count; this.producedSamples += count; accept({ type: 'audio', data, sample });
            },
            onCue: cue => accept({ type: 'cue', cue }),
          }).then(result => {
            this.options.record({ type: 'voiceTiming', turn, repair, requestedAt, firstAudioMs: firstAudioAt - requestedAt,
              completedMs: Date.now() - requestedAt, audioSeconds: result.samples / 24000 });
            return result;
          });
        }, this.options.signal, () => !publishing || attemptSamples === 0);
        if (result.coverage >= 0.82 && result.lineCoverage.every(coverage => coverage >= 0.55)) return result;
        this.options.record({ type: 'voiceRejected', turn, repair, published: publishing, transcript: result.transcript,
          coverage: result.coverage, lineCoverage: result.lineCoverage });
        if (publishing || repair === 2) throw new PublicError('The voice could not produce a complete bilingual transcript after three attempts. Episode history is saved.');
      }
      throw new Error('Unreachable voice repair state');
    };
    const request = generate().then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    this.requests.add(request);
    void request.then(() => this.requests.delete(request));
    const predecessor = this.tail;
    const job = (async () => {
      await predecessor;
      // Validate before publication so a missing language can be repaired without replaying speech.
      const outcome = await request;
      if (outcome.error) throw outcome.error;
      this.options.signal.throwIfAborted();
      offset = this.publishedSamples;
      this.options.emit({ type: 'turn', turn, startSample: offset });
      publishing = true;
      for (const event of held) publish(event);
      held.length = 0;
      this.options.signal.throwIfAborted();
      const result = outcome.result!;
      this.options.record({ type: 'narrated', turn, transcript: result.transcript, coverage: result.coverage,
        lineCoverage: result.lineCoverage, startSample: offset, endSample: this.publishedSamples });
      this.options.receipt(turn, result);
      this.options.emit({ type: 'turnEnd', turn, endSample: this.publishedSamples, coverage: result.coverage });
    })();
    this.tail = job;
    this.jobs.add(job);
    const release = () => { this.jobs.delete(job); this.pulse.notify(); };
    void job.then(release, error => { this.options.fail(error); release(); });
  }
  async drain() { await this.tail; }
  async settled() { await Promise.allSettled([...this.jobs, ...this.requests]); }
}
