import { z } from 'zod';
export { SAMPLE_RATE } from './audio.ts';
export const languageSchema = z.object({ name: z.string().trim().min(1).max(60), code: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/) });
export const settingsSchema = z.object({
  topic: z.string().trim().max(2000).default(''),
  style: z.string().trim().max(1200).default(''),
  expressive: z.boolean().default(false),
  speed: z.number().min(1).max(2).default(1),
  target: languageSchema.default({ name: 'Spanish', code: 'es-ES' }),
  native: languageSchema.default({ name: 'English', code: 'en-US' }),
  level: z.enum(['A1', 'A2', 'B1', 'B2', 'C1']).default('B1'),
  voice: z.enum(['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr']).default('Kore'),
  bufferMs: z.number().int().min(200).max(5000).default(400),
});
export type Settings = z.infer<typeof settingsSchema>;
export const planSchema = z.object({
  angle: z.string().min(1).max(200),
  newFacts: z.array(z.string().min(1).max(200)).min(1).max(6),
  nextThread: z.string().min(1).max(300),
  pairs: z.array(z.object({ target: z.string().min(1).max(300), native: z.string().min(1).max(400) })).min(1).max(4),
});
export type Plan = z.infer<typeof planSchema>;
export type Line = { text: string; code: string; kind: 'target' | 'native' };
export type Cue = { text: string; line: number; kind: 'target' | 'native'; startSample: number; endSample: number; observedAtSample: number };
export type ServerEvent =
  | { type: 'session'; id: string; topic: string; plannerModel: string; liveModel: string }
  | { type: 'writer'; model: string }
  | { type: 'status'; state: string; detail?: string }
  | { type: 'context'; used: number; limit: number; cumulativeInput: number; cumulativeOutput: number }
  | { type: 'turn'; turn: number; startSample: number }
  | { type: 'audio'; turn: number; startSample: number; data: string }
  | { type: 'cue'; turn: number; cue: Cue }
  | { type: 'turnEnd'; turn: number; endSample: number; coverage: number }
  | { type: 'end'; reason: string; endSample: number }
  | { type: 'error'; message: string };
const playbackDiagnosticsSchema = z.object({ firstStartSeconds: z.number().nonnegative(), underruns: z.number().int().nonnegative(),
  totalGapMs: z.number().nonnegative(), maxGapMs: z.number().nonnegative(), peakBufferedMs: z.number().nonnegative(), bufferedMs: z.number().nonnegative() });
export type PlaybackDiagnostics = z.infer<typeof playbackDiagnosticsSchema>;
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), settings: settingsSchema, keys: z.array(z.string().trim().min(10).max(256)).max(100).default([]) }),
  z.object({ type: z.literal('progress'), playedSamples: z.number().int().nonnegative(), paused: z.boolean(), playbackRate: z.number().min(1).max(2).optional(), playback: playbackDiagnosticsSchema.optional() }),
  z.object({ type: z.literal('stop') }),
]);
export function linesFor(plan: Plan, settings: Settings): Line[] {
  return plan.pairs.flatMap(pair => [
    { text: pair.target, code: settings.target.code, kind: 'target' as const },
    { text: pair.native, code: settings.native.code, kind: 'native' as const },
  ]);
}
