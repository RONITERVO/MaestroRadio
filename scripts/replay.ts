/** Local browser regression harness: replay an existing archive without spending API quota. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { clientMessageSchema } from '../shared/protocol.ts';

const folder = process.argv[2];
if (!folder) throw new Error('Usage: npm run replay -- data/<episode-id>');
const archive = resolve(folder), pcm = readFileSync(resolve(archive, 'audio.pcm'));
const metadata = JSON.parse(readFileSync(resolve(archive, 'episode.json'), 'utf8'));
const ledger = readFileSync(resolve(archive, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const turns = ledger.filter(row => row.type === 'narrated');
const app = express();
app.get('/api/config', (_request, response) => response.json({ configured: true, plannerModel: 'recorded test episode', liveModel: metadata.liveModel, plannerKeys: 0, liveKeys: 0 }));
app.use(express.static(resolve('dist')));
const server = createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
server.on('upgrade', (request, socket, head) => {
  const allowed = new Set(['http://127.0.0.1:4319', 'http://localhost:4319']);
  if (request.url !== '/stream' || !allowed.has(request.headers.origin ?? '') || !allowed.has(`http://${request.headers.host}`)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});
wss.on('connection', ws => {
  let started = false, paused = false, played = 0, generated = 0, index = 0, rate = 1, ended = false;
  const send = (event: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
  ws.on('message', raw => {
    try {
      const message = clientMessageSchema.parse(JSON.parse(raw.toString()));
      if (message.type === 'stop') { ws.close(); return; }
      if (message.type === 'progress') { played = message.playedSamples; paused = message.paused; rate = message.playbackRate ?? rate; }
      if (message.type === 'start' && !started) {
        rate = message.settings.speed; started = true;
        send({ type: 'session', id: metadata.id, topic: `Recorded test: ${metadata.settings.topic}`, plannerModel: 'replay', liveModel: metadata.liveModel });
        send({ type: 'status', state: 'streaming' });
      }
    } catch { ws.close(1008, 'Invalid replay request'); }
  });
  const tick = setInterval(() => {
    if (!started || paused || ended || generated - played > 45 * rate * 24000) return;
    const turn = turns[index++];
    if (!turn) { ended = true; send({ type: 'end', reason: 'complete', endSample: generated }); return; }
    send({ type: 'turn', turn: turn.turn, startSample: turn.startSample });
    for (let sample = turn.startSample; sample < turn.endSample; sample += 4800) {
      const end = Math.min(turn.endSample, sample + 4800);
      send({ type: 'audio', turn: turn.turn, startSample: sample, data: pcm.subarray(sample * 2, end * 2).toString('base64') });
    }
    for (const row of ledger.filter(row => row.type === 'cue' && row.turn === turn.turn)) send(row);
    generated = turn.endSample;
    send({ type: 'turnEnd', turn: turn.turn, endSample: generated, coverage: turn.coverage });
  }, 100);
  ws.on('close', () => clearInterval(tick));
});
server.listen(4319, '127.0.0.1', () => console.log('Recorded browser test: http://127.0.0.1:4319 (no Gemini calls)'));
