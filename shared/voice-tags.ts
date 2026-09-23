/** Audible delivery cues, adapted from MaestroTutor's VOICE_TAG_PERSONA_GUIDELINES (Apache-2.0). */
export const VOICE_TAGS = ['curious', 'excited', 'happy', 'sad', 'surprised', 'contemplative', 'whispering',
  'muttering', 'annoyed', 'unbelieving', 'laughing', 'chuckles', 'sighs', 'gasps', 'clears throat', 'short pause'] as const;
const tag = new RegExp(`\\[(?:${VOICE_TAGS.join('|')})\\]`, 'gi');
export function stripVoiceTags(text: string) { return text.replace(tag, ''); }
export function hasVoiceTags(text: string) { return stripVoiceTags(text) !== text; }
export function invalidVoiceTag(text: string) { return stripVoiceTags(text).match(/\[[^\]]*\]/)?.[0] ?? null; }
