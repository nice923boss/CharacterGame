// Game screen controller: plays a node's lines with a typewriter, runs turns over SSE, handles scene
// changes, asset polling, save/load, the node tree and jumping back to an older node.
import { del, get, job, post } from './api.js?v=a2430d6da8c1';
import { sound } from './sound.js?v=a2430d6da8c1';
import { LIMIT_SCALE, t } from './i18n.js?v=a2430d6da8c1';
import {
  $, closeModal, confirmBox, esc, helpNode, loadThumbs, openModal, paintWait, progress, settings, statusText, thumbAttr, toast,
  toastError,
} from './ui.js?v=a2430d6da8c1';
import { renderTree, untakenOptions } from './tree.js?v=a2430d6da8c1';
import {
  loadDraft, logLine, logTurn, openLog, openPressMenu, paintCount, paintEndingBack, recordTurnTime, safeEnd, saveDraft, seedLog,
  typicalTurn,
} from './playaids.js?v=a2430d6da8c1';

const G = {
  stage: null, game: null, tree: null, assets: null, currentId: null,
  queue: [], typing: null, waitingClick: false, final: null, running: null, turnStart: 0,
  sceneId: null, pendingScene: null, castExpr: {}, onExit: null, pollTimer: null, loadTimer: null, lastInput: null,
  paintClock: null, hiddenAt: 0, skip: false, readyAt: 0, maxInput: 120,
  choiceTimer: null, startTimer: null, cardTimer: null,   // one-shot delays that must not fire into another node
};

// One-shot delays cleared when a node is entered or the game is left
function clearDelays() {
  clearTimeout(G.choiceTimer);
  clearTimeout(G.startTimer);
  clearTimeout(G.cardTimer);
  G.choiceTimer = G.startTimer = G.cardTimer = null;
}

// Screen readers hear new lines, choices and endings through a polite live region
function announce(text) { $('#game-live').textContent = text; }

// ---------- asset urls ----------

function spriteUrl(cid, expr) {
  const s = G.assets?.sprites?.[cid];
  if (!s) return null;
  const pick = s[expr]?.state === 'done' ? expr : s.calm?.state === 'done' ? 'calm' : null;
  if (!pick) return null;
  return s[pick].url || `/media/${G.game.id}/assets/sprites/${cid}/${pick}.png?v=${s[pick].v}`;
}

function sceneUrl(sid) {
  const s = G.assets?.scenes?.[sid];
  if (s?.state !== 'done') return null;
  return s.url || `/media/${G.game.id}/assets/scenes/${sid}.png?v=${s.v}`;   // url: browser-side (Pages) build
}

const sceneQuery = () => (G.sceneId ? `?scene=${encodeURIComponent(G.sceneId)}` : '');

// One assets request at a time (the timer, window focus and a finished turn can all ask at once); a request made
// while one is out runs once after it, so a new scene is not missed
let polling = false;
let pollAgain = false;

async function pollAssets() {
  if (!G.game) return;
  if (polling) { pollAgain = true; return; }
  polling = true;
  try { await pollOnce(); } finally {
    polling = false;
    if (pollAgain) { pollAgain = false; pollAssets(); }
  }
}

async function pollOnce() {
  const gid = G.game.id;
  let assets;
  // Polling also re-queues missing images (after a server restart); only the window the player is looking at
  // (focus=1) puts this game's images first, so the last one used wins
  const front = document.visibilityState === 'visible' && document.hasFocus();
  const query = sceneQuery() + (front ? `${G.sceneId ? '&' : '?'}focus=1` : '');
  try { assets = await get(`/api/games/${gid}/assets${query}`); } catch { return; }
  if (G.game?.id !== gid) return;   // left or switched game while waiting
  G.assets = assets;
  const url = sceneUrl(G.sceneId);
  G.stage.setPending(!url);
  if (url) G.stage.setScene(url);
  for (const cid of G.stage.castIds()) G.stage.show(cid, spriteUrl(cid, G.castExpr[cid] || 'calm'));
  paintAssetChip();
}

// Every image of this game with a label for the chip's list
function assetItems() {
  const items = [];
  for (const [sid, a] of Object.entries(G.assets?.scenes || {})) {
    items.push({ ...a, label: t('chip.itemScene', { name: G.game.scenes[sid]?.name || sid }) });
  }
  for (const [cid, set] of Object.entries(G.assets?.sprites || {})) {
    const name = G.game.characters.find((c) => c.id === cid)?.name || cid;
    for (const [e, a] of Object.entries(set)) items.push({ ...a, label: t('chip.itemSprite', { name, expr: t(`expr.${e}`) }) });
  }
  return items;
}

// Corner chip: failed images in red (click for the reasons and a retry), else the image queue
function paintAssetChip() {
  const chip = $('#asset-chip');
  const items = assetItems();
  const failed = items.filter((a) => a.state === 'error').length;
  const waiting = items.filter((a) => a.retry_in != null);
  const queue = G.assets?.queue || 0;
  chip.classList.toggle('error', failed > 0);
  if (failed) chip.textContent = t('chip.failed', { n: failed });
  else if (G.assets?.paused) chip.textContent = t('chip.paused', { n: queue });
  else if (waiting.length && waiting.length === queue) {
    chip.textContent = t('chip.waitRetry', { n: queue, s: Math.min(...waiting.map((a) => a.retry_in)) });
  } else chip.textContent = t('chip.drawing', { n: queue });
  chip.hidden = !failed && !queue;
}

const CHIP_LIST_MAX = 6;

async function showAssetProblems() {
  if (!G.game) return;
  const gid = G.game.id;
  const items = assetItems().filter((a) => a.state === 'error' || a.retry_in != null);
  if (!items.length) { toast(t('chip.none')); return; }
  const lines = items.slice(0, CHIP_LIST_MAX).map((a) => {
    const p = { label: a.label, error: String(a.error || '').slice(0, 80), s: a.retry_in };
    return t(a.state === 'error' ? 'chip.line' : 'chip.lineWait', p);
  });
  if (items.length > CHIP_LIST_MAX) lines.push(t('chip.more', { n: items.length - CHIP_LIST_MAX }));
  if (!(await confirmBox([t('chip.title'), ...lines].join('\n'), t('chip.retryAll'))) || G.game?.id !== gid) return;
  try {
    G.assets = await post(`/api/games/${gid}/assets/retry${sceneQuery()}`);
    toast(t('chip.retried'));
    paintAssetChip();
  } catch (e) { toastError(e); }
}

// Right-click (a long press on touch) on the scene or a character draws it again
async function askRedraw(x, y) {
  const hit = G.game && G.stage.hit(x, y);
  if (!hit) return;
  const gid = G.game.id;
  const { kind } = hit;
  const target = kind === 'scene' ? G.sceneId : hit.cid;
  if (!target) return;
  const mode = (await get('/api/settings').catch(() => ({}))).image_mode;
  if (mode === 'off') { toast(t('err.images_off'), true); return; }
  let text;
  if (kind === 'scene') text = t('redraw.scene', { name: G.game.scenes[target]?.name || target });
  else {
    const name = G.game.characters.find((c) => c.id === target)?.name || target;
    // Basic mode draws only the calm portrait again; the other expressions are cleared so none keeps the old look
    text = mode === 'basic' ? t('redraw.spriteBasic', { name })
      : t('redraw.sprite', { name, n: Object.keys(G.assets?.sprites?.[target] || {}).length });
  }
  const answer = await confirmBox(text, t('redraw.ok'), t('redraw.newSeed'));
  if (!answer || G.game?.id !== gid) return;
  try {
    G.assets = await post(`/api/games/${gid}/assets/redraw`, { kind, target, new_seed: answer.checked });
    toast(t('redraw.started'));
    paintAssetChip();
  } catch (e) { toastError(e); }
}

// Loading panel: shown while the scene or an on-stage sprite is still being drawn or downloaded, so a blank
// stage never looks like a failure. Downloads show real byte progress; drawing has no known length.
const LOADING_SHOW_AFTER = 2;   // ticks of 250 ms, so images already in the cache never flash the panel
let loadingTicks = 0;

function paintLoading() {
  if (!G.game) return;
  G.stage.refreshScene();   // also swaps in a scene that finished loading while no line was typing
  const sc = G.assets?.scenes?.[G.sceneId];
  const sprites = G.assets?.sprites || {};
  const given = (a) => !['error', 'off'].includes(a?.state);   // failed or not drawn in this image mode
  const waits = G.stage.waiting().filter((w) => (w.url ? true : w.kind === 'scene' ? given(sc) : given(sprites[w.cid]?.calm)));
  const box = $('#stage-loading');
  loadingTicks = waits.length ? loadingTicks + 1 : 0;
  if (loadingTicks < LOADING_SHOW_AFTER) { box.hidden = true; return; }
  const parts = new Set(waits.map((w) => {
    if (w.kind === 'sprite') return t(w.url ? 'load.sprite' : 'load.spriteDrawing');
    if (sc?.state === 'running') return t('chip.sceneRunning');
    if (sc?.state === 'queued') return t('chip.sceneQueued', { n: sc.ahead ?? 0 });
    return t('load.scene');   // downloading, or done but the stage is still fading to it
  }));
  const known = waits.every((w) => w.url && w.total);
  const pct = known ? Math.min(99, Math.floor(100 * waits.reduce((a, w) => a + w.loaded, 0)
    / waits.reduce((a, w) => a + w.total, 0))) : null;
  $('#stage-loading p').textContent = [...parts].join(t('load.sep')) + (pct === null ? '' : ` ${pct}%`);
  const bar = $('#stage-loading .batch-bar');
  bar.classList.toggle('indet', pct === null);
  bar.firstElementChild.style.width = pct === null ? '' : `${pct}%`;
  box.hidden = false;
}

// ---------- line playback ----------

const BREAK_AFTER = '。！？…，、；：」』） .,!?;:';

// Split text into pages that fit the dialog box, preferring to break after punctuation
function pages(text) {
  const el = $('#dialog-text');
  const box = $('#dialog');
  const cs = getComputedStyle(box);
  const room = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (room <= 0) return [text];
  const shown = el.textContent;
  const fits = (s) => { el.textContent = s; return el.scrollHeight <= room + 1; };
  const out = [];
  let rest = text;
  while (rest && !fits(rest)) {
    let lo = 1, hi = rest.length - 1;   // longest prefix that fits
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(rest.slice(0, mid))) lo = mid; else hi = mid - 1; }
    const from = Math.floor(lo * 0.6);  // only look for punctuation in the last part, so pages stay full
    const cut = Math.max(...[...BREAK_AFTER].map((c) => rest.slice(from, lo).lastIndexOf(c)));
    const n = safeEnd(rest, cut >= 0 ? from + cut + 1 : lo);
    out.push(rest.slice(0, n));
    rest = rest.slice(n).trimStart();
  }
  el.textContent = shown;
  return [...out, rest];
}

function showLine(line) {
  if (!line.of) logLine(line);   // later pages of a long line, and a line shown again, are logged already
  // A line too long for the box shows its first page; the rest waits at the front of the queue
  const [first, ...more] = pages(line.text);
  if (more.length) G.queue.unshift(...more.map((text) => ({ ...line, text, of: line.of || line })));
  line = { ...line, text: first };
  // Read out whole pages; fast-forward would only pile up speech
  const colon = G.game?.lang === 'en' ? ': ' : '：';
  if (!G.skip) announce(line.kind === 'narration' || !line.speaker ? line.text : `${line.speaker}${colon}${line.text}`);
  const box = $('#dialog');
  box.classList.toggle('narration', line.kind === 'narration');
  box.classList.toggle('player', line.kind === 'protagonist' || line.kind === 'player');
  $('#nameplate').hidden = line.kind === 'narration';
  $('#nameplate').textContent = line.speaker;
  if (line.char_id) {
    G.castExpr[line.char_id] = line.expr;
    G.stage.show(line.char_id, spriteUrl(line.char_id, line.expr));
    G.stage.setSpeaker(line.char_id);
  } else {
    G.stage.setSpeaker(line.kind === 'narration' ? null : '-');
  }
  G.typing = { text: line.text, n: 0, t0: performance.now() };
  $('#dialog-next').hidden = true;
  $('#dialog-wait').hidden = true;
}

const SKIP_MS = 80;   // one line every 80 ms while Ctrl is held

function typeStep() {
  if (G.stage) G.stage.refreshScene();
  const T = G.typing;
  if (T) {
    if (G.skip && !document.querySelector('.modal:not([hidden])')) T.t0 = -1e9;   // a dialog on top pauses fast-forward
    const n = Math.min(T.text.length, Math.floor((performance.now() - T.t0) / 1000 * settings.speed));
    if (n !== T.n) { T.n = n; $('#dialog-text').textContent = T.text.slice(0, safeEnd(T.text, n)); }
    if (n >= T.text.length) { G.typing = null; afterLine(); }
  } else if (G.waitingClick && G.queue.length && !document.querySelector('.modal:not([hidden])')) {
    // Auto-advance (G03) and Ctrl fast-forward (G04); both stop where the player has to choose
    const wait = G.skip ? SKIP_MS : settings.auto * 1000;
    if (wait && performance.now() - G.readyAt >= wait) advance();
  }
  requestAnimationFrame(typeStep);
}

function afterLine() {
  G.readyAt = performance.now();
  if (G.queue.length) { G.waitingClick = true; $('#dialog-next').hidden = false; return; }
  if (G.failAfter) { const fail = G.failAfter; G.failAfter = null; fail(); return; }
  if (G.final) { finishTurn(); return; }
  // More lines are still streaming: keep this one on screen until the player clicks
  if (G.running) { G.waitingClick = true; $('#dialog-wait').hidden = false; }
}

function advance() {
  if (!$('#choices').hidden) return;
  if (G.typing) { G.typing.t0 = -1e9; return; }
  if (G.queue.length) { G.waitingClick = false; if (!G.skip) sound.play('click'); showLine(G.queue.shift()); }
}

function pushLine(line) {
  G.queue.push(line);
  if (!G.typing && !G.waitingClick) advance();
  else if (!G.typing) { $('#dialog-next').hidden = false; $('#dialog-wait').hidden = true; }
}

// All lines of the turn are read and the node is known: scene change, then choices
function finishTurn() {
  $('#dialog-skip').hidden = true;
  const node = G.final;
  G.final = null;
  G.waitingClick = false;
  const change = node.scene_id !== G.sceneId;
  G.sceneId = node.scene_id;
  if (change) {
    sound.play('scene');
    // The transition clears the stage; bring back whoever spoke this turn, same as loading this node
    const cast = castFor(node);
    G.stage.setScene(sceneUrl(node.scene_id), { transition: true, onSwap: () => {
      sceneCard(node.scene_id);
      G.stage.setCast(cast.map((cid) => ({ cid, url: spriteUrl(cid, G.castExpr[cid]) })));
    } });
    G.stage.setPending(!sceneUrl(node.scene_id));
    paintAssetChip();
    G.choiceTimer = setTimeout(() => { G.choiceTimer = null; showChoices(node); }, 1400);
  } else {
    showChoices(node);
  }
}

function sceneCard(sid) {
  const card = $('#scene-card');
  card.textContent = G.game.scenes[sid]?.name || '';
  card.hidden = false;
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  announce(card.textContent);
  clearTimeout(G.cardTimer);   // an earlier card's timer would hide this one early
  G.cardTimer = setTimeout(() => { card.hidden = true; }, 3300);
}

function showChoices(node) {
  if (node.result.ending) { showEnding(node); return; }
  const taken = new Set(node.children.map((c) => G.tree.nodes[c]?.player_input?.text?.trim()).filter(Boolean));
  $('#options').innerHTML = node.result.options.map((o, i) =>
    `<button class="btn" data-i="${i}">${esc(o)}${taken.has(o.trim()) && !G.game.batch ? `<small>${esc(t('game.taken'))}</small>` : ''}</button>`).join('');
  $('#options').querySelectorAll('.btn').forEach((b) => {
    b.onclick = () => sendInput('option', node.result.options[Number(b.dataset.i)]);
  });
  // A failed send comes back as it was; otherwise what was typed at this turn earlier in the session (G08)
  $('#free-input').value = G.lastInput?.kind === 'free' && G.lastInput.failed ? G.lastInput.text : loadDraft(G.game.id, node.id);
  paintCount(G.maxInput);
  $('#choices').hidden = false;
  $('#dialog-wait').hidden = true;
  setBusy(false);
  // The options group takes focus (not the first button, so a Space meant for the last line picks nothing); Tab
  // reaches the buttons. Left alone while a dialog or a text field has the keyboard.
  $('#options').setAttribute('aria-label', t('game.optionsLabel'));
  const at = document.activeElement;
  if (!document.querySelector('.modal:not([hidden])') && !at?.closest?.('input, textarea, select')) $('#options').focus({ preventScroll: true });
  announce(t('game.choicesReady', { n: node.result.options.length }));
}

// The branch ended: an ending card instead of choices
function showEnding(node) {
  const { ending } = node.result;
  $('#ending-kind').textContent = t(ending.type === 'good' ? 'ending.good' : 'ending.bad');
  $('#ending').classList.toggle('bad', ending.type !== 'good');
  $('#ending-title').textContent = ending.title;
  paintEndingBack(G.tree, G.game, node.id, (id) => enterGame(G.stage, G.game.id, id, G.onExit));
  $('#ending').hidden = false;
  $('#dialog-wait').hidden = true;
  setBusy(false);
  if (!document.querySelector('.modal:not([hidden])')) $('#ending').focus({ preventScroll: true });
  announce(`${$('#ending-kind').textContent}${t('common.colon')}${ending.title}`);
}

// ---------- turns ----------

// While a turn is written only leaving the turn is blocked; the log, settings and saving stay open (G06)
function setBusy(busy) {
  document.querySelectorAll('#toolbar [data-act="tree"], #toolbar [data-act="load"]').forEach((b) => { b.disabled = busy; });
  // A save made meanwhile keeps the turn the input was sent from
  document.querySelectorAll('#scr-game [data-act="save"]').forEach((b) => { b.disabled = !G.currentId; });
}

function paintRetry(text) {
  $('#retry-text').textContent = text;
  $('#retry').hidden = !text;
  if (!text) { $('#retry-now').hidden = true; paintWait($('#retry'), null); }
}

// Errors from the network rather than the story: worth sending again once it is back
const NET_CODES = ['offline', 'dropped', 'relay_unreachable'];
const NET_REASONS = ['network', 'connect'];
const isNetwork = (e) => NET_CODES.includes(e.code) || (e.code === 'all_failed' && !!e.params?.errors?.length
  && e.params.errors.every((x) => NET_REASONS.includes(x.reason)));

// code: error code that gets a "what to do" line (C10)
function paintFailed(msg, code = '') {
  const opening = G.lastInput?.kind === 'opening';
  $('#failed').hidden = !msg;
  $('#failed-text').textContent = msg || '';
  $('#failed-help').replaceChildren(helpNode(code) || '');
  $('#failed-retry').textContent = t(opening ? 'game.retryOpening' : 'game.retry');
  $('#failed-exit').hidden = !opening;
  $('#free-form').hidden = !!msg && opening;
}

// The turn did not go through: the screen stays where it was, with the same input one click away.
// msg null (the player cancelled): no failure row
function failTurn(msg, network = false, code = '') {
  const hidden = document.hidden || G.hiddenAt >= G.turnStart;   // the page was in the background meanwhile
  G.lastInput = { ...G.lastInput, failed: true, network, hidden };
  const cur = G.tree.nodes[G.currentId];
  if (cur) showChoices(cur);
  else {   // the opening: no choices yet, only the failure row
    $('#options').innerHTML = '';
    $('#choices').hidden = false;
    $('#dialog-wait').hidden = true;
    setBusy(false);
  }
  paintFailed(msg && G.lastInput.kind === 'opening' ? t('game.openingFailed', { msg }) : msg, code);
  // A phone cut the turn off in the background and the page is back: send it again once by itself
  if (network && hidden && !document.hidden && navigator.onLine) setTimeout(retryLast, 0);
}

function retryLast() {
  const li = G.lastInput;
  if (G.game && li?.failed && !G.running) sendInput(li.kind, li.text);
}

async function sendInput(kind, text) {
  text = (text || '').trim();
  if (kind !== 'opening' && (!text || G.running)) return;   // one turn at a time
  sound.play('select');
  G.lastInput = { kind, text };
  if (!navigator.onLine) { failTurn(t('net.held'), true); return; }   // the online listener sends it
  // The focused option is about to be hidden: park the keyboard on the dialog box instead of losing it
  if ($('#choices').contains(document.activeElement)) $('#dialog').focus({ preventScroll: true });
  $('#choices').hidden = true;
  paintFailed(null);
  setBusy(true);
  const gid = G.game.id;
  const parentId = G.currentId;
  if (kind !== 'opening') { logTurn(); pushLine({ kind: 'player', speaker: G.game.protagonist.name, char_id: null, text }); }
  const turnLines = [];
  let rewriting = false;   // after a reset: the lines on screen stay until the rewritten ones arrive
  let shownGone = false;   // a reset dropped a line the player already saw: mark where the rewrite starts
  G.turnStart = Date.now();
  let lastStatus = '';
  G.paintClock = () => {
    const s = Math.round((Date.now() - G.turnStart) / 1000);
    const avg = typicalTurn();
    const writing = s >= 10 && (avg ? t('game.writingAvg', { s, avg }) : t('game.writing', { s }));
    // Much longer than the last few turns took: most likely a crowded server rather than a stuck page (G07)
    const crowded = avg && s > 2 * avg && s > avg + 20 && t('game.crowded');
    const parts = [rewriting && t('game.rewriting'), lastStatus || writing, crowded];
    paintRetry(parts.filter(Boolean).join(t('game.statusSep')));
  };
  const clock = setInterval(() => G.paintClock?.(), 500);
  G.running = job(`/api/games/${gid}/turn`, { parent_id: parentId, input: { kind, text } }, (ev) => {
    if (ev.type === 'line') {
      if (shownGone) {
        shownGone = false;
        pushLine({ kind: 'narration', speaker: '', char_id: null, text: t('game.rewritten') });
      }
      rewriting = false;
      turnLines.push(ev.line);
      pushLine(ev.line);
    } else if (ev.type === 'reset') {
      // keep: lines resumed from an earlier break that the rewrite continues from
      const gone = new Set(turnLines.splice(ev.keep || 0));
      const unseen = new Set(G.queue.filter((l) => !l.of));
      shownGone ||= [...gone].some((l) => !unseen.has(l));
      G.queue = G.queue.filter((l) => !gone.has(l.of || l));
      if (!G.typing && !G.queue.length && G.waitingClick) { $('#dialog-next').hidden = true; $('#dialog-wait').hidden = false; }
      rewriting = true;
    } else if (ev.type === 'status') {
      lastStatus = ev.state === 'waiting' ? '' : statusText(ev);
      $('#retry-now').hidden = ev.state !== 'retry';
      paintWait($('#retry'), ev);
    } else if (ev.type === 'phase') {
      lastStatus = t(`phase.${ev.code}`);
      paintWait($('#retry'), null);
    }
  });
  const run = G.running;   // a turn cancelled by leaving may settle after the next one started: it must not touch that one
  if (!G.typing && !G.queue.length) $('#dialog-wait').hidden = false;
  try {
    const final = await G.running.done;
    const node = final.node;
    G.game.scenes = final.scenes;
    if (!G.tree.nodes[node.id]) {
      G.tree.nodes[node.id] = node;
      if (node.parent) G.tree.nodes[node.parent].children.push(node.id);
      else G.tree.root = node.id;
    }
    if (final.replayed && !G.game.batch) toast(t('game.replayed'));   // batch stories replay on every option
    G.currentId = node.id;
    sound.setMood(node.bgm_mood);
    sound.setWeather(node.weather);
    G.stage.setWeather(node.weather);
    G.final = node;
    G.lastInput = null;
    // A turn the page spent partly in the background (a phone may freeze it) would skew the typical time
    if (!final.replayed && G.hiddenAt < G.turnStart && !document.hidden) recordTurnTime(Date.now() - G.turnStart);
    if (kind === 'free') saveDraft(gid, parentId, '');
    pollAssets();
    if (!G.typing && !G.queue.length) finishTurn();
    else if (!G.typing && !G.waitingClick) advance();
  } catch (e) {
    if (G.game?.id !== gid || G.running !== run) return;   // left the game, which cancelled the turn
    // Storage full: the turn was written but not saved; its lines stay readable and the failure row comes after them (F03)
    if (e.code === 'storage_full' && turnLines.length) {
      G.failAfter = () => failTurn(e.message, false, e.code);
      if (!G.typing && !G.queue.length) { G.waitingClick = false; afterLine(); }
      return;
    }
    G.queue = [];
    G.typing = null;
    G.waitingClick = false;   // else the retried turn's first line would wait for a click
    const cur = G.tree.nodes[G.currentId];
    if (cur) showStatic(cur);
    else { $('#dialog-text').textContent = ''; $('#nameplate').hidden = true; }
    if (e.code === 'cancelled' && cur) { toast(t('game.cancelled')); failTurn(null); }
    else failTurn(e.code === 'cancelled' ? t('game.cancelled') : e.message, isNetwork(e), e.code);
  } finally {
    clearInterval(clock);
    if (G.running === run) {
      G.paintClock = null;
      paintRetry('');
      G.running = null;
    }
  }
}

// Show a node's last line and its choices without replaying (after errors)
function showStatic(node) {
  const last = node.lines[node.lines.length - 1];
  if (last) { showLine({ ...last, text: pages(last.text).at(-1), of: last }); G.typing.t0 = -1e9; }
}

// Replaying a turn already read: straight to its choices, the skipped lines still go to the log (G04)
function skipToChoices() {
  $('#dialog-skip').hidden = true;
  if (!G.final || G.running) return;
  G.queue.forEach((l) => { if (!l.of) logLine(l); });
  G.queue = [];
  G.waitingClick = false;
  showStatic(G.final);
}

// A jump starts on an empty dialog box, so the old line never shows over the new scene (G12)
function clearDialog() {
  $('#dialog-text').textContent = '';
  $('#nameplate').hidden = true;
  $('#dialog').classList.remove('narration', 'player');
  $('#dialog-next').hidden = true;
  $('#dialog-wait').hidden = true;
  $('#dialog-skip').hidden = true;
  G.stage.setSpeaker(null);
}

// ---------- entering a node ----------

function castFor(node) {
  const seen = [];
  for (const l of node.lines) if (l.char_id) { G.castExpr[l.char_id] = l.expr; if (!seen.includes(l.char_id)) seen.push(l.char_id); }
  return seen.slice(-3);
}

// replay: false shows the turn's end and skips its lines (the untaken-option start)
export async function enterGame(stage, gid, nodeId, onExit, replay = true) {
  G.stage = stage;
  G.onExit = onExit;
  clearDelays();
  $('#choices').hidden = true;   // hide the previous node's options at once, so they cannot be clicked while loading
  $('#ending').hidden = true;
  paintFailed(null);
  const box = progress(t('game.loading'), '');
  try {
    const data = await get(`/api/games/${gid}`);
    Object.assign(G, { game: data.game, tree: data.tree, assets: data.assets });
  } catch (e) {
    box.close();
    toastError(e);
    return false;
  }
  box.close();
  // Free input length follows the story's language, not the UI language
  const max = 120 * (LIMIT_SCALE[G.game.lang] || 1);
  G.maxInput = max;
  $('#free-input').placeholder = t('game.freePh', { n: max });
  Object.assign(G, { queue: [], typing: null, waitingClick: false, final: null, failAfter: null, castExpr: {}, lastInput: null });
  seedLog(G.tree, G.game.protagonist.name, nodeId);
  clearDialog();
  $('#scr-game').hidden = false;
  clearInterval(G.pollTimer);
  G.pollTimer = setInterval(() => { if (!document.hidden) pollAssets(); }, 3000);   // a hidden tab is polled on return
  clearInterval(G.loadTimer);
  loadingTicks = 0;
  G.loadTimer = setInterval(paintLoading, 250);
  if (!nodeId || !G.tree.nodes[nodeId]) {
    G.currentId = null;
    G.sceneId = G.game.first_scene;
    get(`/api/games/${gid}?scene=${G.game.first_scene}`).catch(() => {});
    stage.setScene(sceneUrl(G.sceneId), { transition: true });
    stage.setCast([]);
    stage.setPending(!sceneUrl(G.sceneId));
    sound.setMood('mysterious');
    paintAssetChip();
    sendInput('opening', '');
    return true;
  }
  const node = G.tree.nodes[nodeId];
  G.currentId = nodeId;
  // A turn that changed scenes replays its lines where it started; finishTurn then changes the scene as in play (G12)
  const sid = replay ? G.tree.nodes[node.parent]?.scene_id || node.scene_id : node.scene_id;
  G.sceneId = sid;
  if (!sceneUrl(node.scene_id)) get(`/api/games/${gid}?scene=${node.scene_id}`).catch(() => {});
  const cast = castFor(node);
  stage.setScene(sceneUrl(sid), { transition: true, onSwap: () => {
    sceneCard(sid);
    stage.setCast(cast.map((cid) => ({ cid, url: spriteUrl(cid, G.castExpr[cid]) })));
  } });
  stage.setPending(!sceneUrl(sid));
  stage.setWeather(node.weather);
  sound.setMood(node.bgm_mood);
  sound.setWeather(node.weather);
  paintAssetChip();
  if (!replay) return true;
  // Re-read the node's lines, then its choices
  G.final = node;
  node.lines.forEach((l) => G.queue.push(l));
  $('#dialog-skip').hidden = !node.lines.length;
  G.startTimer = setTimeout(() => { G.startTimer = null; advance(); }, 1100);
  return true;
}

export function leaveGame() {
  if (G.running) G.running.cancel();
  clearInterval(G.pollTimer);
  clearInterval(G.loadTimer);
  clearDelays();
  G.game = null;
  G.queue = [];
  G.typing = null;
  G.final = null;
  G.failAfter = null;
  G.skip = false;
  $('#scr-game').hidden = true;
  $('#asset-chip').hidden = true;
  $('#stage-loading').hidden = true;
  $('#ending').hidden = true;
  $('#scene-card').hidden = true;
  $('#press-menu').hidden = true;
  $('#game-live').textContent = '';
  G.stage?.setWeather('none');   // the title screen shares the stage: no rain left falling behind it
  sound.setWeather('none');
}

export function currentGameId() { return G.game?.id; }

// ---------- save / load / tree ----------

function depthOf(id) { let d = 0; for (let n = G.tree.nodes[id]; n; n = G.tree.nodes[n.parent]) d++; return d; }

function slotHtml(s, i, mode) {
  if (!s) return `<button class="slot empty" data-i="${i}"><span class="num">${i + 1}</span><div class="thumb">${esc(t('slots.empty'))}</div>` +
    `<div class="meta"><b>&nbsp;</b>&nbsp;</div></button>`;
  return `<button class="slot" data-i="${i}"><span class="num">${i + 1}</span>` +
    `<div class="thumb"${thumbAttr(s.thumb)}></div>` +
    `<div class="meta"><b>${esc(s.label)}</b>${esc(String(s.saved_at || '').slice(0, 16).replace('T', ' '))}</div>` +
    (mode === 'load' ? `<span class="del btn tiny ghost" data-del="${i}">${esc(t('slots.del'))}</span>` : '') + '</button>';
}

export async function openSlots(mode, onLoad) {
  $('#slots-title').textContent = t(mode === 'save' ? 'slots.save' : 'slots.load');
  let slots;
  try { slots = await get('/api/slots'); } catch (e) { toastError(e); return; }
  const paint = () => {
    $('#slot-grid').innerHTML = slots.map((s, i) => slotHtml(s, i, mode)).join('');
    loadThumbs($('#slot-grid'));
    $('#slot-grid').querySelectorAll('.slot').forEach((b) => { b.onclick = (e) => pick(e, Number(b.dataset.i)); });
  };
  const pick = async (e, i) => {
    if (e.target.dataset.del) {
      e.stopPropagation();
      if (await confirmBox(t('slots.delAsk', { n: i + 1 }), t('common.delete'))) {
        try { slots = await del(`/api/slots/${i}`); paint(); } catch (err) { toastError(err); }
      }
      return;
    }
    if (mode === 'save') {
      if (slots[i] && !(await confirmBox(t('slots.overwrite', { n: i + 1, label: slots[i].label }), t('slots.overwriteOk')))) return;
      const label = t('slots.label', { title: G.game.title, scene: G.game.scenes[G.sceneId]?.name || '', turn: depthOf(G.currentId) });
      try {
        slots = await post(`/api/slots/${i}`, { game_id: G.game.id, node_id: G.currentId, label });
        paint();
        toast(t('slots.saved', { n: i + 1 }));
      } catch (err) { toastError(err); }
    } else if (slots[i]) {
      closeModal('#mdl-slots');
      onLoad(slots[i].game_id, slots[i].node_id);
    }
  };
  $('#autosave-row').innerHTML = '';
  if (mode === 'load') {
    // The last few autosave points, newest first: one wrong choice can be taken back a few turns
    const autos = await get('/api/autosaves').catch(() => []);
    if (autos.length) {
      const games = await get('/api/games').catch(() => []);
      const title = (a) => games.find((g) => g.id === a.game_id)?.title || a.game_id;
      $('#autosave-row').innerHTML = `<p class="hint">${esc(t('slots.autoHint', { n: autos.length }))}</p>` + autos.map((a, i) =>
        `<button class="slot" data-auto="${i}"><div class="thumb"${thumbAttr(a.thumb)}></div><div class="meta"><b>${esc(title(a))}</b>` +
        `${esc(String(a.saved_at || '').slice(0, 16).replace('T', ' '))}</div></button>`).join('');
      loadThumbs($('#autosave-row'));
      $('#autosave-row').querySelectorAll('.slot').forEach((b) => {
        const a = autos[Number(b.dataset.auto)];
        b.onclick = () => { closeModal('#mdl-slots'); onLoad(a.game_id, a.node_id); };
      });
    }
  }
  paint();
  openModal('#mdl-slots');
}

export async function openTree() {
  openModal('#mdl-tree');   // visible first: the tree measures its labels and scrolls to the current turn
  const draw = (failed) => renderTree(G.tree, G.game, G.currentId, async (id, turn) => {
    const sc = G.game.scenes[G.tree.nodes[id].scene_id]?.name || '';
    if (!(await confirmBox(t('tree.jump', { n: turn, scene: sc }), t('tree.jumpOk')))) return;
    closeModal('#mdl-tree');
    enterGame(G.stage, G.game.id, id, G.onExit);
  }, failed, rewriteBranch, G.game.batch ? [] : untakenOptions(G.tree), startUntaken);
  draw([]);
  if (!G.game.batch) return;
  // Branches the batch gave up on show as red stubs (D09)
  const gid = G.game.id;
  const b = (await get('/api/batches').catch(() => [])).find((x) => x.id === gid);
  if (b?.failed_list?.length && G.game?.id === gid && !$('#mdl-tree').hidden) draw(b.failed_list);
}

// An option nobody picked yet, clicked on the tree (G11): back to that turn and the option goes out at once, without replaying the turn first
async function startUntaken(u) {
  if (!(await confirmBox(t('tree.untakenAsk', { option: u.option }), t('tree.untakenOk')))) return;
  closeModal('#mdl-tree');
  const gid = G.game.id;
  if (!(await enterGame(G.stage, gid, u.parent, G.onExit, false))) return;
  G.tree.nodes[u.parent].lines.forEach(logLine);
  setTimeout(() => { if (G.game?.id === gid && G.currentId === u.parent && !G.running) sendInput('option', u.option); }, 1100);
}

// The tree's retry button on a branch the batch could not write: writes it now, then redraws the tree
const rewriting = new Set();
async function rewriteBranch(f) {
  const gid = G.game.id;
  const key = `${f.parent}\n${f.option}`;
  if (rewriting.has(key) || !(await confirmBox(t('tree.rewriteAsk', { option: f.option }), t('tree.rewriteOk')))) return;
  rewriting.add(key);
  toast(t('tree.rewriting', { option: f.option }), false, 600000, { id: 'rewrite' });
  try {
    await post(`/api/games/${gid}/batch/branch`, { parent: f.parent, option: f.option });
    const data = await get(`/api/games/${gid}`);
    if (G.game?.id === gid) G.tree = data.tree;
  } catch (e) {
    toast(e.message, true, 0, { id: 'rewrite', code: e.code });
    return;
  } finally {
    rewriting.delete(key);
  }
  toast(t('tree.rewritten', { option: f.option }), false, 4000, { id: 'rewrite' });
  if (G.game?.id === gid && !$('#mdl-tree').hidden) openTree();
}

// ---------- wiring ----------

const LONG_PRESS_MS = 600;
const SWIPE_PX = 50;
const NOT_STAGE = 'button, input, select, form, #choices, #retry, #dialog, #ending, #toolbar';
const NO_MENU = 'button, input, select, form, #choices, #retry, #ending, #toolbar, #press-menu';

export function initGame() {
  requestAnimationFrame(typeStep);
  const scr = $('#scr-game');
  let press = null;         // touch or pen held on the stage: { x, y, timer, fired }
  let pointer = 'mouse';
  let swipe = null;         // where a touch started, for a swipe up to the log (I02)
  scr.addEventListener('pointerdown', (e) => {
    pointer = e.pointerType;
    press = null;
    swipe = e.pointerType === 'mouse' || e.target.closest('input, select') ? null : { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'mouse' || e.target.closest(NO_MENU)) return;
    // Touch has no right click: a long press opens a small menu; redrawing is in it when the press is on the picture
    const p = { x: e.clientX, y: e.clientY, fired: false, picture: !e.target.closest(NOT_STAGE) };
    p.timer = setTimeout(() => {
      p.fired = true;
      openPressMenu(p.x, p.y, p.picture && G.game && G.stage.hit(p.x, p.y) ? () => askRedraw(p.x, p.y) : null);
    }, LONG_PRESS_MS);
    press = p;
  });
  scr.addEventListener('pointerup', (e) => {
    const dy = swipe ? e.clientY - swipe.y : 0;
    if (dy < -SWIPE_PX && Math.abs(dy) > Math.abs(e.clientX - swipe.x) && !document.querySelector('.modal:not([hidden])')) openLog();
    swipe = null;
  });
  // Scrolling up on the story opens the log (G02); a list that can still scroll up keeps the wheel
  const scrolled = (el) => {
    for (; el && el !== scr; el = el.parentElement) if (el.scrollTop > 0) return true;
    return false;
  };
  scr.addEventListener('wheel', (e) => {
    if (e.deltaY < 0 && !scrolled(e.target) && !document.querySelector('.modal:not([hidden])')) openLog();
  }, { passive: true });
  scr.addEventListener('pointermove', (e) => {
    if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) clearTimeout(press.timer);
  });
  for (const ev of ['pointerup', 'pointercancel']) scr.addEventListener(ev, () => { if (press) clearTimeout(press.timer); });
  scr.addEventListener('contextmenu', (e) => {
    if (e.target.closest(NOT_STAGE)) return;
    e.preventDefault();
    if (pointer === 'mouse') askRedraw(e.clientX, e.clientY);   // touch: the long-press timer asks instead
  });
  scr.addEventListener('click', (e) => {
    if (press?.fired) { press = null; return; }   // the end of a long press is not a click
    if (!e.target.closest('button, input, form, #choices, #retry')) advance();
  });
  $('#asset-chip').addEventListener('click', showAssetProblems);
  // Coming back to this window moves its images first right away instead of at the next poll
  window.addEventListener('focus', pollAssets);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { G.hiddenAt = Date.now(); return; }
    pollAssets();
    G.paintClock?.();   // timers were throttled in the background: show the current state at once
    const li = G.lastInput;
    if (li?.failed && li.network && li.hidden && navigator.onLine) retryLast();   // failed while in the background
  });
  window.addEventListener('online', () => {
    const li = G.lastInput;
    if (G.game && li?.failed && li.network && !G.running) { toast(t('net.back')); retryLast(); }
  });
  $('#failed-retry').onclick = retryLast;
  $('#failed-exit').onclick = () => G.onExit?.();
  document.addEventListener('keydown', (e) => {
    // Keys belong to an open dialog, a form field, or a button the keyboard moved to (I04)
    if ($('#scr-game').hidden || document.querySelector('.modal:not([hidden])')) return;
    if (e.target.closest?.('input, textarea, select')) return;
    if (e.key === 'Control') { G.skip = true; return; }   // held: fast-forward (G04); not while copying in a dialog or a field
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      // 1 to 4 pick that option (G01); L opens the log (G02); M turns the sound off and on
      if (/^[1-4]$/.test(e.key) && !$('#choices').hidden) { $(`#options .btn[data-i="${e.key - 1}"]`)?.click(); return; }
      if (e.key === 'l' || e.key === 'L') { openLog(); return; }
      if (e.key === 'm' || e.key === 'M') { toast(t(sound.toggleMute() ? 'game.muted' : 'game.unmuted'), false, 4000, { id: 'mute' }); return; }
    }
    if (e.target.closest?.('button:focus-visible, a:focus-visible, summary:focus-visible')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'Control') G.skip = false; });
  window.addEventListener('blur', () => { G.skip = false; });
  $('#dialog-skip').onclick = skipToChoices;
  $('#free-input').addEventListener('input', () => {
    paintCount(G.maxInput);
    if (G.game && G.currentId) saveDraft(G.game.id, G.currentId, $('#free-input').value);
  });
  // Esc leaves the field so 1 to 4, L and Space work again
  $('#free-input').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
  $('#free-form').addEventListener('submit', (e) => { e.preventDefault(); sendInput('free', $('#free-input').value); });
  $('#retry-cancel').onclick = () => G.running && G.running.cancel();
  $('#retry-now').onclick = () => { $('#retry-now').hidden = true; if (G.running) G.running.retryNow(); };
}
