import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sidechain, limitMix } from '../shared/sidechain.ts';
import { MusicStream, musicFormat } from '../server/music.ts';
import { KeyPool } from '../server/keys.ts';
import { LiveMusicServerMessage, type LiveMusicSession, type LiveMusicConnectParameters } from '@google/genai';
import type { ServerEvent } from '../shared/protocol.ts';
test('music decodes actual PCM format and rejects malformed channel/rate changes', () => {
  assert.deepEqual(musicFormat('audio/pcm;rate=48000;channels=2'), { sampleRate: 48000, channels: 2 });
  assert.equal(musicFormat('audio/pcm;rate=44100').sampleRate, 44100);
  assert.deepEqual(musicFormat('audio/l16;rate=48000;channels=2'), { sampleRate: 48000, channels: 2 });
  assert.throws(() => musicFormat('audio/mp3'));
  assert.throws(() => musicFormat('audio/pcm;rate=24000;channels=1'));
});
test('music ducks for speech and releases gradually without pumping between words', () => {
  const duck = new Sidechain(48000);
  for (let i = 0; i < 48000; i++) duck.next(0.3);
  assert.ok(duck.gain < 0.3);
  const talking = duck.gain;
  for (let i = 0; i < 4800; i++) duck.next(0);
  assert.ok(duck.gain < 0.5); assert.ok(duck.gain >= talking);
  for (let i = 0; i < 144000; i++) duck.next(0);
  assert.ok(duck.gain > 0.98);
});
test('mix limiter retains quiet signals and keeps loud sums below full scale', () => {
  assert.equal(limitMix(0.4), 0.4);
  for (const x of [-10, -2, -1, 1, 2, 10]) assert.ok(Math.abs(limitMix(x)) <= 0.97);
  assert.equal(limitMix(-1.2), -limitMix(1.2));
});
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
test('music flow pauses on listener pause and full buffer, then resumes with hysteresis', async () => {
  const actions: string[] = [], events: ServerEvent[] = [];
  let params!: LiveMusicConnectParameters;
  const session = { setWeightedPrompts: async () => {}, setMusicGenerationConfig: async () => {}, play: () => actions.push('play'), pause: () => actions.push('pause'), close: () => actions.push('close') } as unknown as LiveMusicSession;
  const music = new MusicStream(new KeyPool(['fake-key-long-enough']), 'piano', event => events.push(event), undefined, async (_key, p) => { params = p; return session; });
  const running = music.run(); await settle();
  music.progress(true, 1); music.progress(false, 1);
  music.progress(false, 9); music.progress(false, 5); music.progress(false, 2);
  params.callbacks.onmessage(Object.assign(new LiveMusicServerMessage(), { serverContent: { audioChunks: [{ data: Buffer.alloc(4).toString('base64'), mimeType: 'audio/l16;rate=48000;channels=2' }] } }));
  assert.deepEqual(actions, ['play', 'pause', 'play', 'pause', 'play']);
  assert.equal(events.filter(e => e.type === 'music').length, 1);
  music.stop(); await running;
  assert.equal(actions.at(-1), 'close');
});
test('music rotates model-limited keys and never emits a fatal speech error', async () => {
  const keys: string[] = [], events: ServerEvent[] = [];
  const stream = new MusicStream(new KeyPool(['key-one-long-enough', 'key-two-long-enough']), 'piano', event => events.push(event), undefined, async key => {
    keys.push(key); throw Object.assign(new Error('quota'), { status: 429 });
  });
  await stream.run();
  assert.equal(keys.length, 2);
  assert.ok(events.some(e => e.type === 'musicStatus' && e.state === 'unavailable'));
  assert.ok(events.every(e => e.type !== 'error'));
});
test('stopping music closes a late connection without starting billable generation', async () => {
  let connected!: (session: LiveMusicSession) => void;
  let closed = 0, played = 0;
  const stream = new MusicStream(new KeyPool(['fake-key-long-enough']), 'piano', () => {}, undefined, () => new Promise(resolve => { connected = resolve; }));
  const running = stream.run(); stream.stop(); await running;
  connected({ close: () => closed++, play: () => played++ } as unknown as LiveMusicSession); await settle();
  assert.equal(closed, 1); assert.equal(played, 0);
});
