import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleGenAI, LiveServerMessage, type Content, type Session, type LiveConnectParameters } from '@google/genai';
import { envKeys, KeyPool, safeError } from '../server/keys.ts';
import { ContextFull, Planner, repetitionReason } from '../server/planner.ts';
import { TranscriptClock } from '../server/transcript.ts';
import { narrate, liveConfig } from '../server/live.ts';
import { PlaybackGate } from '../server/episode.ts';
import { countFullRequest } from '../server/tokens.ts';
import { linesFor, settingsSchema, type Cue, type Plan } from '../shared/protocol.ts';

const settings = settingsSchema.parse({});
const plan: Plan = { angle: 'Water rises in trees', newFacts: ['Leaves release water vapor'], nextThread: 'Explore roots',
  pairs: [{ target: 'Las hojas liberan agua.', native: 'Leaves release water.' }, { target: 'Las raíces absorben agua.', native: 'Roots absorb water.' }] };
const signal = () => new AbortController().signal;

test('loads and deduplicates arbitrarily numbered env keys', () => {
  assert.deepEqual(envKeys({ GEMINI_API_KEYS: 'one,two;one\nthree', GEMINI_API_KEY: 'four', GEMINI_API_KEY48: 'five', GEMINI_API_KEY_999: 'six', GOOGLE_API_KEY: 'one', UNRELATED_KEY: 'secret' }), ['one','two','three','four','five','six']);
});
test('key failures rotate; partial output makes failures non-retryable', async () => {
  const pool = new KeyPool(['one', 'two']);
  const used: string[] = [];
  assert.equal(await pool.run(async key => { used.push(key); if (key === 'one') throw { status: 403 }; return 'ok'; }, signal()), 'ok');
  assert.deepEqual(used, ['one','two']);
  let calls = 0;
  await assert.rejects(new KeyPool(['a','b']).run(async () => { calls++; throw new Error('503'); }, signal(), () => false));
  assert.equal(calls, 1);
});
test('provider error details cannot disclose keys', () => {
  assert.doesNotMatch(safeError(new Error('request to https://example.com?key=secret failed')), /secret|example/);
});
test('obvious repeats are rejected, different new facts pass', () => {
  assert.ok(repetitionReason(plan, [plan]));
  assert.equal(repetitionReason({ ...plan, angle: 'Tree bark', newFacts: ['Bark protects the tree'], pairs: [{ target: 'La corteza protege al árbol.', native: 'Bark protects the tree.' }] }, [plan]), null);
});
test('full ledger and system are counted before generation; stop before overflow', async () => {
  let generated = 0;
  let seenHistory: Content[] = [];
  const fake = { models: {
    get: async () => ({ inputTokenLimit: 100_000 }),
    countTokens: async (request: { contents: Content[]; config: { systemInstruction: string } }) => {
      seenHistory = request.contents; assert.match(request.config.systemInstruction, /COMPLETE episode ledger/); return { totalTokens: 93_000 };
    },
    generateContent: async () => { generated++; return {}; },
  } } as unknown as GoogleGenAI;
  const planner = new Planner('test', new KeyPool(['key']), settings, 200_000, () => fake, async request => {
    seenHistory = request.contents; assert.match(request.system, /COMPLETE episode ledger/); return 93_000;
  });
  planner.observe('The very first fact remains here.');
  await planner.initialize(signal());
  await assert.rejects(planner.next(signal(), () => {}), ContextFull);
  assert.equal(generated, 0); assert.equal(planner.limit, 100_000);
  assert.match(JSON.stringify(seenHistory), /very first fact/);
});
test('rejected repeated drafts remain in memory and bounded repair advances', async () => {
  let count = 0;
  const next = { ...plan, angle: 'A new angle', newFacts: ['A new fact'], pairs: [{ target: 'El sol calienta las hojas.', native: 'The sun warms the leaves.' }] };
  const fake = { models: { get: async () => ({ inputTokenLimit: 100_000 }), countTokens: async () => ({ totalTokens: 500 }),
    generateContent: async () => ({ text: JSON.stringify(count++ ? next : plan), usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100 } }) } } as unknown as GoogleGenAI;
  const planner = new Planner('test', new KeyPool(['key']), settings, 100_000, () => fake, async () => 500);
  planner.plans.push(plan); await planner.initialize(signal());
  assert.deepEqual(await planner.next(signal(), () => {}), next);
  assert.match(JSON.stringify(planner.history), /NOT narrated/);
  assert.equal(planner.cumulativeInput, 1000);
});
test('split transcript fragments and split markers preserve actual words and bilingual rows', () => {
  const cues: Cue[] = [];
  const clock = new TranscriptClock(linesFor(plan, settings), cue => cues.push(cue));
  clock.add('[es-', 0); clock.add('ES] Las ho', 2400); clock.add('jas liberan agua.\n\n[en-US] Leaves release water.', 48000);
  clock.finish(48000);
  assert.equal(cues.map(c => c.text).join('').trim().replace(/\s+/g, ' '), 'Las hojas liberan agua. Leaves release water.');
  assert.ok(cues.some(c => c.line === 1 && c.kind === 'native'));
  assert.ok(cues.every(c => c.endSample <= 48000 && c.startSample <= c.endSample));
});
test('never fabricates planned text or rescales old timestamps at completion', () => {
  const cues: Cue[] = [];
  const clock = new TranscriptClock(linesFor(plan, settings), cue => cues.push(cue));
  clock.add('Actually spoken. ', 2400);
  const before = JSON.stringify(cues);
  clock.finish(240000);
  assert.equal(JSON.stringify(cues), before);
  assert.doesNotMatch(cues.map(c => c.text).join(''), /Las hojas/);
  assert.equal(new TranscriptClock(linesFor(plan, settings), () => {}).coverage, 0);
});
test('text before audio is held until actual samples exist; CJK fragments survive', () => {
  const cues: Cue[] = [];
  const clock = new TranscriptClock([{ text: '你好世界。', code: 'cmn-CN', kind: 'target' }], c => cues.push(c));
  clock.add('你好世界。', 0); assert.equal(cues.length, 0);
  clock.audio(12000); clock.finish(12000);
  assert.equal(cues.map(c => c.text).join(''), '你好世界。');
});
test('backpressure respects pauses and rejects impossible forward playback claims', () => {
  const gate = new PlaybackGate();
  assert.equal(gate.canProduce(13 * 24000), false);
  gate.update(9999999, true, 24000); assert.equal(gate.played, 24000); assert.equal(gate.canProduce(24000), false);
  gate.update(0, false, 24000); assert.equal(gate.played, 24000); assert.equal(gate.canProduce(24000), true);
});
test('Live model thinking config is family aware and has no line quota', () => {
  const legacy = liveConfig('gemini-2.5-flash-native-audio-preview-12-2025', 'Kore', linesFor(plan, settings));
  assert.deepEqual(legacy.thinkingConfig, { thinkingBudget: 0 });
  assert.equal(liveConfig('gemini-3.8-live', 'Kore', []).thinkingConfig, undefined);
  assert.doesNotMatch(String(legacy.systemInstruction), /four|eight|4 lines|8 lines/);
});
test('Live processes every audio part and transcript in the same event before turn completion', async () => {
  const audio: number[] = []; const cues: Cue[] = []; let closed = 0;
  const result = await narrate({ key: 'test', model: 'test', voice: 'Kore', lines: linesFor(plan, settings), signal: signal(),
    onAudio: (_data, sample) => audio.push(sample), onCue: cue => cues.push(cue),
    connect: async ({ callbacks }: LiveConnectParameters) => ({ close: () => closed++, sendClientContent() {
      const message = new LiveServerMessage();
      message.serverContent = { modelTurn: { parts: [
        { inlineData: { data: Buffer.alloc(4800).toString('base64'), mimeType: 'audio/pcm;rate=24000' } },
        { inlineData: { data: Buffer.alloc(4800).toString('base64'), mimeType: 'audio/pcm;rate=24000' } },
      ] }, outputTranscription: { text: 'Las hojas liberan agua.' }, turnComplete: true };
      callbacks.onmessage!(message);
    } } as unknown as Session),
  });
  assert.deepEqual(audio, [0, 2400]); assert.equal(result.samples, 4800); assert.equal(closed, 1); assert.ok(cues.length);
});
test('Live closes a late connection after cancellation without sending a turn', async () => {
  const controller = new AbortController(); let closed = 0; let sent = 0;
  let resolveConnect!: (value: Session) => void;
  const pending = narrate({ key: 'test', model: 'test', voice: 'Kore', lines: [], signal: controller.signal, onAudio() {}, onCue() {},
    connect: () => new Promise(resolve => { resolveConnect = resolve; }) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolveConnect({ close: () => closed++, sendClientContent: () => sent++ } as unknown as Session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(sent, 0);
});
test('REST token count includes system and every ledger message without putting keys in the URL', async () => {
  const count = await countFullRequest({ key: 'secret', model: 'models/gemini-test', contents: [{ role: 'user', parts: [{ text: 'earliest fact' }] }], system: 'full instructions', signal: signal() },
    async (url, options) => {
      assert.doesNotMatch(String(url), /secret/);
      const body = JSON.parse(String(options?.body));
      assert.equal(body.generateContentRequest.systemInstruction.parts[0].text, 'full instructions');
      assert.equal(body.generateContentRequest.contents[0].parts[0].text, 'earliest fact');
      return new Response(JSON.stringify({ totalTokens: 42 }), { status: 200 });
    });
  assert.equal(count, 42);
});
test('one missing translation is detected independently of overall coverage', () => {
  const clock = new TranscriptClock(linesFor(plan, settings), () => {});
  clock.add('Las hojas liberan agua. Leaves release water. Las raíces absorben agua.', 48000);
  clock.finish(48000);
  assert.ok(clock.coverage >= 0.7);
  assert.equal(clock.lineCoverage[3], 0);
});
test('in-flight narration receipts cannot change the request after counting', async () => {
  let planner: Planner;
  const fake = { models: { get: async () => ({ inputTokenLimit: 100_000 }), generateContent: async (request: { contents: Content[] }) => {
    assert.doesNotMatch(JSON.stringify(request.contents), /late receipt/);
    return { text: JSON.stringify(plan) };
  } } } as unknown as GoogleGenAI;
  planner = new Planner('test', new KeyPool(['key']), settings, 100_000, () => fake, async request => {
    planner.observe('late receipt');
    assert.doesNotMatch(JSON.stringify(request.contents), /late receipt/);
    return 500;
  });
  await planner.initialize(signal()); await planner.next(signal(), () => {});
  assert.match(JSON.stringify(planner.history), /late receipt/);
});
