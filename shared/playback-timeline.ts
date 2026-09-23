import { SAMPLE_RATE } from './audio.ts';

export type Segment = { sample: number; count: number; when: number; rate: number; chunkStart: number };
/** Shared by the browser and real-time soak runner so both measure the same scheduling gaps. */
export class PlaybackTimeline {
  private segments: Segment[] = [];
  private completed = 0;
  private received = 0;
  private nextTime = 0;
  rate = 1;
  private lastPlayed = 0;
  readonly stats = { firstStartSeconds: 0, underruns: 0, totalGapMs: 0, maxGapMs: 0, peakBufferedMs: 0 };
  constructor(private bufferMs: number) {}
  add(startSample: number, count: number, now: number) {
    if (startSample !== this.received) throw new Error('Audio sequence was interrupted.');
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('Invalid audio chunk length.');
    const first = this.received === 0;
    // Retain the initial transcription buffer. A late packet needs only a small scheduling lead,
    // rather than inserting another full startup delay into an otherwise continuous passage.
    const when = first ? now + this.bufferMs / 1000 : this.nextTime >= now + 0.005 ? this.nextTime : now + 0.04;
    if (first) this.stats.firstStartSeconds = when;
    else {
      const gapMs = Math.max(0, (when - this.nextTime) * 1000);
      if (gapMs > 5) { this.stats.underruns++; this.stats.totalGapMs += gapMs; this.stats.maxGapMs = Math.max(this.stats.maxGapMs, gapMs); }
    }
    this.nextTime = when + count / SAMPLE_RATE / this.rate;
    this.received += count;
    this.segments.push({ sample: startSample, chunkStart: startSample, count, when, rate: this.rate });
    this.stats.peakBufferedMs = Math.max(this.stats.peakBufferedMs, this.bufferedMs(now));
    return when;
  }
  playedAt(now: number) {
    this.lastPlayed = Math.floor(Math.max(this.lastPlayed, this.positionAt(now)));
    return this.lastPlayed;
  }
  private positionAt(now: number) {
    while (this.segments.length) {
      const item = this.segments[0];
      if (now < item.when) return this.completed;
      if (now >= item.when + item.count / SAMPLE_RATE / item.rate) {
        this.completed = item.sample + item.count; this.segments.shift();
      } else return Math.max(this.completed, Math.floor(item.sample + (now - item.when) * SAMPLE_RATE * item.rate));
    }
    return this.completed;
  }
  bufferedMs(now: number) {
    // Diagnostics may use the scheduling clock, slightly ahead of the speaker clock.
    // Never consume segments here: that would advance captions past actually audible output.
    let seconds = 0;
    for (const item of this.segments) {
      const duration = item.count / SAMPLE_RATE / item.rate;
      seconds += Math.max(0, duration - Math.max(0, now - item.when));
    }
    return seconds * 1000;
  }
  /** Retain old clock segments; reschedule only source samples at/after the shared audio pivot. */
  setRate(rate: number, pivot: number): Segment[] {
    if (!Number.isFinite(rate) || rate < 1 || rate > 2) throw new Error('Playback speed must be between 1× and 2×.');
    const past: Segment[] = [], future: Segment[] = [];
    let when = Math.max(pivot, this.segments.find(s => s.when + s.count / SAMPLE_RATE / s.rate > pivot)?.when ?? pivot);
    for (const item of this.segments) {
      const elapsed = Math.max(0, Math.min(item.count, (pivot - item.when) * SAMPLE_RATE * item.rate));
      if (elapsed >= item.count) { past.push(item); continue; }
      if (elapsed > 0) past.push({ ...item, count: elapsed });
      const next = { ...item, sample: item.sample + elapsed, count: item.count - elapsed, when, rate };
      future.push(next); when += next.count / SAMPLE_RATE / rate;
    }
    this.rate = rate;
    this.segments = [...past, ...future];
    if (future.length) this.nextTime = when;
    this.stats.peakBufferedMs = Math.max(this.stats.peakBufferedMs, this.bufferedMs(pivot));
    return future;
  }
}
