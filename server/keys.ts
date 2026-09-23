import { setTimeout as delay } from 'node:timers/promises';

export function parseKeys(value = ''): string[] { return [...new Set(value.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean))]; }
export function envKeys(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([...parseKeys(env.GEMINI_API_KEYS), ...Object.entries(env)
    .filter(([k]) => /^(GEMINI_API_KEY_?\d*|GOOGLE_API_KEY)$/.test(k)).flatMap(([, v]) => parseKeys(v))])];
}
export function errorStatus(error: unknown): number {
  const e = error as { status?: number; code?: number; message?: string };
  return Number(e.status ?? e.code) || Number(e.message?.match(/\b(400|401|403|404|429|500|502|503|504)\b/)?.[1]) || 0;
}
export class KeyPool {
  private entries: { key: string; until: number; failures: number; disabled: boolean }[];
  private cursor = 0;
  constructor(keys: string[], private now = Date.now) {
    this.entries = [...new Set(keys)].map(key => ({ key, until: 0, failures: 0, disabled: false }));
  }
  get size() { return this.entries.length; }
  async run<T>(operation: (key: string) => Promise<T>, signal: AbortSignal, canRetry = () => true): Promise<T> {
    if (!this.entries.length) throw new Error('Add a Gemini key in settings or .env.');
    let lastError: unknown;
    for (let attempt = 0; attempt < Math.min(this.entries.length + 2, 8); attempt++) {
      signal.throwIfAborted();
      const usable = this.entries.filter(e => !e.disabled);
      if (!usable.length) throw lastError ?? new Error('All configured keys were rejected.');
      let entry = this.entries[this.cursor++ % this.entries.length];
      if (entry.disabled || entry.until > this.now()) entry = usable.reduce((a, b) => a.until < b.until ? a : b);
      await delay(Math.max(0, entry.until - this.now()), undefined, { signal });
      try { const result = await operation(entry.key); entry.failures = 0; return result; }
      catch (error) {
        lastError = error;
        if (signal.aborted || !canRetry()) throw error;
        const status = errorStatus(error);
        if (status === 401 || status === 403) { entry.disabled = true; continue; }
        if (![429, 500, 502, 503, 504].includes(status)) throw error;
        entry.failures++;
        entry.until = this.now() + Math.min(60_000, (status === 429 ? 15_000 : 1000) * 2 ** (entry.failures - 1));
      }
    }
    throw lastError;
  }
}
export function safeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Stopped.';
  const status = errorStatus(error);
  if (status === 429) return 'Gemini quota reached. Let the project quota recover, then start again.';
  if (status === 401 || status === 403) return 'Gemini rejected the key or its model access.';
  if (status === 404) return 'Configured model is unavailable for this key. Check the model settings in .env.';
  if (status) return `Gemini request failed (${status}). Check model access and try again.`;
  return error instanceof PublicError ? error.message : 'The stream stopped unexpectedly. Your episode log is saved locally.';
}
export class PublicError extends Error {}
