import { GoogleGenAI, Modality, type LiveConnectConfig, type LiveConnectParameters, type Session } from '@google/genai';
import type { Cue, Line } from '../shared/protocol.ts';
import { PublicError, errorStatus } from './keys.ts';
import { voiceInstruction } from './prompts.ts';
import { TranscriptClock } from './transcript.ts';

export type LiveResult = { transcript: string; samples: number; coverage: number; lineCoverage: number[]; cues: Cue[] };
export type LiveOptions = { key: string; model: string; voice: string; lines: Line[]; signal: AbortSignal;
  onAudio: (data: string, startSample: number) => void; onCue: (cue: Cue) => void; timeoutMs?: number;
  connect?: (params: LiveConnectParameters) => Promise<Session> };
export function liveConfig(model: string, voice: string, lines: Line[]): LiveConnectConfig {
  return { responseModalities: [Modality.AUDIO], outputAudioTranscription: {},
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    systemInstruction: voiceInstruction(lines),
    ...(model.startsWith('gemini-2.5-') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
  };
}
export async function narrate(options: LiveOptions): Promise<LiveResult> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let session: Session | undefined;
    let settled = false;
    let samples = 0;
    const clock = new TranscriptClock(options.lines, options.onCue);
    const timeout = setTimeout(() => finish(new PublicError('The voice turn timed out. Start again to continue listening.')), options.timeoutMs ?? 100_000);
    const abort = () => finish(options.signal.reason ?? new DOMException('Stopped', 'AbortError'));
    options.signal.addEventListener('abort', abort, { once: true });
    function finish(error?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      try { session?.close(); } catch { /* Closed by provider. */ }
      if (error) reject(error);
      else {
        clock.finish(samples);
        if (!samples || !clock.raw.trim()) reject(new PublicError('Live returned no audio or no spoken transcript. Planned text was not substituted.'));
        else resolve({ transcript: clock.raw, samples, coverage: clock.coverage, lineCoverage: clock.lineCoverage, cues: clock.cues });
      }
    }
    const ai = new GoogleGenAI({ apiKey: options.key, httpOptions: { apiVersion: 'v1alpha' } });
    const connect = options.connect ?? ((params: LiveConnectParameters) => ai.live.connect(params));
    void connect({ model: options.model, config: liveConfig(options.model, options.voice, options.lines),
      callbacks: {
        onopen() {},
        onmessage(message) {
          if (settled) return;
          try {
            const content = message.serverContent;
            if (content?.interrupted) return finish(new PublicError('The voice turn was interrupted. Partial audio will not be replayed.'));
            for (const part of content?.modelTurn?.parts ?? []) {
              if (!part.inlineData?.data) continue;
              if (!part.inlineData.mimeType?.startsWith('audio/pcm')) throw new PublicError('Live returned an unsupported audio format.');
              const rate = part.inlineData.mimeType.match(/rate=(\d+)/)?.[1];
              if (rate && rate !== '24000') throw new PublicError('Live changed its output sample rate.');
              const bytes = Buffer.from(part.inlineData.data, 'base64');
              if (bytes.length % 2) throw new PublicError('Live returned an incomplete PCM sample.');
              options.onAudio(part.inlineData.data, samples);
              samples += bytes.length / 2;
              clock.audio(samples);
              if (samples > 24_000 * 100) throw new PublicError('The voice exceeded the short-passage limit.');
            }
            if (content?.outputTranscription?.text) clock.add(content.outputTranscription.text, samples);
            if (content?.turnComplete) finish();
          } catch (error) { finish(error); }
        },
        onerror(event) { finish(new Error(event.message || 'Live connection failed')); },
        onclose(event) {
          if (!settled) finish(Object.assign(new PublicError(`Live connection closed before the passage completed (code ${event.code}).`),
            { status: errorStatus({ message: event.reason }) || (event.code === 1006 ? 503 : 0) }));
        },
      },
    }).then(connection => {
      session = connection;
      if (settled) { connection.close(); return; }
      connection.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Play' }] }], turnComplete: true });
    }).catch(finish);
  });
}
