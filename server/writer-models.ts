import { ThinkingLevel, type ThinkingConfig } from '@google/genai';

export const DEFAULT_WRITER_MODEL = 'gemini-2.5-flash';
export const DEFAULT_WRITER_FALLBACKS = ['gemini-3-flash-preview', 'gemini-2.5-flash-lite'];
export const DEFAULT_WRITER_TIMEOUT_MS = 12_000;
export function writerModels(env: NodeJS.ProcessEnv) {
  const model = env.PLANNER_MODEL?.trim() || DEFAULT_WRITER_MODEL;
  // Explicitly pinning a model keeps that choice unless fallbacks are also configured.
  const fallbacks = env.PLANNER_FALLBACK_MODELS === undefined
    ? (model === DEFAULT_WRITER_MODEL ? DEFAULT_WRITER_FALLBACKS : [])
    : env.PLANNER_FALLBACK_MODELS.split(/[\s,;]+/).filter(Boolean);
  const timeoutMs = Number(env.PLANNER_TIMEOUT_MS || DEFAULT_WRITER_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) throw new Error('PLANNER_TIMEOUT_MS must be between 1000 and 120000.');
  if (fallbacks.length > 8 || [model, ...fallbacks].some(name => !/^(?:models\/)?[a-zA-Z0-9._-]+$/.test(name))) throw new Error('Invalid planner model configuration.');
  return { model, fallbacks: [...new Set(fallbacks)].filter(name => name !== model), timeoutMs };
}

/** Lowest supported thinking setting for each tested text writer family. */
export function writerThinking(model: string): ThinkingConfig | undefined {
  model = model.replace(/^models\//, '');
  if (model.startsWith('gemini-2.5-flash')) return { thinkingBudget: 0 };
  if (/^gemini-3\.[78]-flash(?:$|-)/.test(model) && !model.includes('lite')) return { thinkingLevel: ThinkingLevel.LOW };
  if (/^gemini-3(?:\.[156])?-flash(?:$|-)/.test(model)) return { thinkingLevel: ThinkingLevel.MINIMAL };
}
