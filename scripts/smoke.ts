import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { Episode } from '../server/episode.ts';
import { KeyPool, envKeys, safeError } from '../server/keys.ts';
import { settingsSchema } from '../shared/protocol.ts';

const envIndex = process.argv.indexOf('--env');
dotenv.config({ path: envIndex >= 0 ? resolve(process.argv[envIndex + 1]) : resolve('.env'), quiet: true });
const keys = envKeys(process.env);
if (!keys.length) throw new Error('No keys found. Use npm run smoke -- --env /path/to/your.env');
const started = performance.now();
let firstAudio: number | null = null;
let firstCue: number | null = null;
let failed = false;
let turns = 0;
const timeline: { type: string; ms: number; turn?: number }[] = [];
const pool = new KeyPool(keys);
const settings = settingsSchema.parse({ topic: 'Explain the surprising journey of a drop of water through a forest, with concrete scientific details.',
  target: { name: 'Spanish', code: 'es-ES' }, native: { name: 'English', code: 'en-US' }, level: 'B1' });
const episode = new Episode(settings, { plannerModel: process.env.PLANNER_MODEL || 'gemini-3.5-flash-lite',
  liveModel: process.env.LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025', contextLimit: 1_048_576,
  dataDir: resolve('test-results/live'), plannerPool: pool, livePool: pool }, event => {
  if (event.type === 'audio') {
    firstAudio ??= performance.now() - started;
    episode.progress(event.startSample + Buffer.from(event.data, 'base64').length / 2, false);
  }
  if (event.type === 'cue') firstCue ??= performance.now() - started;
  if (['status','turn','turnEnd','context'].includes(event.type)) timeline.push({ type: event.type === 'status' ? event.state : event.type,
    ms: Math.round(performance.now() - started), ...('turn' in event ? { turn: event.turn } : {}) });
  if (event.type === 'turnEnd') { turns++; console.log(JSON.stringify(event)); }
  if (event.type === 'error') { failed = true; console.error(event.message); }
  if (event.type === 'end') console.log(JSON.stringify(event));
});
try {
  await episode.run(Number(process.env.SMOKE_TURNS || 2));
  const pcm = readFileSync(resolve(episode.folder, 'audio.pcm'));
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  writeFileSync(resolve(episode.folder, 'episode.wav'), wav);
  const evidence = { turns, firstAudioMs: Math.round(firstAudio ?? 0), firstCueMs: Math.round(firstCue ?? 0),
    elapsedMs: Math.round(performance.now() - started), audioSeconds: episode.totalSamples / 24000,
    contextTokens: episode.planner.used, contextLimit: episode.planner.limit, failed, timeline };
  writeFileSync(resolve(episode.folder, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`Artifacts: ${episode.folder}`);
} catch (error) { failed = true; console.error(safeError(error)); }
if (failed || !turns) process.exitCode = 1;
