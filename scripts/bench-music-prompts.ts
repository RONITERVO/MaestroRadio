import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { KeyPool, envKeys, safeError } from '../server/keys.ts';
import { Planner } from '../server/planner.ts';
import { writerModels } from '../server/writer-models.ts';
import { settingsSchema } from '../shared/protocol.ts';

// Finite, opt-in live check: three ordinary opening passages, no audio generation.
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const pool = new KeyPool(envKeys(environment));
if (!pool.size) throw new Error('Configure a local Gemini key first.');
const routing = writerModels(process.env);
const cases = [
  { topic: 'How a coral reef changes after sunset. Follow a parrotfish finding shelter.', style: 'Intimate, curious science documentary' },
  { topic: 'You must obtain a permit to borrow a dragon from the village library.', style: 'The listener is the hero of an absurdly bureaucratic folk comedy' },
  { topic: 'How early printers arranged movable type by hand, beginning with one letter.', style: 'A quiet observational visit to a working print shop' },
];
const results: unknown[] = [];
for (const input of cases) {
  const planner = new Planner(routing.model, pool, settingsSchema.parse(input), 1048576, undefined, undefined, routing);
  const started = Date.now();
  try {
    const plan = await planner.next(AbortSignal.timeout(60000), () => {});
    const result = { ...input, model: planner.model, elapsedMs: Date.now() - started, prompt: plan.musicPrompt,
      words: plan.musicPrompt?.split(/\s+/).length ?? 0, opening: plan.pairs[0], usedTokens: planner.used,
      generationResponses: planner.history.filter(item => item.role === 'model').length };
    results.push(result); console.log(JSON.stringify(result));
    if (!plan.musicPrompt) process.exitCode = 1;
  } catch (error) { const result = { ...input, error: safeError(error) }; results.push(result); console.log(JSON.stringify(result)); process.exitCode = 1; }
}
mkdirSync('test-results/music', { recursive: true });
writeFileSync('test-results/music/automatic-prompts.json', JSON.stringify(results, null, 2));
