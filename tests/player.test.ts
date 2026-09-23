import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer } from '../src/player.ts';

class FakeAudio {
  currentTime = 0;
  baseLatency = 0;
  state = 'running';
  destination = {};
  starts: number[] = [];
  stopped = 0;
  createBuffer(_channels: number, count: number) { return { getChannelData: () => new Float32Array(count) }; }
  createBufferSource() {
    return { buffer: null, onended: null, connect() {}, disconnect() {}, start: (time: number) => this.starts.push(time), stop: () => this.stopped++ };
  }
  getOutputTimestamp() { return { contextTime: this.currentTime }; }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.state = 'closed'; }
}
const pcm = (samples: number) => Buffer.alloc(samples * 2).toString('base64');

test('captions use scheduled sample time, with the initial delay and an underrun gap', async () => {
  const audio = new FakeAudio();
  const player = new StreamPlayer(1400, audio as unknown as AudioContext);
  player.add(pcm(24000), 0); player.add(pcm(24000), 24000);
  assert.deepEqual(audio.starts, [1.4, 2.4]);
  audio.currentTime = 1; assert.equal(player.playedSamples, 0);
  audio.currentTime = 1.9; assert.ok(Math.abs(player.playedSamples - 12000) <= 1);
  audio.currentTime = 4; assert.equal(player.playedSamples, 48000);
  player.add(pcm(24000), 48000); assert.equal(audio.starts[2], 4.04);
  audio.currentTime = 4.02; assert.equal(player.playedSamples, 48000);
  audio.currentTime = 4.54; assert.ok(Math.abs(player.playedSamples - 60000) <= 1);
  assert.equal(player.diagnostics.underruns, 1);
  assert.ok(player.diagnostics.maxGapMs < 650);
  await player.stop(); assert.equal(audio.stopped, 3);
});
test('pause/resume uses the same audio clock; stop cancels queued chunks', async () => {
  const audio = new FakeAudio();
  const player = new StreamPlayer(1000, audio as unknown as AudioContext);
  player.add(pcm(24000), 0); audio.currentTime = 1.5;
  await player.togglePause(); assert.equal(audio.state, 'suspended'); assert.equal(player.playedSamples, 12000);
  await player.togglePause(); assert.equal(audio.state, 'running'); assert.equal(player.playedSamples, 12000);
  await player.stop(); audio.currentTime = 20; assert.equal(player.playedSamples, 12000);
  player.add(pcm(100), 24000); assert.equal(audio.starts.length, 1);
});
test('out of order audio is rejected instead of silently corrupting transcript time', async () => {
  const player = new StreamPlayer(1000, new FakeAudio() as unknown as AudioContext);
  assert.throws(() => player.add(pcm(240), 100), /sequence/);
  await player.stop();
});
test('buffer diagnostics cannot move the audible caption clock forward', async () => {
  const audio = new FakeAudio();
  const player = new StreamPlayer(1000, audio as unknown as AudioContext);
  player.add(pcm(24000), 0);
  audio.currentTime = 2.1; void player.diagnostics;
  audio.currentTime = 1.9; assert.ok(Math.abs(player.playedSamples - 21600) <= 1);
  await player.stop();
});
