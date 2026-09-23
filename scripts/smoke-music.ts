import dotenv from 'dotenv';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { MusicStream } from '../server/music.ts';
import { KeyPool, envKeys, parseKeys } from '../server/keys.ts';
dotenv.config({ path: ['.env.local', '.env'], quiet: true });
const environment = process.env.GEMINI_KEYS_FILE ? { ...dotenv.parse(readFileSync(process.env.GEMINI_KEYS_FILE)), ...process.env } : process.env;
const keys = process.env.MUSIC_API_KEYS ? parseKeys(process.env.MUSIC_API_KEYS) : envKeys(environment);
let frames = 0, rate = 48000, channels = 2, firstMs = 0;
const chunks: Buffer[] = [], started = Date.now();
const events: unknown[] = [];
const stream = new MusicStream(new KeyPool(keys), 'Warm cinematic ambient, felt piano, spacious acoustic textures, understated documentary score', event => {
  if (event.type === 'music') {
    firstMs ||= Date.now() - started; rate = event.sampleRate; channels = event.channels;
    const bytes = Buffer.from(event.data, 'base64'); chunks.push(bytes); frames += bytes.length / (2 * channels);
    stream.progress(false, 0);
    if (frames / rate >= 12) stream.stop();
  } else { events.push(event); console.log(JSON.stringify(event)); }
});
const timeout = setTimeout(() => stream.stop(), 60000);
await stream.run(); clearTimeout(timeout);
mkdirSync('test-results/music', { recursive: true });
writeFileSync('test-results/music/lyria.pcm', Buffer.concat(chunks));
const report = { keys: keys.length, firstMs, seconds: frames / rate, rate, channels, events };
writeFileSync('test-results/music/smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (!frames) process.exitCode = 1;
