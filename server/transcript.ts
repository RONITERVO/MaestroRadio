import type { Cue, Line } from '../shared/protocol.ts';
import { fingerprint } from './planner.ts';

type Token = { text: string; key: string; line: number };
function tokens(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text), s => s.segment);
}
/** Align only for line placement. Displayed text ALWAYS comes from outputTranscription. */
export class TranscriptClock {
  raw = '';
  private tail = '';
  private cursor = 0;
  private line = 0;
  private anchor = 0;
  private waiting: { text: string; line: number }[] = [];
  private expected: Token[];
  private matched = new Set<number>();
  readonly cues: Cue[] = [];
  constructor(private lines: Line[], private emit: (cue: Cue) => void) {
    this.expected = lines.flatMap((line, index) => tokens(line.text).filter(t => fingerprint(t)).map(text => ({ text, key: fingerprint(text), line: index })));
  }
  add(fragment: string, samples: number) {
    this.raw += fragment;
    this.tail += fragment;
    this.consume(false);
    this.flush(samples);
  }
  audio(samples: number) { this.flush(samples); }
  finish(samples: number) { this.consume(true); this.flush(samples, true); }
  get coverage() { return this.matched.size / Math.max(1, this.expected.length); }
  get lineCoverage() {
    return this.lines.map((_, line) => {
      const indexes = this.expected.flatMap((token, i) => token.line === line ? [i] : []);
      return indexes.filter(i => this.matched.has(i)).length / Math.max(1, indexes.length);
    });
  }
  private consume(final: boolean) {
    // Preserve incomplete language markers and incomplete final words across network fragments.
    let text = this.tail;
    let safeEnd = text.length;
    const bracket = text.lastIndexOf('[');
    if (!final && bracket > text.lastIndexOf(']')) safeEnd = bracket;
    if (!final) {
      const last = Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text.slice(0, safeEnd))).at(-1);
      if (last?.isWordLike) safeEnd = last.index;
    }
    this.tail = text.slice(safeEnd);
    text = text.slice(0, safeEnd).replace(/\[[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\]/g, '');
    for (const token of tokens(text)) {
      const key = fingerprint(token);
      if (key) {
        let match = -1;
        // A small forward-only search tolerates punctuation and a missed word without jumping paragraphs.
        for (let i = this.cursor; i < Math.min(this.expected.length, this.cursor + 16); i++) {
          if (this.expected[i].key === key) { match = i; break; }
        }
        if (match >= 0) { this.line = this.expected[match].line; this.cursor = match + 1; this.matched.add(match); }
      }
      const clean = token.replace(/[\r\n\t]+/g, ' ');
      if (clean) this.waiting.push({ text: clean, line: this.line });
    }
  }
  private flush(samples: number, final = false) {
    if (!this.waiting.length || (samples <= this.anchor && !final)) return;
    // Arrival-anchored intervals, never rescaled to total clip duration. No guessed future samples.
    const end = Math.max(this.anchor, samples);
    const weight = this.waiting.reduce((sum, item) => sum + item.text.length, 0);
    let consumed = 0;
    for (const item of this.waiting) {
      const cue: Cue = { ...item, kind: this.lines[item.line]?.kind ?? 'target', observedAtSample: samples,
        startSample: Math.round(this.anchor + (end - this.anchor) * consumed / weight),
        endSample: Math.round(this.anchor + (end - this.anchor) * (consumed + item.text.length) / weight) };
      consumed += item.text.length;
      this.cues.push(cue); this.emit(cue);
    }
    this.anchor = end;
    this.waiting = [];
  }
}
