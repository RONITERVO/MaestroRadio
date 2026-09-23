import { SAMPLE_RATE } from '../shared/audio.ts';
import { PlaybackTimeline } from '../shared/playback-timeline.ts';

/** One AudioContext per listening gesture. Captions follow its output clock, including pauses and underruns. */
export class StreamPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private buffers = new Map<number, { buffer: AudioBuffer; source: AudioBufferSourceNode }>();
  private pitch?: Awaited<ReturnType<typeof import('./pitch.ts')['createPitch']>>;
  private timeline: PlaybackTimeline;
  private completed = 0;
  stopped = false;
  paused = false;
  constructor(bufferMs: number, readonly context = new AudioContext({ latencyHint: 'playback' })) { this.timeline = new PlaybackTimeline(bufferMs); }
  get rate() { return this.timeline.rate; }
  get diagnostics() { return { ...this.timeline.stats, bufferedMs: this.timeline.bufferedMs(this.context.currentTime) }; }
  async unlock() {
    await this.context.resume();
    this.pitch = await (await import('./pitch.ts')).createPitch(this.context);
    this.pitch.input.connect(this.context.destination);
    this.pitch.setRate(this.rate, this.context.currentTime);
  }
  add(data: string, startSample: number) {
    if (this.stopped) return;
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const count = bytes.length / 2;
    const buffer = this.context.createBuffer(1, count, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const now = this.context.currentTime;
    const when = this.timeline.add(startSample, count, now);
    this.schedule(buffer, startSample, when, 0);
  }
  private schedule(buffer: AudioBuffer, chunkStart: number, when: number, offset: number) {
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.playbackRate.value = this.rate;
    source.connect(this.pitch?.input ?? this.context.destination);
    this.buffers.set(chunkStart, { buffer, source });
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source); source.disconnect();
      if (this.buffers.get(chunkStart)?.source === source) this.buffers.delete(chunkStart);
    };
    source.start(when, offset);
  }
  setRate(rate: number) {
    if (this.stopped || rate === this.rate) return;
    const pivot = this.context.currentTime + 0.03;
    const rescheduled = this.timeline.setRate(rate, pivot);
    this.pitch?.setRate(rate, pivot);
    for (const item of rescheduled) {
      const old = this.buffers.get(item.chunkStart);
      if (!old) throw new Error('Audio buffer disappeared before playback.');
      old.source.stop(pivot);
      this.schedule(old.buffer, item.chunkStart, item.when, (item.sample - item.chunkStart) / SAMPLE_RATE);
    }
  }
  get playedSamples() {
    if (this.stopped) return this.completed;
    const output = this.context.getOutputTimestamp?.().contextTime;
    const now = output && output > 0 ? output : Math.max(0, this.context.currentTime - (this.context.baseLatency || 0));
    return this.timeline.playedAt(Math.max(0, now - (this.pitch?.delaySeconds ?? 0)));
  }
  async togglePause() {
    if (this.stopped) return;
    this.paused = !this.paused;
    if (this.paused) await this.context.suspend();
    else await this.context.resume();
  }
  async stop() {
    if (this.stopped) return;
    this.completed = this.playedSamples;
    this.stopped = true;
    for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } }
    this.sources.clear();
    this.buffers.clear(); this.pitch?.stop();
    await this.context.close();
  }
}
