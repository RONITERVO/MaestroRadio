import './style.css';
import type { Cue, ServerEvent, Settings } from '../shared/protocol.ts';
import { SAMPLE_RATE } from '../shared/audio.ts';
import { StreamPlayer } from './player.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const languages = [
  ['es-ES','Spanish'], ['en-US','English'], ['fi-FI','Finnish'], ['fr-FR','French'], ['de-DE','German'], ['it-IT','Italian'],
  ['pt-BR','Portuguese'], ['sv-SE','Swedish'], ['nl-NL','Dutch'], ['pl-PL','Polish'], ['tr-TR','Turkish'], ['el-GR','Greek'],
  ['ru-RU','Russian'], ['uk-UA','Ukrainian'], ['ja-JP','Japanese'], ['ko-KR','Korean'], ['cmn-CN','Mandarin Chinese'],
  ['ar-XA','Arabic'], ['hi-IN','Hindi'], ['bn-IN','Bengali'], ['id-ID','Indonesian'], ['vi-VN','Vietnamese'], ['th-TH','Thai'], ['ro-RO','Romanian'],
];
for (const id of ['target','native']) for (const [code, name] of languages) {
  const option = new Option(name, code); $(id).append(option);
}
$<HTMLSelectElement>('native').value = 'en-US';
const preferences = ['target','native','level','voice','buffer'];
try { const saved = JSON.parse(localStorage.getItem('maestro-radio-preferences') || '{}');
  for (const id of preferences) if (typeof saved[id] === 'string') $<HTMLSelectElement>(id).value = saved[id];
} catch { /* Storage unavailable or obsolete preferences. */ }
function savePreferences() {
  try { localStorage.setItem('maestro-radio-preferences', JSON.stringify(Object.fromEntries(preferences.map(id => [id, $<HTMLSelectElement>(id).value])))); } catch { /* Private browsing. */ }
}
let configured = false;
void fetch('/api/config').then(r => r.json()).then(config => {
  configured = config.configured;
  $('key-note').textContent = configured ? 'Server keys ready. Settle in and listen.' : 'Add your Gemini key in Settings to begin.';
  $('model-info').textContent = `WRITER ${config.plannerModel}\nVOICE ${config.liveModel}\nSERVER ${config.plannerKeys} writer keys · ${config.liveKeys} voice keys`;
}).catch(() => notice('The local server is unavailable.'));
const dialog = $<HTMLDialogElement>('settings-dialog');
$('settings-button').onclick = () => dialog.showModal();
dialog.addEventListener('close', savePreferences);
let socket: WebSocket | undefined;
let player: StreamPlayer | undefined;
let active = false;
let starting = false;
let ending: { reason: string; sample: number } | undefined;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let animation = 0;
let cues: { turn: number; cue: Cue }[] = [];
let cueIndex = 0;
let cueChars = 0;
let revealed: { turn: number; line: number; kind: string; text: string }[] = [];
let elements = new Map<string, HTMLElement>();
let currentLine = '';
let follow = true;
let episodeId = '';
let lastTextAt = 0;
let endedWithError = false;

function notice(message: string) { $('notice').textContent = message; $('notice').hidden = false; }
function setStatus(text: string) { $('status').textContent = text; }
function sendProgress() {
  if (socket?.readyState === WebSocket.OPEN && player) socket.send(JSON.stringify({ type: 'progress', playedSamples: player.playedSamples, paused: player.paused || player.context.state !== 'running' }));
}
window.addEventListener('scroll', () => { follow = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 180; }, { passive: true });
function reveal(turn: number, cue: Cue, text: string) {
  if (!text) return;
  $('episode-topic').parentElement!.hidden = true;
  const key = `${turn}:${cue.line}`;
  let element = elements.get(key);
  if (!element) {
    if (!text.trim()) return;
    element = document.createElement('p');
    element.className = `spoken-line ${cue.kind}`;
    element.lang = $<HTMLSelectElement>(cue.kind === 'target' ? 'target' : 'native').value;
    element.dir = 'auto';
    $('transcript').append(element); elements.set(key, element);
    revealed.push({ turn, line: cue.line, kind: cue.kind, text: '' });
    // Bound the rendered history, retain the complete spoken text for export.
    if (elements.size > 120) { const first = elements.keys().next().value!; elements.get(first)?.remove(); elements.delete(first); }
  }
  element.append(document.createTextNode(text));
  const record = revealed[revealed.length - 1];
  if (record.turn === turn && record.line === cue.line) record.text += text;
  if (currentLine !== key) {
    currentLine = key;
    const all = [...elements.values()];
    all.forEach((item, index) => item.classList.toggle('older', index < all.length - 2));
  }
  lastTextAt = performance.now();
  if (follow) element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function tick() {
  if (!player || !active) return;
  const sample = player.playedSamples;
  while (cueIndex < cues.length) {
    const { turn, cue } = cues[cueIndex];
    if (sample < cue.startSample) break;
    const characters = Array.from(cue.text);
    const fraction = cue.endSample <= cue.startSample ? 1 : Math.min(1, (sample - cue.startSample) / (cue.endSample - cue.startSample));
    const count = Math.floor(characters.length * fraction);
    reveal(turn, cue, characters.slice(cueChars, count).join(''));
    cueChars = count;
    if (fraction < 1) break;
    cueChars = 0; cueIndex++;
  }
  if (cueIndex > 500) { cues.splice(0, cueIndex); cueIndex = 0; }
  const seconds = Math.floor(sample / SAMPLE_RATE);
  $('elapsed').textContent = `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(seconds % 60).padStart(2,'0')}`;
  $('waiting').hidden = player.paused || performance.now() - lastTextAt < 1800 || !!ending;
  if (ending && sample >= ending.sample) { complete(); return; }
  animation = requestAnimationFrame(tick);
}
function complete() {
  active = false;
  clearInterval(progressTimer);
  sendProgress();
  socket?.close();
  void player?.stop();
  $('pause').hidden = true;
  $('waiting').hidden = true;
  $('stop').textContent = 'New episode ↗';
  setStatus(ending?.reason === 'context-full' ? 'Memory complete' : endedWithError ? 'Stream ended' : 'Episode ended');
  if (ending?.reason === 'context-full') notice('This episode has filled the writer’s memory. Its complete history is saved; begin a new episode when you’re ready.');
}
function handle(event: ServerEvent) {
  if (!active || !player) return;
  switch (event.type) {
    case 'session': episodeId = event.id; $('episode-topic').textContent = event.topic; break;
    case 'status': if (!player.paused) setStatus(event.state === 'planning' ? 'Following a thought' : 'On air'); break;
    case 'context': {
      const percent = Math.min(100, event.used / event.limit * 100);
      $('context-label').textContent = `${percent.toFixed(1)}% MEMORY`;
      $('context-fill').style.width = `${percent}%`;
      $('context-label').parentElement!.title = `${event.used.toLocaleString()} / ${event.limit.toLocaleString()} context tokens. Total writer input billed: ${event.cumulativeInput.toLocaleString()} tokens; output: ${event.cumulativeOutput.toLocaleString()} tokens.`;
      break;
    }
    case 'audio': player.add(event.data, event.startSample); break;
    case 'cue': cues.push({ turn: event.turn, cue: event.cue }); break;
    case 'error': endedWithError = true; notice(event.message); setStatus('Stream issue'); break;
    case 'end': ending = { reason: event.reason, sample: event.endSample }; break;
  }
}
async function start(random: boolean) {
  if (active || starting) return;
  const keys = $<HTMLTextAreaElement>('keys').value.split(/[\s,;]+/).filter(Boolean);
  if (!keys.length && !configured) { dialog.showModal(); $<HTMLTextAreaElement>('keys').focus(); return; }
  const targetCode = $<HTMLSelectElement>('target').value;
  const nativeCode = $<HTMLSelectElement>('native').value;
  if (targetCode === nativeCode) { notice('Choose two different languages.'); return; }
  savePreferences();
  const target = { code: targetCode, name: languages.find(([code]) => code === targetCode)![1] };
  const native = { code: nativeCode, name: languages.find(([code]) => code === nativeCode)![1] };
  const settings: Settings = { topic: random ? '' : $<HTMLInputElement>('topic').value, target, native,
    level: $<HTMLSelectElement>('level').value as Settings['level'], voice: $<HTMLSelectElement>('voice').value as Settings['voice'], bufferMs: Number($<HTMLSelectElement>('buffer').value) };
  cues = []; cueIndex = 0; cueChars = 0; revealed = []; elements.clear(); currentLine = ''; ending = undefined;
  endedWithError = false; follow = true; lastTextAt = performance.now(); episodeId = '';
  $('transcript').replaceChildren(); $('notice').hidden = true;
  player = new StreamPlayer(settings.bufferMs);
  starting = true;
  try { await player.unlock(); } catch { await player.stop(); notice('Audio could not start. Allow audio in this browser and try again.'); return; }
  finally { starting = false; }
  active = true;
  $('setup').hidden = true; $('idle-footer').hidden = true; $('listening').hidden = false; $('transport').hidden = false;
  $('pause').hidden = false; $('pause').textContent = 'Ⅱ'; $('pause').setAttribute('aria-label', 'Pause playback'); $('stop').innerHTML = 'End <span aria-hidden="true">■</span>';
  $('episode-topic').textContent = settings.topic || 'Somewhere unexpected';
  $('episode-topic').parentElement!.hidden = false;
  setStatus('Connecting');
  window.scrollTo(0, 0);
  const currentSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`);
  socket = currentSocket;
  currentSocket.onopen = () => { if (socket === currentSocket && active) currentSocket.send(JSON.stringify({ type: 'start', settings, keys })); };
  currentSocket.onmessage = message => {
    if (socket !== currentSocket) return;
    try { handle(JSON.parse(message.data)); } catch { notice('Playback received an invalid audio stream.'); void stop(); }
  };
  currentSocket.onerror = () => { if (socket === currentSocket) notice('Could not connect to the local audio server.'); };
  currentSocket.onclose = () => {
    if (socket !== currentSocket || !active || ending) return;
    notice('Connection ended. Start a new episode to reconnect.'); void stop();
  };
  progressTimer = setInterval(sendProgress, 500);
  animation = requestAnimationFrame(tick);
}
async function stop() {
  if (socket?.readyState === WebSocket.OPEN) { sendProgress(); socket.send(JSON.stringify({ type: 'stop' })); }
  active = false; cancelAnimationFrame(animation); clearInterval(progressTimer);
  await player?.stop(); socket?.close();
  $('pause').hidden = true; $('waiting').hidden = true; $('stop').textContent = 'New episode ↗'; setStatus('Episode ended');
}
$('start-form').onsubmit = event => { event.preventDefault(); void start(false); };
$('random').onclick = () => { void start(true); };
$('pause').onclick = async () => {
  await player?.togglePause(); sendProgress();
  $('pause').textContent = player?.paused ? '▶' : 'Ⅱ';
  $('pause').setAttribute('aria-label', player?.paused ? 'Resume playback' : 'Pause playback');
  setStatus(player?.paused ? 'Paused' : 'On air');
};
$('stop').onclick = () => {
  if (active) { void stop(); return; }
  $('listening').hidden = true; $('transport').hidden = true; $('setup').hidden = false; $('idle-footer').hidden = false; $('notice').hidden = true;
};
$('export').onclick = () => {
  const text = revealed.map(item => item.text.trim()).filter(Boolean).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `maestro-radio-${episodeId || 'episode'}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', () => { void stop(); });
