import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

test('real server rejects foreign origins, validates messages, and never exposes keys in config', { timeout: 15000 }, async () => {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--production'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: String(port), GEMINI_API_KEYS: 'private-sentinel-key', GEMINI_KEYS_FILE: '' },
    stdio: ['ignore','pipe','pipe'], windowsHide: true,
  });
  const clients: WebSocket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timeout')), 8000);
      child.stdout.on('data', data => { if (String(data).includes('Maestro Radio:')) { clearTimeout(timer); resolve(); } });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(await fetch(`${base}/api/health`).then(r => r.json()), { ok: true });
    const config = await fetch(`${base}/api/config`).then(r => r.text());
    assert.doesNotMatch(config, /private-sentinel-key/);
    assert.equal(JSON.parse(config).configured, true);
    const foreign = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin: 'https://unrelated.example' });
    clients.push(foreign);
    const [error] = await once(foreign, 'error');
    assert.match(error.message, /403/);
    const local = new WebSocket(`ws://127.0.0.1:${port}/stream`, { origin: base });
    clients.push(local);
    await once(local, 'open');
    const reply = once(local, 'message');
    local.send(JSON.stringify({ type: 'start', settings: { target: { name: 'Bad', code: '../bad' } } }));
    assert.equal(JSON.parse(String((await reply)[0])).type, 'error');
    local.close();
  } finally {
    for (const client of clients) client.terminate();
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
  }
});
