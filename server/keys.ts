import { setTimeout as delay } from 'node:timers/promises';

export function parseKeys(value = ''): string[] { return [...new Set(value.split(/[\s,;]+/).map(v => v.trim()).filter(Boolean))]; }
export function envKeys(env: NodeJS.ProcessEnv): string[] {
  return [...new Set([...parseKeys(env.GEMINI_API_KEYS), ...Object.entries(env)
    .filter(([k]) => /^(GEMINI_API_KEY_?\d*|GOOGLE_API_KEY)$/.test(k)).flatMap(([, v]) => parseKeys(v))])];
}
export function errorStatus(error: unknown): number {
  const e = (error ?? {}) as { status?: number; code?: number; message?: string };
  const message = typeof e.message === 'string' ? e.message : '';
  return Number(e.status) || Number(e.code) || Number(message.match(/\b(400|401|403|404|429|500|502|503|504)\b/)?.[1])
    || (/RESOURCE_EXHAUSTED|quota exceeded|too many requests/i.test(message) ? 429 : 0);
}
/** SDK errors retain Google's JSON error body in message; never expose it to the browser. */
function errorDetails(error: unknown): Record<string, any>[] {
  try {
    const candidate = error as { message?: string; error?: { details?: unknown[] }; details?: unknown[] };
    const body = candidate.message?.startsWith('{') ? JSON.parse(candidate.message) : candidate;
    const details = body.error?.details ?? body.details ?? [];
    return Array.isArray(details) ? details.filter(detail => detail && typeof detail === 'object') : [];
  } catch { return []; }
}
export function retryDelayMs(error: unknown): number | undefined {
  for (const detail of errorDetails(error)) {
    if (detail['@type'] !== 'type.googleapis.com/google.rpc.RetryInfo') continue;
    const value = typeof detail.retryDelay === 'string' ? Number(detail.retryDelay.replace(/s$/, ''))
      : Number(detail.retryDelay?.seconds ?? 0) + Number(detail.retryDelay?.nanos ?? 0) / 1e9;
    if (Number.isFinite(value) && value > 0) return Math.ceil(value * 1000);
  }
}
function dailyQuota(error: unknown): boolean {
  return errorDetails(error).some(detail => Array.isArray(detail.violations) && detail.violations.some((v: { quotaId?: string; quotaMetric?: string }) =>
    /PerDay/i.test(v?.quotaId ?? '') || /per_day/i.test(v?.quotaMetric ?? '')));
}
/** Gemini daily quotas reset at midnight Pacific, including daylight-saving changes. */
export function nextDailyReset(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
  const part = (type: string) => Number(parts.find(p => p.type === type)!.value);
  const latestMidnight = Date.UTC(part('year'), part('month') - 1, part('day') + 1, 8);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hourCycle: 'h23' }).format(latestMidnight));
  return latestMidnight - hour * 3600_000;
}
type Entry = { key: string; until: number; dailyUntil: number; failures: number; disabled: boolean; inFlight: number; revision: number };
type Wait = (ms: number, signal: AbortSignal) => Promise<void>;
export class KeyPool {
  private entries: Entry[];
  private models = new Map<string, KeyPool>();
  private cursor = 0;
  constructor(keys: string[], private now = Date.now, private wait: Wait = async (ms, signal) => { await delay(ms, undefined, { signal }); }) {
    this.entries = [...new Set(keys)].map(key => ({ key, until: 0, dailyUntil: 0, failures: 0, disabled: false, inFlight: 0, revision: 0 }));
  }
  get size() { return this.entries.length; }
  /** Quota and model-access failures affect this model only, including browser-pasted shared keys. */
  forModel(model: string): KeyPool {
    model = model.replace(/^models\//, '');
    let pool = this.models.get(model);
    if (!pool) { pool = new KeyPool(this.entries.map(entry => entry.key), this.now, this.wait); this.models.set(model, pool); }
    return pool;
  }
  async run<T>(operation: (key: string) => Promise<T>, signal: AbortSignal, canRetry = () => true): Promise<T> {
    if (!this.entries.length) throw new Error('Add a Gemini key in settings or .env.');
    let lastError: unknown;
    let waited = 0, attempts = 0;
    const tried = new Set<Entry>();
    // Every configured key can be tried, followed by at most two additional attempts.
    while (attempts < this.entries.length + 2) {
      signal.throwIfAborted();
      const usable = this.entries.filter(e => !e.disabled);
      if (!usable.length) throw lastError ?? new Error('All configured keys were rejected.');
      const ordered = this.entries.slice(this.cursor).concat(this.entries.slice(0, this.cursor));
      const ready = ordered.filter(e => !e.disabled && e.until <= this.now());
      if (!ready.length) {
        const waitMs = Math.max(1, Math.min(...usable.map(e => e.until)) - this.now());
        // Keep the request bounded even if Google asks for a daily-scale cooldown.
        if (waited + waitMs > 60_000) {
          if (usable.every(e => e.dailyUntil > this.now())) throw new KeysUnavailable('All configured keys with access to this model have reached their daily quota. Try after midnight Pacific, or add a key from another project.');
          throw lastError ?? new KeysUnavailable('Every configured key for this model is cooling down. Try again shortly or add a key from another project.');
        }
        await this.wait(waitMs, signal); waited += waitMs;
        continue; // Another concurrent request may have changed availability while we waited.
      }
      const untried = ready.filter(e => !tried.has(e));
      const entry = (untried.length ? untried : ready).reduce((a, b) => a.inFlight <= b.inFlight ? a : b);
      this.cursor = (this.entries.indexOf(entry) + 1) % this.entries.length;
      tried.add(entry); attempts++; entry.inFlight++;
      const revision = entry.revision;
      try {
        const result = await operation(entry.key);
        // A late success must not erase a newer concurrent rate-limit response.
        if (entry.revision === revision) { entry.failures = 0; entry.until = 0; entry.dailyUntil = 0; }
        return result;
      }
      catch (error) {
        lastError = error;
        if (signal.aborted) throw error;
        const status = errorStatus(error);
        if ([401, 403, 404].includes(status)) { entry.disabled = true; entry.revision++; }
        else if ([429, 500, 502, 503, 504].includes(status)) {
          entry.failures++; entry.revision++;
          const backoff = Math.min(60_000, (status === 429 ? 15_000 : 1000) * 2 ** (entry.failures - 1));
          entry.until = Math.max(entry.until, this.now() + Math.max(backoff, retryDelayMs(error) ?? 0));
          if (status === 429 && dailyQuota(error)) {
            entry.dailyUntil = nextDailyReset(this.now());
            entry.until = Math.max(entry.until, entry.dailyUntil);
          }
        } else throw error;
        if (!canRetry()) throw error;
      }
      finally { entry.inFlight--; }
    }
    throw lastError;
  }
}
export function safeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Stopped.';
  if (error instanceof KeysUnavailable) return error.message;
  const status = errorStatus(error);
  if (status === 429) return 'No configured key is currently available for this Gemini model. Let quotas recover or add a key from another project.';
  if (status === 401 || status === 403) return 'Gemini rejected the key or its model access.';
  if (status === 404) return 'Configured model is unavailable for this key. Check the model settings in .env.';
  if (status) return `Gemini request failed (${status}). Check model access and try again.`;
  return error instanceof PublicError ? error.message : 'The stream stopped unexpectedly. Your episode log is saved locally.';
}
export class PublicError extends Error {}
class KeysUnavailable extends PublicError {}
