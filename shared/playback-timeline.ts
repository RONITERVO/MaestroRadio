import { SAMPLE_RATE } from './audio.ts';

type Segment = { sample: number; count: number; when: number };
/** Shared by the browser and real-time soak runner so both measure the same scheduling gaps. */
export class PlaybackTimeline {
  private segments: Segment[] = [];
  private completed = 0;
  private received = 0;
  private nextTime = 0;
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
    this.nextTime = when + count / SAMPLE_RATE;
    this.received += count;
    this.segments.push({ sample: startSample, count, when });
    this.stats.peakBufferedMs = Math.max(this.stats.peakBufferedMs, this.bufferedMs(now));
    return when;
  }
  playedAt(now: number) {
    while (this.segments.length) {
      const item = this.segments[0];
      if (now < item.when) return this.completed;
      if (now >= item.when + item.count / SAMPLE_RATE) {
        this.completed = item.sample + item.count; this.segments.shift();
      } else return Math.max(this.completed, item.sample + Math.floor((now - item.when) * SAMPLE_RATE));
    }
    return this.completed;
  }
  bufferedMs(now: number) {
    // Diagnostics may use the scheduling clock, slightly ahead of the speaker clock.
    // Never consume segments here: that would advance captions past actually audible output.
    let played = this.completed;
    for (const item of this.segments) {
      if (now < item.when) break;
      played = item.sample + Math.min(item.count, Math.floor((now - item.when) * SAMPLE_RATE));
      if (played < item.sample + item.count) break;
    }
    return Math.max(0, this.received - played) / SAMPLE_RATE * 1000;
  }
}
