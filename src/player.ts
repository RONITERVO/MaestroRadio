import { SAMPLE_RATE } from '../shared/audio.ts';

type Scheduled = { sample: number; count: number; when: number };
/** One AudioContext per listening gesture. Captions follow its output clock, including pauses and underruns. */
export class StreamPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private scheduled: Scheduled[] = [];
  private nextTime = 0;
  private completed = 0;
  private received = 0;
  stopped = false;
  paused = false;
  constructor(private bufferMs: number, readonly context = new AudioContext({ latencyHint: 'playback' })) {}
  async unlock() { await this.context.resume(); }
  add(data: string, startSample: number) {
    if (this.stopped) return;
    if (startSample !== this.received) throw new Error('Audio sequence was interrupted.');
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
    const when = this.nextTime > now + 0.03 ? this.nextTime : now + this.bufferMs / 1000;
    this.nextTime = when + count / SAMPLE_RATE;
    this.received += count;
    this.scheduled.push({ sample: startSample, count, when });
    this.sources.add(source);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(when);
  }
  get playedSamples() {
    if (this.stopped) return this.completed;
    const output = this.context.getOutputTimestamp?.().contextTime;
    const now = output && output > 0 ? output : Math.max(0, this.context.currentTime - (this.context.baseLatency || 0));
    while (this.scheduled.length) {
      const item = this.scheduled[0];
      if (now < item.when) return this.completed;
      if (now >= item.when + item.count / SAMPLE_RATE) {
        this.completed = item.sample + item.count;
        this.scheduled.shift();
      } else return Math.max(this.completed, item.sample + Math.floor((now - item.when) * SAMPLE_RATE));
    }
    return this.completed;
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
    this.sources.clear(); this.scheduled = [];
    await this.context.close();
  }
}
