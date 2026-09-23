import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';
import { clientMessageSchema, type ServerEvent } from '../shared/protocol.ts';
import { envKeys, parseKeys, KeyPool } from './keys.ts';
import { Episode } from './episode.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: [resolve(root, '.env.local'), resolve(root, '.env')], quiet: true });
const port = Number(process.env.PORT || 4317);
const plannerModel = process.env.PLANNER_MODEL || 'gemini-2.5-flash-lite';
const liveModel = process.env.LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const contextLimit = Number(process.env.CONTEXT_LIMIT || 1_048_576);
if (!Number.isSafeInteger(contextLimit) || contextLimit < 10_000) throw new Error('CONTEXT_LIMIT must be at least 10000.');
const keyEnvironment = process.env.GEMINI_KEYS_FILE
  ? { ...dotenv.parse(readFileSync(resolve(root, process.env.GEMINI_KEYS_FILE))), ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value)) }
  : process.env;
const shared = new KeyPool(envKeys(keyEnvironment));
const plannerPool = process.env.PLANNER_API_KEYS ? new KeyPool(parseKeys(process.env.PLANNER_API_KEYS)) : shared;
const livePool = process.env.LIVE_API_KEYS ? new KeyPool(parseKeys(process.env.LIVE_API_KEYS)) : shared;
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const hostname = req.headers.host?.split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(hostname ?? '')) return void res.status(403).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.get('/api/config', (_req, res) => res.json({ plannerModel, liveModel, configured: plannerPool.size > 0 && livePool.size > 0,
  plannerKeys: plannerPool.size, liveKeys: livePool.size }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/stream') return; // Vite owns its separate HMR upgrade path.
  const allowed = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  if (!allowed.has(req.headers.origin ?? '') || !allowed.has(`http://${req.headers.host}`) || wss.clients.size >= 4) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  let episode: Episode | undefined;
  let started = false;
  let alive = true;
  const send = (event: ServerEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 8 * 1024 * 1024) { episode?.stop(); ws.close(1013, 'Playback connection too slow'); return; }
    ws.send(JSON.stringify(event));
  };
  const heartbeat = setInterval(() => {
    if (!alive) { episode?.stop(); ws.terminate(); return; }
    alive = false; ws.ping();
  }, 30_000);
  ws.on('pong', () => { alive = true; });
  ws.on('message', raw => {
    try {
      const message = clientMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === 'stop') { episode?.stop(); return; }
      if (message.type === 'progress') { episode?.progress(message.playedSamples, message.paused, message.playback); return; }
      if (started) { send({ type: 'error', message: 'This connection already owns an episode.' }); return; }
      if (message.settings.target.code.split('-')[0] === message.settings.native.code.split('-')[0]) {
        send({ type: 'error', message: 'Choose different target and translation languages.' }); send({ type: 'end', reason: 'error', endSample: 0 }); return;
      }
      const byok = message.keys.length ? new KeyPool(message.keys) : null;
      if (!(byok ?? plannerPool).size || !(byok ?? livePool).size) {
        send({ type: 'error', message: 'Add a Gemini API key in settings or .env.' }); send({ type: 'end', reason: 'error', endSample: 0 }); return;
      }
      started = true;
      episode = new Episode(message.settings, { plannerModel, liveModel, contextLimit,
        dataDir: resolve(root, process.env.DATA_DIR || 'data'), plannerPool: byok ?? plannerPool, livePool: byok ?? livePool }, send);
      void episode.run().catch(() => send({ type: 'error', message: 'The local episode archive could not be written. Check disk access.' }));
    } catch { send({ type: 'error', message: 'Invalid stream request. Check the settings and restart.' }); episode?.stop(); if (!episode) send({ type: 'end', reason: 'error', endSample: 0 }); }
  });
  ws.on('close', () => { clearInterval(heartbeat); episode?.stop(); });
  ws.on('error', () => { episode?.stop(); });
});
let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
if (process.argv.includes('--production')) {
  app.use(express.static(resolve(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server, path: '/hmr' } }, appType: 'spa' });
  app.use(vite.middlewares);
}
server.listen(port, '127.0.0.1', () => console.log(`Maestro Radio: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  for (const ws of wss.clients) ws.close(1001, 'Server stopping');
  wss.close(); server.close(); void vite?.close();
});
