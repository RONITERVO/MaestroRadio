import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { Episode } from '../server/episode.ts';
import { envKeys, KeyPool } from '../server/keys.ts';
import { settingsSchema } from '../shared/protocol.ts';
import { PlaybackTimeline } from '../shared/playback-timeline.ts';
import { writerModels } from '../server/writer-models.ts';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const keys = envKeys(environment);
if (!keys.length) throw new Error('Configure Gemini keys first.');
const plans = Number(process.env.SOAK_PLANS || 4);
const native = process.env.SOAK_NATIVE === 'fi' ? { name: 'Finnish', code: 'fi-FI' } : { name: 'English', code: 'en-US' };
const settings = settingsSchema.parse({ topic: process.env.SOAK_TOPIC || 'How bread rises. Follow a loaf through a bakery, explaining what happens and why.', native,
  style: process.env.SOAK_STYLE || '', expressive: process.env.SOAK_EXPRESSIVE === '1', speed: Number(process.env.SOAK_SPEED || 1) });
const pool = new KeyPool(keys);
const playback = new PlaybackTimeline(settings.bufferMs);
playback.setRate(settings.speed, 0);
const start = performance.now();
const now = () => (performance.now() - start) / 1000;
let firstAudioMs = 0;
let failed = false;
let ended = '';
let turns = 0;
const boundaries: number[] = [];
const coverage: number[] = [];
const arrivals: { at: number; sample: number; samples: number; turn: number }[] = [];
const writer = writerModels(process.env);
const episode = new Episode(settings, { plannerModel: writer.model, plannerFallbackModels: writer.fallbacks, plannerTimeoutMs: writer.timeoutMs,
  liveModel: process.env.LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025', contextLimit: 1048576,
  dataDir: resolve('test-results/soak'), plannerPool: pool, livePool: pool }, event => {
  if (event.type === 'audio') {
    firstAudioMs ||= Math.round(now() * 1000);
    const samples = Buffer.from(event.data, 'base64').length / 2;
    arrivals.push({ at: now(), sample: event.startSample, samples, turn: event.turn });
    playback.add(event.startSample, samples, now());
  }
  if (event.type === 'turnEnd') {
    turns++; boundaries.push(event.endSample); coverage.push(event.coverage);
    console.log(JSON.stringify({ turn: event.turn, wallSeconds: Math.round(now()), audioSeconds: event.endSample / 24000,
      coverage: event.coverage, underruns: playback.stats.underruns, bufferedSeconds: Math.round(playback.bufferedMs(now()) / 1000) }));
  }
  if (event.type === 'error') { failed = true; console.error(event.message); }
  if (event.type === 'end') ended = event.reason;
});
const progress = setInterval(() => episode.progress(playback.playedAt(now()), false, undefined, settings.speed), 100);
const timeout = setTimeout(() => { failed = true; episode.stop(); }, 12 * 60 * 1000);
try { await episode.run(plans); } finally { clearInterval(progress); clearTimeout(timeout); }
const pcmPath = resolve(episode.folder, 'audio.pcm');
const pcm = existsSync(pcmPath) ? readFileSync(pcmPath) : Buffer.alloc(0);
const block = 480;
const quiet: boolean[] = [];
for (let offset = 0; offset + block * 2 <= pcm.length; offset += block * 2) {
  let square = 0;
  for (let i = 0; i < block; i++) square += pcm.readInt16LE(offset + i * 2) ** 2;
  quiet.push(Math.sqrt(square / block) < 90);
}
const joinSilencesMs = boundaries.slice(0, -1).map(sample => {
  const blockIndex = Math.floor(sample / block);
  let left = blockIndex - 1, right = blockIndex;
  while (left >= 0 && quiet[left]) left--;
  while (right < quiet.length && quiet[right]) right++;
  return (right - left - 1) * 20;
});
const evidence = { plans, turns, native: native.name, style: settings.style, expressive: settings.expressive, speed: settings.speed,
  bufferMs: settings.bufferMs, firstAudioMs, ...playback.stats, audioSeconds: episode.totalSamples / 24000,
  elapsedSeconds: now(), coverage, joinSilencesMs, failed, ended, archive: episode.folder };
writeFileSync(resolve(episode.folder, 'evidence.json'), JSON.stringify(evidence, null, 2));
writeFileSync(resolve(episode.folder, 'arrivals.json'), JSON.stringify(arrivals));
console.log(JSON.stringify(evidence, null, 2));
if (failed || ended !== 'complete' || playback.stats.underruns || turns < 2) process.exitCode = 1;
