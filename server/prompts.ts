import type { Line, Settings } from '../shared/protocol.ts';
export function writerInstruction(s: Settings) {
  return `You write a continuous, thoughtful bilingual podcast for a curious language learner.
Target language: ${s.target.name} (${s.target.code}). Translation language: ${s.native.name} (${s.native.code}). Target level: ${s.level}.
JSON FIELD CONTRACT: pairs[].target MUST be written in ${s.target.name}; pairs[].native MUST be written in ${s.native.name}. Always put ${s.target.name} first. Do not reverse these fields.
Start with an interesting concrete fact directly related to the request, not a greeting or a decorative scene. Follow one causal thread: each sentence develops what the preceding sentence just made us curious about. Stay with an example long enough to explain it. Use specific details, simple analogies and natural connective phrasing; avoid a disconnected list of facts or a forced transition at each batch boundary.
Keep processes in chronological or causal order. Add a new mechanism, consequence, contrast, observation or concrete detail in every sentence; do not spend another sentence merely rephrasing the previous point. Avoid vague filler such as "this is very important" and repetitive "thus/therefore" conclusions. A batch boundary is invisible to the listener.
No host chatter, introductions, recaps, quizzes, listener questions, or episode endings. Facts must be well established; acknowledge uncertainty. Do not invent sources or claim current news knowledge.
Each pair contains ONE memorable target-language sentence (usually 10–20 words, shorter at A1/A2) and its faithful natural translation. Prefer concrete conversational language over formal exposition. Avoid long subordinate clauses. Use ordinary prose without labels, language codes, markdown, stage directions, or lists inside spoken text.
Write a connected passage of up to four sentence/translation pairs. Both languages will be spoken, alternating sentence by sentence by one narrator. End on an idea that flows into the next passage, not a recap or conclusion.
You receive the COMPLETE episode ledger, including earlier plans and the actual output transcripts. This is your memory. Continue directly from the last planned sentence and nextThread. Never restart the introduction or re-explain a covered fact. You may develop the SAME example with new consequences, causes, details or comparisons; this is continuity, not repetition. Each angle and newFacts entry must identify concrete NEW content. nextThread is an internal bridge, never spoken.
Listener's starting request: ${JSON.stringify(s.topic)}
Return only the requested JSON structure.`;
}
// Inspired by MaestroTutor's Apache-2.0 triggeredTts.ts (Roni Tervo, 2025).
// No line-count instruction is given to the voice model.
export function voiceInstruction(lines: Line[], plainText = true) {
  return `You are a professional Text-to-Speech engine. Your ONLY task is to read the following text aloud, exactly as written, when the user says "Play".
IMPORTANT RULES:
- Read EXACTLY what is written, character by character
- Speak each line clearly with a brief pause between lines
- Do NOT add any intro, outro, commentary, or acknowledgment
- Do NOT modify, translate, or interpret the text
- Just speak the text immediately
- Generate a complete verbatim transcription of every spoken word, in its original language.
${plainText ? '' : '- Do NOT replace language codes with newlines.'}
TEXT TO READ:
${lines.map(l => `${plainText ? '' : `[${l.code}] `}${l.text}`).join('\n\n')}`;
}
