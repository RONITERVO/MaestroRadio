import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI, type Content } from '@google/genai';
import { KeyPool } from '../server/keys.ts';
import { Planner, ContextFull } from '../server/planner.ts';
import { writerThinking, writerModels, DEFAULT_WRITER_MODEL } from '../server/writer-models.ts';
import { settingsSchema, type Plan } from '../shared/protocol.ts';

const settings = settingsSchema.parse({});
const signal = () => new AbortController().signal;
const plans: Plan[] = [
  { angle: 'Fox', newFacts: ['A fox needs a crown'], nextThread: 'Search near the cave', pairs: [{ target: 'El zorro busca una corona.', native: 'The fox is looking for a crown.' }] },
  { angle: 'Moon', newFacts: ['Moonlight reveals the cave'], nextThread: 'A gust of wind', pairs: [{ target: 'La luna brilla sobre la cueva.', native: 'The moon shines over the cave.' }] },
  { angle: 'Wind', newFacts: ['Wind moves the leaves'], nextThread: 'Footprints', pairs: [{ target: 'El viento mueve las hojas del bosque.', native: 'The wind moves the leaves in the forest.' }] },
];
const reply = (plan: Plan) => ({ text: JSON.stringify(plan), candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(plan), thoughtSignature: 'opaque-original' }] } }] });

test('Flash writers use the lowest supported thinking setting; pinning a custom model disables implicit fallbacks', () => {
  assert.deepEqual(writerThinking('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepEqual(writerThinking('gemini-3.8-flash'), { thinkingLevel: 'LOW' });
  assert.deepEqual(writerThinking('gemini-3-flash-preview'), { thinkingLevel: 'MINIMAL' });
  assert.deepEqual(writerThinking('gemini-3.1-flash-lite'), { thinkingLevel: 'MINIMAL' });
  assert.deepEqual(writerThinking('gemini-3.5-flash-lite'), { thinkingLevel: 'MINIMAL' });
  assert.equal(writerModels({}).model, DEFAULT_WRITER_MODEL);
  assert.deepEqual(writerModels({ PLANNER_MODEL: 'custom' }).fallbacks, []);
  assert.deepEqual(writerModels({ PLANNER_FALLBACK_MODELS: '' }).fallbacks, []);
  assert.deepEqual(writerModels({ PLANNER_MODEL: 'a', PLANNER_FALLBACK_MODELS: 'b,a,b' }).fallbacks, ['b']);
  assert.throws(() => writerModels({ PLANNER_TIMEOUT_MS: '0' }));
});

test('mid-episode fallback tries available keys first and preserves the complete counted ledger and signatures', async () => {
  const calls: string[] = [], changes: unknown[] = [], counted: string[] = [];
  let primaryCalls = 0, fallbackCalls = 0;
  const planner = new Planner('primary', new KeyPool(['a', 'b']), settings, 100000, key => ({ models: {
    get: async () => ({ inputTokenLimit: 100000 }),
    generateContent: async (request: { model: string; contents: Content[] }) => {
      calls.push(`${request.model}:${key}`);
      const text = JSON.stringify(request.contents);
      assert.ok(counted.includes(text));
      if (request.model === 'primary') {
        if (!primaryCalls++) return reply(plans[0]);
        throw { status: 429 };
      }
      assert.match(text, /earliest listener request/); assert.match(text, /Narration receipt/);
      assert.match(text, /opaque-original/); assert.match(text, /El zorro busca una corona/);
      return reply(plans[++fallbackCalls]);
    },
  } }) as unknown as GoogleGenAI, async request => { counted.push(JSON.stringify(request.contents)); return 500; },
  { fallbacks: ['fallback'], onSwitch: change => changes.push(change) });
  planner.observe('earliest listener request'); await planner.initialize(signal());
  await planner.next(signal(), () => {}); planner.observe('Narration receipt: the first sentence was spoken.');
  await planner.next(signal(), () => {}); await planner.next(signal(), () => {});
  assert.deepEqual(calls, ['primary:b', 'primary:a', 'primary:b', 'fallback:a', 'fallback:b']);
  assert.equal(planner.model, 'fallback'); assert.equal(changes.length, 1);
  assert.equal(planner.plans.length, 3);
});

test('fallback checks the new model context limit and stops without shortening history', async () => {
  let fallbackGenerated = false;
  const planner = new Planner('primary', new KeyPool(['a']), settings, 100000, () => ({ models: {
    get: async ({ model }: { model: string }) => ({ inputTokenLimit: model === 'primary' ? 100000 : 10000 }),
    generateContent: async ({ model }: { model: string }) => { if (model === 'fallback') fallbackGenerated = true; throw { status: 503 }; },
  } }) as unknown as GoogleGenAI, async () => 2000, { fallbacks: ['fallback'] });
  planner.observe('keep every word'); await planner.initialize(signal());
  await assert.rejects(planner.next(signal(), () => {}), ContextFull);
  assert.equal(fallbackGenerated, false); assert.match(JSON.stringify(planner.history), /keep every word/);
});

test('a response deadline moves to fallback and discards a late result', async () => {
  const planner = new Planner('slow', new KeyPool(['a']), settings, 100000, () => ({ models: {
    get: async () => ({ inputTokenLimit: 100000 }),
    generateContent: async ({ model }: { model: string }) => {
      if (model === 'slow') { await new Promise(resolve => setTimeout(resolve, 100)); return reply(plans[0]); }
      return reply(plans[1]);
    },
  } }) as unknown as GoogleGenAI, async () => 500, { fallbacks: ['fast'], timeoutMs: 20 });
  await planner.initialize(signal());
  assert.deepEqual(await planner.next(signal(), () => {}), plans[1]);
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.deepEqual(planner.plans, [plans[1]]); assert.doesNotMatch(JSON.stringify(planner.history), /El zorro busca/);
});

test('user cancellation does not start a fallback request', async () => {
  const controller = new AbortController(); let fallbackCalled = false;
  const planner = new Planner('primary', new KeyPool(['a']), settings, 100000, () => ({ models: {
    get: async () => ({ inputTokenLimit: 100000 }),
    generateContent: async ({ model }: { model: string }) => {
      if (model === 'fallback') fallbackCalled = true;
      controller.abort(); throw controller.signal.reason;
    },
  } }) as unknown as GoogleGenAI, async () => 500, { fallbacks: ['fallback'] });
  await planner.initialize(controller.signal);
  await assert.rejects(planner.next(controller.signal, () => {}), { name: 'AbortError' });
  assert.equal(fallbackCalled, false);
});

test('invalid requests do not silently move to another model', async () => {
  const generated: string[] = [];
  const planner = new Planner('primary', new KeyPool(['a']), settings, 100000, () => ({ models: {
    get: async () => ({ inputTokenLimit: 100000 }),
    generateContent: async ({ model }: { model: string }) => { generated.push(model); throw { status: 400 }; },
  } }) as unknown as GoogleGenAI, async () => 500, { fallbacks: ['fallback'] });
  await planner.initialize(signal()); await assert.rejects(planner.next(signal(), () => {}));
  assert.deepEqual(generated, ['primary']);
});

test('model metadata access failure selects a fallback with its own context limit', async () => {
  const planner = new Planner('unavailable', new KeyPool(['a']), settings, 100000, () => ({ models: {
    get: async ({ model }: { model: string }) => { if (model === 'unavailable') throw { status: 404 }; return { inputTokenLimit: 50000 }; },
    generateContent: async () => reply(plans[0]),
  } }) as unknown as GoogleGenAI, async () => 500, { fallbacks: ['available'] });
  await planner.initialize(signal());
  assert.equal(planner.model, 'available'); assert.equal(planner.limit, 50000);
  assert.deepEqual(await planner.next(signal(), () => {}), plans[0]);
});
