import { GoogleGenAI, MusicGenerationMode, type LiveMusicSession, type LiveMusicConnectParameters } from '@google/genai';
import { setTimeout as delay } from 'node:timers/promises';
import { KeyPool, PublicError, errorStatus, safeError } from './keys.ts';
import type { ServerEvent } from '../shared/protocol.ts';

export const MUSIC_MODEL = 'lyria-realtime-exp';
export function musicFormat(mime = 'audio/pcm;rate=48000;channels=2') {
  const sampleRate = Number(mime.match(/rate=(\d+)/)?.[1] ?? 48000);
  const channels = Number(mime.match(/channels=(\d+)/)?.[1] ?? 2);
  // Lyria labels its little-endian PCM16 as audio/l16 (the native-audio model uses audio/pcm).
  if (!/^audio\/(pcm|l16)(;|$)/i.test(mime) || ![44100, 48000].includes(sampleRate) || channels !== 2) throw new PublicError('Lyria returned an unsupported music format.');
  return { sampleRate, channels };
}
/** Independent from the narrator: music quota or network failures never stop speech. */
export class MusicStream {
  private controller = new AbortController();
  private session?: LiveMusicSession;
  private paused = false;
  private buffered = 0;
  private providerPaused = false;
  constructor(private pool: KeyPool, private prompt: string, private emit: (event: ServerEvent) => void, private model = MUSIC_MODEL,
    private connectProvider?: (key: string, params: LiveMusicConnectParameters) => Promise<LiveMusicSession>) {}
  progress(paused: boolean, buffered = 0) { this.paused = paused; this.buffered = buffered; this.flow(); }
  private flow() {
    const pause = this.paused || this.buffered > 8 || (this.providerPaused && this.buffered > 3);
    if (this.session && pause !== this.providerPaused) {
      this.providerPaused = pause;
      try { if (pause) this.session.pause(); else this.session.play(); } catch { /* Connection callbacks handle failure. */ }
    }
  }
  stop() { this.controller.abort(); try { this.session?.close(); } catch {} }
  async run() {
    const signal = this.controller.signal;
    this.emit({ type: 'musicStatus', state: 'connecting' });
    try {
      // A live connection may expire; keep a small bounded reconnect budget.
      for (let reconnect = 0; reconnect < 3; reconnect++) {
        try {
          await this.pool.forModel(this.model).run(key => this.connect(key), signal, () => true, 0);
          return;
        } catch (error) {
          if (signal.aborted) return;
          if ([400, 401, 403, 404, 429].includes(errorStatus(error)) || reconnect === 2) throw error;
          await delay(1000 * (reconnect + 1), undefined, { signal });
        }
      }
    } catch (error) {
      if (!signal.aborted) this.emit({ type: 'musicStatus', state: 'unavailable', detail: `Music unavailable. ${safeError(error)} Speech continues.` });
    }
  }
  private connect(key: string): Promise<void> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    this.providerPaused = false;
    return new Promise((resolve, reject) => {
      let session: LiveMusicSession | undefined;
      let settled = false, lastAudio = Date.now(), started = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true; clearInterval(watchdog); signal.removeEventListener('abort', abort);
        if (this.session === session) this.session = undefined;
        try { session?.close(); } catch {}
        if (error) reject(error); else resolve();
      };
      const abort = () => finish();
      signal.addEventListener('abort', abort, { once: true });
      const watchdog = setInterval(() => {
        if (this.providerPaused) lastAudio = Date.now();
        else if (Date.now() - lastAudio > (started ? 30_000 : 25_000)) finish(new PublicError('Music connection timed out.'));
      }, 1000);
      const ai = new GoogleGenAI({ apiKey: key, apiVersion: 'v1alpha' });
      const connect = this.connectProvider ?? ((_key: string, params: LiveMusicConnectParameters) => ai.live.music.connect(params));
      void connect(key, { model: this.model, callbacks: {
        onmessage: message => {
          if (settled) return;
          try {
            if (message.filteredPrompt) throw new PublicError('Try a different instrumental music description.');
            for (const chunk of message.serverContent?.audioChunks ?? []) {
              if (!chunk.data) continue;
              const format = musicFormat(chunk.mimeType);
              const bytes = Buffer.from(chunk.data, 'base64');
              if (bytes.length % (2 * format.channels)) throw new PublicError('Incomplete music sample.');
              if (bytes.length > format.sampleRate * 4 * 20) throw new PublicError('Oversized music chunk.');
              lastAudio = Date.now();
              if (!started) { started = true; this.emit({ type: 'musicStatus', state: 'playing' }); }
              this.buffered += bytes.length / (format.sampleRate * format.channels * 2);
              this.emit({ type: 'music', data: chunk.data, ...format }); this.flow();
            }
          } catch (error) { finish(error); }
        },
        onerror: event => finish(new Error(event.message || 'Music connection failed.')),
        onclose: event => { if (!settled) finish(Object.assign(new Error(event.reason || 'Music connection closed.'), { status: errorStatus({ message: event.reason }) })); },
      } }).then(async connected => {
        session = connected;
        if (settled) { session.close(); return; }
        this.session = session; this.providerPaused = false;
        await session.setWeightedPrompts({ weightedPrompts: [{ text: `${this.prompt}. Instrumental only, no vocals. Leave room for spoken narration.`, weight: 1 }] });
        await session.setMusicGenerationConfig({ musicGenerationConfig: { musicGenerationMode: MusicGenerationMode.QUALITY, temperature: 1, guidance: 4.5, density: 0.3, brightness: 0.4 } });
        if (settled) return;
        session.play(); this.flow();
      }).catch(finish);
    });
  }
}
