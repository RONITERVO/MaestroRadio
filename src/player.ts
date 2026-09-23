import { SAMPLE_RATE } from '../shared/audio.ts';
import { PlaybackTimeline } from '../shared/playback-timeline.ts';

/** One AudioContext per listening gesture. Captions follow its output clock, including pauses and underruns. */
export class StreamPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private timeline: PlaybackTimeline;
  private completed = 0;
  stopped = false;
  paused = false;
  constructor(bufferMs: number, readonly context = new AudioContext({ latencyHint: 'playback' })) { this.timeline = new PlaybackTimeline(bufferMs); }
  get diagnostics() { return { ...this.timeline.stats, bufferedMs: this.timeline.bufferedMs(this.context.currentTime) }; }
  async unlock() { await this.context.resume(); }
  add(data: string, startSample: number) {
    if (this.stopped) return;
    const binary = atob(data);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const count = bytes.length / 2;
    const buffer = this.context.createBuffer(1, count, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < count; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const now = this.context.currentTime;
    const when = this.timeline.add(startSample, count, now);
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(when);
  }
  get playedSamples() {
    if (this.stopped) return this.completed;
    const output = this.context.getOutputTimestamp?.().contextTime;
    const now = output && output > 0 ? output : Math.max(0, this.context.currentTime - (this.context.baseLatency || 0));
    return this.timeline.playedAt(now);
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
    await this.context.close();
  }
}
