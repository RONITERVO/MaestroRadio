import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { envKeys, safeError } from '../server/keys.ts';
import { settingsSchema, planSchema } from '../shared/protocol.ts';
import { writerInstruction } from '../server/prompts.ts';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const keys = envKeys(environment);
if (!keys.length) throw new Error('Configure a local Gemini key first.');
const settings = settingsSchema.parse({ topic: 'How bread rises. Follow one loaf through a bakery, explaining one causal step at a time.' });
const schema = z.object({ pairs: planSchema.shape.pairs, angle: planSchema.shape.angle, newFacts: planSchema.shape.newFacts, nextThread: planSchema.shape.nextThread });
const results: unknown[] = [];
for (const model of process.argv.slice(2).length ? process.argv.slice(2) : ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']) {
  const started = performance.now();
  let firstText = 0;
  let firstPair = 0;
  let raw = '';
  let usage: unknown;
  try {
    const stream = await new GoogleGenAI({ apiKey: keys[0] }).models.generateContentStream({ model,
      contents: 'Begin immediately with a concrete fact. Write a connected passage of four bilingual pairs. Put pairs first in the JSON.',
      config: { systemInstruction: writerInstruction(settings), responseMimeType: 'application/json', responseJsonSchema: z.toJSONSchema(schema),
        thinkingConfig: model.startsWith('gemini-2.5') ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.MINIMAL }, maxOutputTokens: 2048,
        httpOptions: { timeout: 60000 } },
    });
    for await (const chunk of stream) {
      if (chunk.text) { firstText ||= performance.now() - started; raw += chunk.text; }
      if (!firstPair && /"native"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/s.test(raw)) firstPair = performance.now() - started;
      usage = chunk.usageMetadata ?? usage;
    }
    const result = { model, firstTextMs: Math.round(firstText), firstPairMs: Math.round(firstPair), totalMs: Math.round(performance.now() - started), usage, plan: JSON.parse(raw) };
    results.push(result); console.log(JSON.stringify(result));
  } catch (error) { console.error(model, safeError(error)); process.exitCode = 1; }
}
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/writer-benchmark.json', JSON.stringify(results, null, 2));
