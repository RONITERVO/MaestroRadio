import { mkdirSync, writeFileSync } from 'node:fs';
import { settingsSchema } from '../shared/protocol.ts';
import { writerInstruction, voiceInstruction } from '../server/prompts.ts';
import { VOICE_TAGS } from '../shared/voice-tags.ts';
const templates: Record<string, unknown> = { tags: VOICE_TAGS };
for (const styled of [false, true]) for (const expressive of [false, true]) {
  const settings = settingsSchema.parse({ topic: '__TOPIC__', style: styled ? '__STYLE__' : '', expressive,
    target: { name: '__TARGET_NAME__', code: 'xx' }, native: { name: '__NATIVE_NAME__', code: 'yy' }, level: 'B1' });
  templates[`writer_${styled}_${expressive}`] = writerInstruction(settings).replaceAll('(xx)', '(__TARGET_CODE__)').replaceAll('(yy)', '(__NATIVE_CODE__)').replace('Target level: B1.', 'Target level: __LEVEL__.');
}
templates.voice = voiceInstruction([{ text: '[curious] __TEXT__', code: 'xx', kind: 'target' }]).replace('[curious] __TEXT__', '__TEXT__');
const folder = new URL('../android/app/src/main/assets/', import.meta.url); mkdirSync(folder, { recursive: true });
writeFileSync(new URL('prompts.json', folder), JSON.stringify(templates, null, 2) + '\n');
console.log('Synchronized Android writer and voice prompts.');
