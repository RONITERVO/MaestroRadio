/** Finite paid A/B experiment using a writer-generated passage from an existing episode. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { envKeys, KeyPool, safeError } from '../server/keys.ts';
import { narrate } from '../server/live.ts';
import { linesFor, type Cue, type Plan, type Settings } from '../shared/protocol.ts';
import { hasVoiceTags, stripVoiceTags } from '../shared/voice-tags.ts';

dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const folder = process.argv[2];
if (!folder) throw new Error('Usage: npm run experiment:voice -- data/<episode-with-expressive-plan>');
const settings: Settings = JSON.parse(readFileSync(resolve(folder, 'episode.json'), 'utf8')).settings;
const plans: Plan[] = readFileSync(resolve(folder, 'ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'plan').map(row => row.plan);
const pairs = plans.flatMap(plan => plan.pairs).filter(pair => hasVoiceTags(pair.target)).slice(0, 2);
if (!pairs.length) throw new Error('No writer-generated vocal tags found in the archive.');
const lines = linesFor({ ...plans[0], pairs }, settings);
const pool = new KeyPool(envKeys(environment));
const output = resolve('test-results', `voice-experiment-${Date.now()}`); mkdirSync(output, { recursive: true });
const results = [];
for (const expressive of [false, true]) {
  const label = expressive ? 'expressive' : 'neutral';
  const chunks: Buffer[] = [];
  const cues: Cue[] = [];
  const start = performance.now();
  try {
    const result = await pool.run(key => narrate({ key, model: process.env.LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025', voice: settings.voice,
      lines: expressive ? lines : lines.map(line => ({ ...line, text: stripVoiceTags(line.text) })), signal: AbortSignal.timeout(90_000),
      onAudio: data => chunks.push(Buffer.from(data, 'base64')), onCue: cue => cues.push(cue) }), AbortSignal.timeout(120_000), () => chunks.length === 0);
    const pcm = Buffer.concat(chunks), wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF'); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
    writeFileSync(resolve(output, `${label}.wav`), wav);
    results.push({ label, elapsedMs: Math.round(performance.now() - start), durationSeconds: result.samples / 24000,
      coverage: result.coverage, lineCoverage: result.lineCoverage, transcript: result.transcript, captions: cues.map(cue => cue.text).join('') });
    if (result.lineCoverage.some(coverage => coverage < 0.82) || cues.some(cue => hasVoiceTags(cue.text))) process.exitCode = 1;
  } catch (error) { results.push({ label, error: safeError(error) }); process.exitCode = 1; }
}
writeFileSync(resolve(output, 'comparison.json'), JSON.stringify({ settings, lines, results }, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
