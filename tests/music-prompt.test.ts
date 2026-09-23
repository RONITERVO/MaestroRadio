import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI } from '@google/genai';
import { Planner } from '../server/planner.ts';
import { KeyPool } from '../server/keys.ts';
import { settingsSchema, linesFor, type Settings } from '../shared/protocol.ts';
import { voiceInstruction } from '../server/prompts.ts';

const prompt = 'Sparse hand-damped harp with wide space between notes, a low bassoon far back. Dry woodland texture, gently mischievous and patient. Instrumental only, no vocals or repeating hooks; leave room for a speaking voice.';
function fixture(settings: Settings, music: unknown[], invalidFirst = false) {
  const requests: any[] = [];
  const planner = new Planner('fake-model', new KeyPool(['fake-key']), settings, 100000, () => ({ models: {
    get: async () => ({ inputTokenLimit: 100000 }),
    generateContent: async (request: any) => {
      const index = requests.push(request) - 1;
      return { text: JSON.stringify({ angle: 'A new detail', newFacts: [`Fresh fact ${index}`], nextThread: 'Follow the next detail',
        pairs: [{ target: invalidFirst && index === 0 ? '[unknown] El zorro llega.' : `El zorro encuentra ${index + 1} monedas.`, native: `The fox finds ${index + 1} coins.` }],
        musicPrompt: music[index] }) };
    },
  } }) as unknown as GoogleGenAI, async () => 1000);
  const next = () => planner.next(new AbortController().signal, () => {});
  return { planner, requests, next };
}
test('auto score uses the topic, style and video examples in the normal opening request, then stays fixed', async () => {
  const settings = settingsSchema.parse({ topic: 'A fox steals a crown', style: 'A lighthearted folk story with the listener as hero' });
  assert.equal(settings.musicPrompt, '');
  const { planner, requests, next } = fixture(settings, [prompt, 'a'.repeat(50)]);
  const first = await next(), second = await next();
  assert.equal(requests.length, 2); // No separate music-planning request.
  assert.match(planner.system, /A fox steals a crown/); assert.match(planner.system, /listener as hero/);
  assert.match(planner.system, /Roman numerals:/); assert.match(planner.system, /Chess pieces:/);
  assert.ok(requests[0].config.responseJsonSchema.required.includes('musicPrompt'));
  assert.ok(!requests[1].config.responseJsonSchema.properties.musicPrompt);
  assert.equal(first.musicPrompt, prompt); assert.equal(second.musicPrompt, undefined);
  assert.doesNotMatch(voiceInstruction(linesFor(first, settings)), /harp|bassoon|musicPrompt/);
});
test('custom music and disabled music bypass automatic scoring', async () => {
  for (const settings of [settingsSchema.parse({ musicPrompt: 'My quiet guitar score' }), settingsSchema.parse({ music: false })]) {
    const { planner, requests, next } = fixture(settings, [prompt]);
    const plan = await next();
    assert.equal(plan.musicPrompt, undefined);
    assert.ok(!requests[0].config.responseJsonSchema.properties.musicPrompt);
    assert.doesNotMatch(planner.system, /EPISODE MUSIC DIRECTION/);
  }
});
test('a rejected spoken draft cannot select the score', async () => {
  const { requests, next } = fixture(settingsSchema.parse({}), ['x'.repeat(80), prompt], true);
  assert.equal((await next()).musicPrompt, prompt);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(r => r.config.responseJsonSchema.required.includes('musicPrompt')));
});
test('malformed music does not delay speech; retry on the next normal passage, bounded to three', async () => {
  const { requests, next } = fixture(settingsSchema.parse({}), [null, 123, 'short', prompt]);
  for (let i = 0; i < 4; i++) assert.equal((await next()).musicPrompt, undefined);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(r => !!r.config.responseJsonSchema.properties.musicPrompt), [true, true, true, false]);
  const recovered = fixture(settingsSchema.parse({}), [null, prompt]);
  assert.equal((await recovered.next()).musicPrompt, undefined);
  assert.equal((await recovered.next()).musicPrompt, prompt);
  assert.equal(recovered.requests.length, 2);
});
