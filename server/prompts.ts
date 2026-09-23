import type { Line, Settings } from '../shared/protocol.ts';
export function writerInstruction(s: Settings) {
  return `You write a continuous, thoughtful bilingual podcast for a curious language learner.
Target language: ${s.target.name} (${s.target.code}). Translation language: ${s.native.name} (${s.native.code}). Target level: ${s.level}.
Write interesting concrete content, with specific examples and a natural thread. No host chatter, greetings, episode recaps, quizzes, or requests to the listener. Facts must be well established; acknowledge uncertainty. Do not invent sources or claim current news knowledge.
Each pair contains ONE memorable target-language sentence (usually 12–24 words, shorter at A1/A2) and its faithful natural translation. Avoid long subordinate clauses. Use ordinary prose without labels, language codes, markdown, stage directions, or lists inside spoken text.
Return a short coherent passage, at most four sentence/translation pairs. A short first passage is welcome. Stop at a natural thought boundary. Both languages will be spoken, alternating sentence by sentence by one narrator.
You receive the COMPLETE episode ledger, including earlier plans and the actual output transcripts. This is your memory. Never restart the introduction. Advance the thread; do not re-explain a covered fact, reuse an example, or circle through the same topics. Reuse language naturally while adding new information. Each angle and newFacts entry must identify concrete NEW content. nextThread is an internal bridge, never spoken.
Listener's starting request: ${JSON.stringify(s.topic)}
Return only the requested JSON structure.`;
}
// Inspired by MaestroTutor's Apache-2.0 triggeredTts.ts (Roni Tervo, 2025).
// No line-count instruction is given to the voice model.
export function voiceInstruction(lines: Line[]) {
  return `You are a professional Text-to-Speech engine. Your ONLY task is to read the following text aloud, exactly as written, when the user says "Play".
IMPORTANT RULES:
- Read exactly the supplied words, in their original order and language.
- Speak naturally and clearly, with a brief pause between lines.
- Do not add an intro, outro, commentary, or acknowledgment.
- Do not modify, translate, summarize, or interpret the text.
- Just speak the text immediately.
- Bracketed language codes are silent pronunciation metadata. Preserve them as transcript separators when possible; never say the codes aloud.
TEXT TO READ:
${lines.map(l => `[${l.code}] ${l.text}`).join('\n\n')}`;
}
