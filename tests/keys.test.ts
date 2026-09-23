import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, errorStatus, retryDelayMs, nextDailyReset, safeError } from '../server/keys.ts';

const signal = () => new AbortController().signal;
function clock() {
  let time = 1000;
  const waits: number[] = [];
  return { waits, now: () => time, wait: async (ms: number) => { waits.push(ms); time += ms; } };
}
test('a healthy key beyond the eighth entry is reached without waiting on limited projects', async () => {
  const c = clock(), keys = Array.from({ length: 12 }, (_, i) => `project-${i}`);
  const pool = new KeyPool(keys, c.now, c.wait), attempted: string[] = [];
  const result = await pool.run(async key => {
    attempted.push(key);
    if (key !== keys.at(-1)) throw { status: 429 };
    return 'available';
  }, signal());
  assert.equal(result, 'available'); assert.deepEqual(attempted, keys); assert.deepEqual(c.waits, []);
});
test('writer cooldowns are reused for that model but do not cool down the Live model', async () => {
  const c = clock(), pool = new KeyPool(['a', 'b'], c.now, c.wait);
  const writer = pool.forModel('writer'), live = pool.forModel('live');
  assert.equal(pool.forModel('models/writer'), writer);
  await assert.rejects(writer.run(async () => { throw { status: 429 }; }, signal(), () => false));
  assert.equal(await writer.run(async key => key, signal()), 'b');
  assert.equal(await live.run(async key => key, signal()), 'a');
  assert.deepEqual(c.waits, []);
});
test('model access rejection rotates keys without disabling another model', async () => {
  const c = clock(), pool = new KeyPool(['a', 'b'], c.now, c.wait), used: string[] = [];
  const writer = pool.forModel('writer');
  assert.equal(await writer.run(async key => { used.push(key); if (key === 'a') throw { status: 404 }; return key; }, signal()), 'b');
  assert.deepEqual(used, ['a', 'b']);
  assert.equal(await pool.forModel('live').run(async key => key, signal()), 'a');
});
test('provider cooldown is honored after all projects fail, with bounded retry and no secret disclosure', async () => {
  const c = clock(), pool = new KeyPool(['a', 'b'], c.now, c.wait), used: string[] = [];
  const error = { status: 429, message: JSON.stringify({ error: { message: 'secret-key', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45.5s' },
  ] } }) };
  assert.equal(retryDelayMs(error), 45500);
  await assert.rejects(pool.run(async key => { used.push(key); throw error; }, signal()));
  assert.deepEqual(used, ['a', 'b', 'a', 'b']); assert.deepEqual(c.waits, [45500]);
  assert.doesNotMatch(safeError(error), /secret-key/);
  assert.equal(errorStatus({ message: 'RESOURCE_EXHAUSTED' }), 429);
});
test('a late concurrent success cannot erase a newer rate limit', async () => {
  const c = clock(), pool = new KeyPool(['a'], c.now, c.wait);
  let finish!: (value: string) => void;
  const slow = pool.run(() => new Promise<string>(resolve => { finish = resolve; }), signal());
  await assert.rejects(pool.run(async () => { throw { status: 429 }; }, signal(), () => false));
  finish('ok'); await slow;
  assert.equal(await pool.run(async () => 'recovered', signal()), 'recovered');
  assert.deepEqual(c.waits, [15000]);
});
test('concurrent requests prefer an idle available project', async () => {
  const c = clock(), pool = new KeyPool(['a', 'b'], c.now, c.wait);
  let finish!: (value: string) => void;
  const pending = pool.run(key => { assert.equal(key, 'a'); return new Promise<string>(resolve => { finish = resolve; }); }, signal());
  assert.equal(await pool.run(async key => key, signal()), 'b');
  // Round-robin now points at a again, but a is still busy.
  assert.equal(await pool.run(async key => key, signal()), 'b');
  finish('ok'); await pending;
});
test('aborting an all-keys cooldown stops waiting before another request', async () => {
  const pool = new KeyPool(['a']), controller = new AbortController();
  let requests = 0;
  const pending = pool.run(async () => { requests++; throw { status: 429 }; }, controller.signal);
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(requests, 1);
});
test('daily-exhausted projects stay parked despite a short RetryInfo delay', async () => {
  const c = clock(), pool = new KeyPool(['daily-a', 'daily-b'], c.now, c.wait);
  let calls = 0;
  const daily = { status: 429, message: JSON.stringify({ error: { details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' },
  ] } }) };
  await assert.rejects(pool.forModel('writer').run(async () => { calls++; throw daily; }, signal()), /daily quota/);
  await assert.rejects(pool.forModel('writer').run(async () => { calls++; return ''; }, signal()), /daily quota/);
  assert.equal(calls, 2); assert.deepEqual(c.waits, []);
  assert.equal(await pool.forModel('live').run(async key => key, signal()), 'daily-a');
});
test('daily quota reset follows Pacific midnight through both daylight-saving transitions', () => {
  for (const [now, expected] of [
    ['2026-09-23T15:00:00Z', '2026-09-24T07:00:00Z'],
    ['2026-01-03T15:00:00Z', '2026-01-04T08:00:00Z'],
    ['2026-03-08T07:59:00Z', '2026-03-08T08:00:00Z'],
    ['2026-03-08T09:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-11-01T06:59:00Z', '2026-11-01T07:00:00Z'],
    ['2026-11-01T08:00:00Z', '2026-11-02T08:00:00Z'],
  ]) assert.equal(new Date(nextDailyReset(Date.parse(now))).toISOString(), new Date(expected).toISOString());
});
