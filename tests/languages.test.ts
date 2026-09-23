import test from 'node:test';
import assert from 'node:assert/strict';
import { languageReason } from '../server/languages.ts';
import { settingsSchema, type Plan } from '../shared/protocol.ts';

const plan: Plan = { angle: 'Fermentation', newFacts: ['Yeast consumes sugars'], nextThread: 'Gas in dough', pairs: [
  { target: 'Unos diminutos organismos, las levaduras, se alimentan de los azúcares de la harina.', native: 'Tiny yeast organisms feast on the sugars in flour.' },
  { target: 'Mientras comen, liberan un gas llamado dióxido de carbono que forma burbujas en la masa.', native: 'As they eat, they release a gas called carbon dioxide which forms bubbles in the dough.' },
] };
test('rejects the language reversal observed in a real Flash-Lite episode', () => {
  const settings = settingsSchema.parse({});
  assert.equal(languageReason(plan, settings), null);
  assert.match(languageReason({ ...plan, pairs: plan.pairs.map(p => ({ target: p.native, native: p.target })) }, settings)!, /incorrect/);
});
test('accepts Spanish and Finnish with the correct field order', () => {
  const settings = settingsSchema.parse({ native: { name: 'Finnish', code: 'fi-FI' } });
  assert.equal(languageReason({ ...plan, pairs: [
    { target: 'Las hojas pierden agua cuando el sol calienta su superficie durante el día.', native: 'Lehdet menettävät vettä, kun aurinko lämmittää niiden pintaa päivän aikana.' },
    { target: 'Las raíces absorben más agua del suelo para reemplazar la que se ha perdido.', native: 'Juuret imevät lisää vettä maaperästä korvatakseen menetetyn veden.' },
  ] }, settings), null);
});
test('does not reject ambiguous short sentences', () => {
  assert.equal(languageReason({ ...plan, pairs: [{ target: 'Sí.', native: 'Yes.' }] }, settingsSchema.parse({})), null);
});
