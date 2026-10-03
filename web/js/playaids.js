// Play aids on the game screen: the story log (G02), typical turn time (G07), the free-input draft (G08),
// the input counter (G09), the ending's way back to recent choices (G10) and the long-press menu (I02).
import { t } from './i18n.js';
import { $, esc, openModal } from './ui.js';

// ---------- story log ----------

const LOG_MAX = 200;
const LOG_TURNS = 4;   // earlier turns shown when a story is opened mid-way
let log = [];

export function logLine(line) {
  log.push({ kind: line.kind, speaker: line.speaker, text: line.text });
  if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
}

export function logTurn() { if (log.length) log.push({ kind: 'sep' }); }

// A few turns before nodeId plus nodeId's own input; nodeId's lines are logged as they play
export function seedLog(tree, protagonist, nodeId) {
  const path = [];
  for (let n = tree.nodes[nodeId]; n && path.length <= LOG_TURNS; n = tree.nodes[n.parent]) path.unshift(n);
  log = [];
  path.forEach((n, i) => {
    logTurn();
    if (n.player_input?.text) logLine({ kind: 'player', speaker: protagonist, text: n.player_input.text });
    if (i < path.length - 1) n.lines.forEach(logLine);
  });
}

export function openLog() {
  const list = $('#log-list');
  list.innerHTML = log.length ? log.map((e) => (e.kind === 'sep' ? '<hr>'
    : `<p class="log-${esc(e.kind)}">${e.kind === 'narration' ? '' : `<b>${esc(e.speaker)}</b>`}${esc(e.text)}</p>`)).join('')
    : `<p class="hint">${esc(t('log.empty'))}</p>`;
  openModal('#mdl-log');
  list.scrollTop = list.scrollHeight;
}

// ---------- typical turn time ----------

const TIMES_KEY = 'chienzhi.turnTimes';
const TIMES_KEEP = 5;
let times = [];
try { times = JSON.parse(localStorage.getItem(TIMES_KEY) || '[]').filter(Number.isFinite); } catch { /* storage blocked */ }

export function recordTurnTime(ms) {
  times = [...times, Math.round(ms / 1000)].slice(-TIMES_KEEP);
  try { localStorage.setItem(TIMES_KEY, JSON.stringify(times)); } catch { /* private mode: keep in memory */ }
}

// Average seconds of the last few turns, 0 before the first one
export function typicalTurn() {
  return times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
}

// ---------- free-input draft and counter ----------

const draftKey = (gid, nodeId) => `chienzhi.draft.${gid}.${nodeId}`;

export function loadDraft(gid, nodeId) {
  try { return sessionStorage.getItem(draftKey(gid, nodeId)) || ''; } catch { return ''; }
}

export function saveDraft(gid, nodeId, text) {
  try {
    if (text) sessionStorage.setItem(draftKey(gid, nodeId), text);
    else sessionStorage.removeItem(draftKey(gid, nodeId));
  } catch { /* storage blocked: the draft only lives in the field */ }
}

// Counts code points like the server does
export function paintCount(max) {
  const left = max - [...$('#free-input').value.trim()].length;
  $('#free-count').textContent = left >= 0 ? t('game.left', { n: left }) : t('game.over', { n: -left });
  $('#free-count').classList.toggle('over', left < 0);
  $('#free-form [type="submit"]').disabled = left < 0;
}

// ---------- ending: back to recent choices ----------

const ENDING_BACK = 3;

// The last few choices on the way to this ending; onJump(nodeId) goes back to choose again
export function paintEndingBack(tree, game, nodeId, onJump) {
  let turn = 0;
  for (let n = tree.nodes[nodeId]; n; n = tree.nodes[n.parent]) turn++;
  const rows = [];
  let child = tree.nodes[nodeId];
  for (let n = tree.nodes[child?.parent]; n && rows.length < ENDING_BACK; child = n, n = tree.nodes[n.parent]) {
    const text = t('ending.back', { n: turn - 1 - rows.length, scene: game.scenes[n.scene_id]?.name || '', chose: child.player_input?.text || '' });
    rows.push(`<button class="btn small ghost" type="button" data-back="${esc(n.id)}">${esc(text)}</button>`);
  }
  $('#ending-back').hidden = !rows.length;
  $('#ending-back .list').innerHTML = rows.join('');
  $('#ending-back').querySelectorAll('[data-back]').forEach((b) => { b.onclick = () => onJump(b.dataset.back); });
}

// ---------- long-press menu ----------

let menuFresh = false;   // a press started after the menu opened (the long press's own click must not close it)

// onRedraw: null when the press was not on the picture
export function openPressMenu(x, y, onRedraw) {
  const menu = $('#press-menu');
  $('#press-redraw').hidden = !onRedraw;
  $('#press-redraw').onclick = onRedraw;
  menuFresh = false;
  menu.hidden = false;
  const host = $('#scr-game').getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x - host.left, host.width - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(y - host.top, host.height - menu.offsetHeight))}px`;
}

document.addEventListener('pointerdown', () => { if (!$('#press-menu').hidden) menuFresh = true; }, true);
// A pick runs its action and closes the menu; a tap elsewhere only closes it
document.addEventListener('click', (e) => {
  const menu = $('#press-menu');
  if (menu.hidden) return;
  const inside = e.target.closest('#press-menu');
  if (!inside) e.stopImmediatePropagation();
  if (inside || menuFresh) menu.hidden = true;
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#press-menu').hidden = true; });
