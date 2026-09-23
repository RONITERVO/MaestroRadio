import { francAll } from 'franc';
import type { Plan, Settings } from '../shared/protocol.ts';

const codes: Record<string, string> = { es: 'spa', en: 'eng', fi: 'fin', fr: 'fra', de: 'deu', it: 'ita', pt: 'por',
  sv: 'swe', nl: 'nld', pl: 'pol', tr: 'tur', el: 'ell', ru: 'rus', uk: 'ukr', ja: 'jpn', ko: 'kor',
  cmn: 'cmn', zh: 'cmn', ar: 'arb', hi: 'hin', bn: 'ben', id: 'ind', vi: 'vie', th: 'tha', ro: 'ron' };

/** Catch clear language reversals locally. Short/ambiguous text is left to the explicit schema contract. */
export function languageReason(plan: Plan, settings: Settings): string | null {
  const target = codes[settings.target.code.split('-')[0]], native = codes[settings.native.code.split('-')[0]];
  if (!target || !native || target === native) return null;
  for (const field of ['target', 'native'] as const) {
    const text = plan.pairs.map(pair => pair[field]).join(' ');
    if (text.length < 60) continue;
    const expected = field === 'target' ? target : native;
    const ranked = francAll(text, { only: [target, native], minLength: 60 });
    if (ranked.length > 1 && ranked[0][0] !== expected && ranked[0][1] - ranked[1][1] > 0.15) {
      return `Language fields are incorrect. Rewrite pairs[].target in ${settings.target.name} and pairs[].native in ${settings.native.name}. Keep the meaning and field order.`;
    }
  }
  return null;
}
