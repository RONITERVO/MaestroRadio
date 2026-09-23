import { SAMPLE_RATE } from '../shared/audio.ts';
import { PlaybackTimeline } from '../shared/playback-timeline.ts';

/** One AudioContext per listening gesture. Captions follow its output clock, including pauses and underruns. */
export class StreamPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private buffers = new Map<number, { buffer: AudioBuffer; source: AudioBufferSourceNode }>();
  private pitch?: Awaited<ReturnType<typeof import('./pitch.ts')['createPitch']>>;
  private timeline: PlaybackTimeline;
  private completed = 0;
  private mixer?: AudioWorkletNode;
  private musicNext = 0;
  private musicSources = new Set<AudioBufferSourceNode>();
  private musicVolume = 0.6;
  stopped = false;
  paused = false;
  constructor(bufferMs: number, readonly context = new AudioContext({ latencyHint: 'playback' })) { this.timeline = new PlaybackTimeline(bufferMs); }
  get rate() { return this.timeline.rate; }
  get diagnostics() { return { ...this.timeline.stats, bufferedMs: this.timeline.bufferedMs(this.context.currentTime) }; }
  async unlock() {
    await this.context.resume();
    this.pitch = await (await import('./pitch.ts')).createPitch(this.context);
    const { default: mixerUrl } = await import('./mix-processor.ts?worker&url');
    await this.context.audioWorklet.addModule(mixerUrl);
    this.mixer = new AudioWorkletNode(this.context, 'maestro-radio-mix', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2] });
    this.mixer.connect(this.context.destination);
    this.pitch.input.connect(this.mixer, 0, 0);
    this.setMusicVolume(this.musicVolume);
    this.pitch.setRate(this.rate, this.context.currentTime);
  }
  get musicBufferedSeconds() { return Math.max(0, this.musicNext - this.context.currentTime); }
  setMusicVolume(value: number) { this.musicVolume = Math.max(0, Math.min(1, value)); this.mixer?.parameters.get('musicVolume')?.setTargetAtTime(this.musicVolume, this.context.currentTime, 0.1); }
  addMusic(data: string, rate: number, channels: number) {
    if (this.stopped || !this.mixer) return;
    if (![44100, 48000].includes(rate) || channels !== 2) throw new Error('Unsupported music format');
    const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
    if (bytes.length % (channels * 2)) throw new Error('Invalid music PCM');
    if (this.musicBufferedSeconds > 30) return;
    const frames = bytes.length / (channels * 2);
    if (!frames) return;
    const view = new DataView(bytes.buffer);
    const buffer = this.context.createBuffer(channels, frames, rate);
    for (let c = 0; c < channels; c++) {
      const target = buffer.getChannelData(c);
      for (let f = 0; f < frames; f++) target[f] = view.getInt16((f * channels + c) * 2, true) / 32768;
    }
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.mixer, 0, 1);
    this.musicSources.add(source);
    source.onended = () => { source.disconnect(); this.musicSources.delete(source); };
    this.musicNext = Math.max(this.musicNext, this.context.currentTime + (this.musicNext ? 0.04 : 1.2));
    source.start(this.musicNext); this.musicNext += buffer.duration;
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
    for (const source of this.musicSources) { try { source.stop(); } catch {} }
    this.musicSources.clear(); this.mixer?.disconnect();
    this.buffers.clear(); this.pitch?.stop();
    await this.context.close();
  }
}
