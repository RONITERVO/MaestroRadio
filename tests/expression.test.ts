import test from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptClock } from '../server/transcript.ts';
import { repetitionReason } from '../server/planner.ts';
import { linesFor, settingsSchema, type Cue, type Plan } from '../shared/protocol.ts';
import { stripVoiceTags, invalidVoiceTag } from '../shared/voice-tags.ts';
import { PlaybackGate } from '../server/episode.ts';

const plan: Plan = { angle: 'A fox arrives', newFacts: ['The fox has lost his crown'], nextThread: 'Look for the crown', pairs: [
  { target: '[curious] El zorro busca su corona. [sighs]', native: '[curious] The fox is looking for his crown. [sighs]' },
] };
test('split delivery tags are omitted from captions and coverage, without removing spoken words', () => {
  const cues: Cue[] = [];
  const clock = new TranscriptClock(linesFor(plan, settingsSchema.parse({ expressive: true })), cue => cues.push(cue));
  clock.add('[cur', 0); clock.add('ious] El zorro busca su corona. [si', 24000);
  clock.add('ghs]\n[en-US] [curious] The fox is looking for his crown. [sighs]', 48000);
  clock.finish(48000);
  assert.equal(clock.coverage, 1);
  assert.deepEqual(clock.lineCoverage, [1, 1]);
  assert.doesNotMatch(cues.map(c => c.text).join(''), /\[|curious|sighs/);
  assert.match(cues.map(c => c.text).join(''), /El zorro busca su corona/);
});
test('tags cannot bypass repetition checks and unknown stage directions are rejected', () => {
  const previous = { ...plan, angle: 'Other angle', newFacts: ['Different claim'], pairs: plan.pairs.map(p => ({ target: stripVoiceTags(p.target), native: stripVoiceTags(p.native) })) };
  assert.match(repetitionReason(plan, [previous])!, /sentence repeats/);
  assert.equal(invalidVoiceTag('[door slams] Hola.'), '[door slams]');
  assert.equal(invalidVoiceTag('[whispering] Hola.'), null);
});
test('higher playback speed reserves the same wall-clock runway and still respects pause', () => {
  const gate = new PlaybackGate();
  gate.rate = 2;
  assert.equal(gate.canProduce(89 * 24000), true);
  assert.equal(gate.canProduce(91 * 24000), false);
  gate.paused = true; assert.equal(gate.canProduce(1), false);
});

test('a recurring story title does not reject fresh events and dialogue', () => {
  const next = { ...plan, newFacts: ['The crown is hidden in a basket'], pairs: [{ target: 'La corona está dentro de una cesta.', native: 'The crown is inside a basket.' }] };
  assert.equal(repetitionReason(next, [plan]), null);
});
