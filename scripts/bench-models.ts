/** Finite comparison through the real planner: two cases, two consecutive passages per model. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { envKeys, KeyPool, safeError, errorStatus } from '../server/keys.ts';
import { Planner } from '../server/planner.ts';
import { settingsSchema } from '../shared/protocol.ts';
import { writerThinking } from '../server/writer-models.ts';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const env = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const keys = envKeys(env);
if (!keys.length) throw new Error('Configure Gemini keys first.');
const models = process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];
const cases = [
  { name: 'bread-es-en', settings: settingsSchema.parse({ topic: 'Follow one loaf through a bakery, explaining how yeast makes it rise.' }) },
  { name: 'folk-tale-es-fi', settings: settingsSchema.parse({ topic: 'A nervous fox needs your help to recover a missing crown.', native: { name: 'Finnish', code: 'fi-FI' },
    style: 'A funny folk tale in second person: the listener is the main character. Develop one causal story with gentle humor.', expressive: true }) },
];
const offset = Number(process.env.BENCH_KEY_OFFSET || 0);
if (!Number.isInteger(offset) || offset < 0 || offset >= keys.length) throw new Error('BENCH_KEY_OFFSET must select a configured key (zero-based).');
const jobs = models.flatMap(model => cases.map((testCase, index) => ({ model, testCase, keyIndex: (index + offset) % keys.length })));
const folder = resolve('test-results', `model-comparison-${Date.now()}`); mkdirSync(folder, { recursive: true });
const results: unknown[] = [];
async function worker() {
  while (jobs.length) {
    const { model, testCase, keyIndex } = jobs.shift()!;
    const planner = new Planner(model, new KeyPool([keys[keyIndex]]), testCase.settings, 1048576);
    const passages: unknown[] = [];
    let failure: unknown;
    let stage = 'metadata';
    let stageStart = performance.now();
    try {
      await planner.initialize(AbortSignal.timeout(20000));
      for (let turn = 0; turn < 2; turn++) {
        stage = `passage-${turn}`;
        stageStart = performance.now();
        const start = performance.now(), priorInput = planner.cumulativeInput, priorOutput = planner.cumulativeOutput;
        const plan = await planner.next(AbortSignal.timeout(65000), () => {});
        const result = { turn, elapsedMs: Math.round(performance.now() - start), inputTokens: planner.cumulativeInput - priorInput,
          outputTokens: planner.cumulativeOutput - priorOutput, plan };
        passages.push(result);
        console.log(JSON.stringify({ model, case: testCase.name, keyNumber: keyIndex + 1, ...result }));
      }
    } catch (error) {
      failure = { stage, elapsedMs: Math.round(performance.now() - stageStart), status: errorStatus(error), message: safeError(error) };
      console.log(JSON.stringify({ model, case: testCase.name, failure }));
    }
    const result = { model, case: testCase.name, keyNumber: keyIndex + 1, thinking: writerThinking(model), passages, failure,
      system: planner.system, history: planner.history };
    results.push(result); writeFileSync(resolve(folder, 'results.json'), JSON.stringify(results, null, 2));
  }
}
await Promise.all([worker(), worker()]);
console.log(`Comparison evidence: ${folder}`);
