import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NarrationPipeline } from '../server/narration-pipeline.ts';
import { BoundedQueue } from '../server/queue.ts';
import { KeyPool } from '../server/keys.ts';
import type { LiveOptions, LiveResult } from '../server/live.ts';
import type { ServerEvent } from '../shared/protocol.ts';
import { PlaybackTimeline } from '../shared/playback-timeline.ts';

const result = (text: string, samples = 2400): LiveResult => ({ transcript: text, samples, coverage: 1, lineCoverage: [1], cues: [] });
const audio = (value = 1) => Buffer.alloc(4800, value).toString('base64');
function harness() {
  const requests: { options: LiveOptions; resolve: (result: LiveResult) => void; reject: (error: unknown) => void }[] = [];
  const events: ServerEvent[] = [];
  const receipts: number[] = [];
  const controller = new AbortController();
  const pipeline = new NarrationPipeline({ model: 'test', voice: 'Kore', pool: new KeyPool(['key']), signal: controller.signal,
    emit: e => events.push(e), record() {}, receipt: turn => receipts.push(turn), fail: error => controller.abort(error),
  }, options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    requests.push({ options, resolve, reject });
  }));
  return { pipeline, requests, events, receipts, controller };
}

test('future voice may finish first, but PCM and captions remain contiguous and ordered', async () => {
  const h = harness();
  h.pipeline.enqueue([{ text: 'first', kind: 'target', code: 'es-ES' }]);
  h.pipeline.enqueue([{ text: 'second', kind: 'native', code: 'en-US' }]);
  await delay(5);
  assert.equal(h.requests.length, 2);
  h.requests[1].options.onAudio(audio(2), 0);
  h.requests[1].options.onCue({ text: 'second', line: 0, kind: 'native', startSample: 0, endSample: 2400, observedAtSample: 2400 });
  h.requests[1].resolve(result('second'));
  await delay(1);
  assert.equal(h.events.filter(e => e.type === 'audio').length, 0);
  assert.throws(() => h.pipeline.enqueue([]), /lookahead/);
  h.requests[0].options.onAudio(audio(), 0);
  h.requests[0].resolve(result('first'));
  await h.pipeline.drain();
  const chunks = h.events.filter(e => e.type === 'audio');
  assert.deepEqual(chunks.map(c => [c.turn, c.startSample]), [[0,0], [1,2400]]);
  assert.equal(chunks[1].data, audio(2));
  const cue = h.events.find(e => e.type === 'cue');
  assert.equal(cue?.type === 'cue' && cue.cue.startSample, 2400);
  assert.deepEqual(h.receipts, [0,1]);
  assert.equal(h.pipeline.producedSamples, 4800);
  assert.equal(h.pipeline.publishedSamples, 4800);
});

test('a failed foreground turn cancels speculative narration without publishing its audio', async () => {
  const h = harness(); h.pipeline.enqueue([]); h.pipeline.enqueue([]); await delay(5);
  h.requests[1].options.onAudio(audio(2), 0);
  h.requests[0].reject(new Error('foreground failed'));
  await assert.rejects(h.pipeline.drain(), /foreground failed/);
  await h.pipeline.settled();
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.events.filter(e => e.type === 'audio').length, 0);
});

test('private audio is never published when its generation fails', async () => {
  const h = harness(); h.pipeline.enqueue([]); h.pipeline.enqueue([]); await delay(5);
  h.requests[0].options.onAudio(audio(), 0);
  h.requests[0].reject(new Error('generation failed'));
  await assert.rejects(h.pipeline.drain(), /generation failed/);
  await h.pipeline.settled(); assert.equal(h.requests.length, 2);
  assert.equal(h.events.filter(e => e.type === 'audio').length, 0);
});

test('an omitted translation in private lookahead is retried before publishing any of that turn', async () => {
  const h = harness(); h.pipeline.enqueue([]); h.pipeline.enqueue([]); await delay(5);
  h.requests[1].options.onAudio(audio(2), 0);
  h.requests[1].resolve({ ...result('incomplete'), coverage: 0.6, lineCoverage: [1, 0] });
  h.requests[0].options.onAudio(audio(), 0); h.requests[0].resolve(result('first'));
  await delay(5); assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].options.plainText, true);
  assert.equal(h.events.filter(e => e.type === 'audio').length, 1);
  h.requests[2].options.onAudio(audio(3), 0); h.requests[2].resolve(result('corrected'));
  await h.pipeline.drain();
  assert.deepEqual(h.events.filter(e => e.type === 'audio').map(e => e.data), [audio(), audio(3)]);
  assert.equal(h.pipeline.producedSamples, 4800);
  assert.equal(h.pipeline.publishedSamples, 4800);
});

test('bounded planning queue applies backpressure and wakes cancelled writers', async () => {
  const queue = new BoundedQueue<number>(1);
  const controller = new AbortController();
  await queue.put(1, controller.signal);
  let finished = false;
  const blocked = queue.put(2, controller.signal).then(() => { finished = true; });
  await delay(1); assert.equal(finished, false);
  assert.equal(await queue.take(controller.signal), 1);
  await blocked; assert.equal(finished, true);
  const wait = queue.put(3, controller.signal);
  controller.abort(); await assert.rejects(wait, { name: 'AbortError' });
});

test('prefetched audio survives a network delivery stall without a playback gap', () => {
  const timeline = new PlaybackTimeline(1400);
  timeline.add(0, 24000 * 12, 0);
  timeline.add(24000 * 12, 24000 * 12, 8);
  timeline.add(24000 * 24, 24000 * 12, 20);
  assert.equal(timeline.stats.underruns, 0);
  assert.equal(timeline.playedAt(25.4), 24000 * 24);
});

test('the reserve covers the 31-second generation delay observed in the browser', () => {
  const playback = new PlaybackTimeline(400);
  playback.add(0, 45 * 24000, 0);
  playback.add(45 * 24000, 30 * 24000, 31);
  assert.equal(playback.stats.underruns, 0);
  assert.equal(playback.playedAt(60.4), 60 * 24000);
});
