import { GoogleGenAI, type Content } from '@google/genai';
import { z } from 'zod';
import { planSchema, musicPromptSchema, type Plan, type Settings } from '../shared/protocol.ts';
import { KeyPool, PublicError, KeysUnavailable, errorStatus, safeError } from './keys.ts';
import { writerInstruction } from './prompts.ts';
import { countFullRequest } from './tokens.ts';
import { languageReason } from './languages.ts';
import { stripVoiceTags, hasVoiceTags, invalidVoiceTag } from '../shared/voice-tags.ts';
import { writerThinking } from './writer-models.ts';

export class ContextFull extends PublicError {}
export type PlannerRouting = { fallbacks?: string[]; timeoutMs?: number; onSwitch?: (change: { from: string; to: string; reason: string }) => void };
function abortable<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    request.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
export function fingerprint(text: string) { return stripVoiceTags(text).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function repetitionReason(plan: Plan, previous: Plan[]): string | null {
  const facts = new Set(previous.flatMap(p => p.newFacts.map(fingerprint)));
  const sentences = previous.flatMap(p => p.pairs.map(pair => fingerprint(pair.target)));
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
  private models: string[];
  private limits = new Map<string, number>();
  private musicChosen = false;
  constructor(public model: string, private keys: KeyPool, private settings: Settings, readonly ceiling: number,
    private client = (key: string) => new GoogleGenAI({ apiKey: key }), private counter = countFullRequest, private routing: PlannerRouting = {}) {
    this.models = [...new Set([model, ...(routing.fallbacks ?? [])])];
    this.system = writerInstruction(settings);
  }
  get pool() { return this.keys.forModel(this.model); }
  private async modelLimit(model: string, key: string, signal: AbortSignal) {
    let limit = this.limits.get(model);
    if (!limit) {
      const metadata = await this.client(key).models.get({ model, config: { abortSignal: signal, httpOptions: { timeout: 30_000 } } });
      if (!metadata.inputTokenLimit) throw new PublicError('Gemini did not report the planner context limit. Refusing to discard episode history.');
      limit = Math.min(metadata.inputTokenLimit, this.ceiling); this.limits.set(model, limit);
    }
    return limit;
  }
  private async withModels<T>(operation: (model: string, key: string, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    let lastError: unknown;
    const order = [this.model, ...this.models.filter(model => model !== this.model)];
    for (const model of order) {
      signal.throwIfAborted();
      const deadline = AbortSignal.timeout(this.routing.timeoutMs ?? 60_000);
      const attemptSignal = AbortSignal.any([signal, deadline]);
      try {
        const result = await abortable(this.keys.forModel(model).run(key => operation(model, key, attemptSignal), attemptSignal, () => true, order.length > 1 ? 0 : 60_000), attemptSignal);
        if (this.model !== model) {
          const from = this.model; this.model = model;
          this.routing.onSwitch?.({ from, to: model, reason: lastError ? safeError(lastError) : 'Model availability changed.' });
        }
        this.limit = this.limits.get(model)!;
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ContextFull) throw error;
        if (deadline.aborted) lastError = new PublicError(`The writer ${model} exceeded its response deadline.`);
        else if (error instanceof KeysUnavailable || [401, 403, 404, 429, 500, 502, 503, 504].includes(errorStatus(error))) lastError = error;
        else throw error;
      }
    }
    throw lastError;
  }
  async initialize(signal: AbortSignal) {
    await this.withModels((model, key, attemptSignal) => this.modelLimit(model, key, attemptSignal), signal);
  }
  observe(text: string) { this.history.push({ role: 'user', parts: [{ text }] }); }
  async next(signal: AbortSignal, onContext: () => void): Promise<Plan> {
    const wantsMusic = this.settings.music && !this.settings.musicPrompt && !this.musicChosen && this.plans.length < 3;
    const responseSchema = planSchema.omit({ musicPrompt: true }).extend({
      angle: planSchema.shape.angle.describe('A short title for the NEW development in this passage. Do not copy the requested style or overall topic.'),
      pairs: z.array(z.object({
        target: z.string().min(1).max(300).describe(`The sentence in ${this.settings.target.name}, spoken FIRST.`),
        native: z.string().min(1).max(400).describe(`Faithful translation into ${this.settings.native.name}, spoken SECOND.`),
      })).min(1).max(4),
      ...(wantsMusic ? { musicPrompt: musicPromptSchema.describe('Original 45–85 word instrumental score direction tailored to this episode; production metadata only.') } : {}),
    });
    this.observe(this.plans.length ? 'Continue with the next fresh passage. Use all preceding plans and narration receipts. The most recent planned passage may still be speaking; continue after its script without repeating it.' : 'Begin directly in the requested style, or with a specific fact if none is specified. Keep the first target sentence especially concise, about 8–12 words, with a compact faithful translation. Then develop that thought in the remaining pairs.');
    for (let repair = 0; repair < 3; repair++) {
      // All model/key attempts use the same complete snapshot, with provider signatures intact.
      const contents = structuredClone(this.history);
      const response = await this.withModels(async (model, key, attemptSignal) => {
        const ai = this.client(key);
        const limit = await this.modelLimit(model, key, attemptSignal);
        attemptSignal.throwIfAborted();
        const used = await this.counter({ key, model, contents, system: this.system, signal: attemptSignal });
        attemptSignal.throwIfAborted();
        this.limit = limit; this.used = used;
        onContext();
        // Reserve output plus schema/serialization overhead and the final narration receipt.
        if (this.used + 8192 >= this.limit) throw new ContextFull('The episode reached its full-memory context limit.');
        return ai.models.generateContent({
          model, contents,
          config: { systemInstruction: this.system, responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(responseSchema),
            thinkingConfig: writerThinking(model),
            temperature: 0.8, maxOutputTokens: 2048, abortSignal: attemptSignal, httpOptions: { timeout: this.routing.timeoutMs ?? 60_000 } },
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
        const data = JSON.parse(raw);
        // A malformed music field must never discard valid speech. Ask again in the
        // next normal passage (up to three), without an extra request or startup wait.
        const plan: Plan = planSchema.omit({ musicPrompt: true }).parse(data);
        const music = musicPromptSchema.safeParse(data.musicPrompt);
        const texts = plan.pairs.flatMap(pair => [pair.target, pair.native]);
        if (texts.some(text => invalidVoiceTag(text) || (!this.settings.expressive && hasVoiceTags(text)))) {
          reason = this.settings.expressive ? 'Use only the permitted audible vocal tags. Remove all other bracketed directions.' : 'Remove all bracketed vocal tags; expressive voice is disabled.';
          this.observe(`This draft was NOT narrated. Repair required: ${reason}`); continue;
        }
        const language = languageReason(plan, this.settings);
        const repeat = repetitionReason(plan, this.plans);
        if (!language && !repeat) {
          if (wantsMusic && music.success) { plan.musicPrompt = music.data; this.musicChosen = true; }
          this.plans.push(plan); return plan;
        }
        reason = language || `${repeat} Choose a different concrete fact and example. Do not paraphrase the repeated material.`;
      } catch { /* Invalid structured response: bounded repair with full history. */ }
      this.observe(`This draft was NOT narrated. Repair required: ${reason}`);
    }
    throw new PublicError('The writer repeated itself or returned invalid passages three times. Episode stopped with its history intact.');
  }
}
