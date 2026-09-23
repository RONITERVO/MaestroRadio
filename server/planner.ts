import { GoogleGenAI, type Content } from '@google/genai';
import { z } from 'zod';
import { planSchema, type Plan, type Settings } from '../shared/protocol.ts';
import { KeyPool, PublicError } from './keys.ts';
import { writerInstruction } from './prompts.ts';
import { countFullRequest } from './tokens.ts';

export class ContextFull extends PublicError {}
export function fingerprint(text: string) { return text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function repetitionReason(plan: Plan, previous: Plan[]): string | null {
  const angles = new Set(previous.map(p => fingerprint(p.angle)));
  const facts = new Set(previous.flatMap(p => p.newFacts.map(fingerprint)));
  const sentences = previous.flatMap(p => p.pairs.map(pair => fingerprint(pair.target)));
  if (angles.has(fingerprint(plan.angle))) return 'This angle was already covered.';
  if (plan.newFacts.some(f => facts.has(fingerprint(f)))) return 'A claimed new fact was already covered.';
  const seen = new Set(sentences);
  for (const pair of plan.pairs) {
    const sentence = fingerprint(pair.target);
    if (seen.has(sentence)) return 'A target sentence repeats earlier content.';
    const words = new Set(sentence.split(' '));
    for (const old of sentences) {
      const oldWords = new Set(old.split(' '));
      const overlap = [...words].filter(w => oldWords.has(w)).length;
      if (words.size > 7 && overlap / new Set([...words, ...oldWords]).size > 0.85) return 'A sentence is nearly identical to an earlier one.';
    }
    seen.add(sentence);
  }
  return null;
}
export class Planner {
  readonly history: Content[] = [];
  readonly plans: Plan[] = [];
  used = 0;
  limit = 0;
  cumulativeInput = 0;
  cumulativeOutput = 0;
  readonly system: string;
  constructor(readonly model: string, readonly pool: KeyPool, settings: Settings, readonly ceiling: number,
    private client = (key: string) => new GoogleGenAI({ apiKey: key }), private counter = countFullRequest) {
    this.system = writerInstruction(settings);
  }
  async initialize(signal: AbortSignal) {
    const metadata = await this.pool.run(key => this.client(key).models.get({ model: this.model, config: { abortSignal: signal, httpOptions: { timeout: 30_000 } } }), signal);
    if (!metadata.inputTokenLimit) throw new PublicError('Gemini did not report the planner context limit. Refusing to discard episode history.');
    this.limit = Math.min(metadata.inputTokenLimit, this.ceiling);
  }
  observe(text: string) { this.history.push({ role: 'user', parts: [{ text }] }); }
  async next(signal: AbortSignal, onContext: () => void): Promise<Plan> {
    this.observe(this.plans.length ? 'Continue with the next fresh passage. Use all preceding plans and narration receipts. The most recent planned passage may still be speaking; continue after its script without repeating it.' : 'Begin the podcast with a vivid, specific detail.');
    for (let repair = 0; repair < 3; repair++) {
      const response = await this.pool.run(async key => {
        const ai = this.client(key);
        // A voice receipt can arrive during this request. Count and generate from the SAME immutable snapshot.
        const contents = structuredClone(this.history);
        this.used = await this.counter({ key, model: this.model, contents, system: this.system, signal });
        onContext();
        // Reserve output plus schema/serialization overhead and the final narration receipt.
        if (this.used + 8192 >= this.limit) throw new ContextFull('The episode reached its full-memory context limit.');
        return ai.models.generateContent({
          model: this.model, contents,
          config: { systemInstruction: this.system, responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(planSchema),
            temperature: 0.9, maxOutputTokens: 4096, abortSignal: signal, httpOptions: { timeout: 60_000 } },
        });
      }, signal);
      this.cumulativeInput += response.usageMetadata?.promptTokenCount ?? this.used;
      this.cumulativeOutput += (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0);
      onContext();
      const raw = response.text ?? '';
      // Preserve provider content, including any thought signatures needed by later requests.
      this.history.push(response.candidates?.[0]?.content ?? { role: 'model', parts: [{ text: raw || '(No text returned)' }] });
      let reason = 'Return valid JSON matching the schema. Keep sentences short and return at most four bilingual pairs.';
      try {
        const plan = planSchema.parse(JSON.parse(raw));
        const repeat = repetitionReason(plan, this.plans);
        if (!repeat) { this.plans.push(plan); return plan; }
        reason = `${repeat} Choose a different concrete fact and example. Do not paraphrase the repeated material.`;
      } catch { /* Invalid structured response: bounded repair with full history. */ }
      this.observe(`This draft was NOT narrated. Repair required: ${reason}`);
    }
    throw new PublicError('The writer repeated itself or returned invalid passages three times. Episode stopped with its history intact.');
  }
}
