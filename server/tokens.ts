import type { Content } from '@google/genai';
import { PublicError } from './keys.ts';

export type TokenRequest = { key: string; model: string; contents: Content[]; system: string; signal: AbortSignal };
// The JS SDK rejects countTokens.config.systemInstruction on the Developer API.
// REST supports generateContentRequest, which counts the real system + complete history.
export async function countFullRequest(request: TokenRequest, transport = fetch): Promise<number> {
  const model = request.model.replace(/^models\//, '');
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new PublicError('Invalid planner model name.');
  const response = await transport(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': request.key },
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    body: JSON.stringify({ generateContentRequest: { model: `models/${model}`, contents: request.contents,
      systemInstruction: { parts: [{ text: request.system }] } } }),
  });
  if (!response.ok) throw Object.assign(new Error(`Token counting failed (${response.status})`), { status: response.status });
  const result = await response.json() as { totalTokens?: number };
  if (!Number.isSafeInteger(result.totalTokens) || result.totalTokens! < 0) throw new PublicError('Token counting failed. Episode history remains intact.');
  return result.totalTokens!;
}
