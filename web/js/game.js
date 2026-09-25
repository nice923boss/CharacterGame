// Game screen controller: plays a node's lines with a typewriter, runs turns over SSE, handles scene
// changes, asset polling, save/load, the node tree and jumping back to an older node.
import { del, get, job, post } from './api.js';
import { sound } from './sound.js';
import { LIMIT_SCALE, t } from './i18n.js';
import { $, closeModal, confirmBox, esc, openModal, progress, settings, statusText, toast } from './ui.js';
import { renderTree } from './tree.js';

const G = {
  stage: null, game: null, tree: null, assets: null, currentId: null,
  queue: [], typing: null, waitingClick: false, final: null, running: null, turnStart: 0,
  sceneId: null, pendingScene: null, castExpr: {}, onExit: null, pollTimer: null, lastInput: null,
};

// ---------- asset urls ----------

function spriteUrl(cid, expr) {
  const s = G.assets?.sprites?.[cid];
  if (!s) return null;
  const pick = s[expr]?.state === 'done' ? expr : s.calm?.state === 'done' ? 'calm' : null;
  return pick ? `/media/${G.game.id}/assets/sprites/${cid}/${pick}.png?v=${s[pick].v}` : null;
}

function sceneUrl(sid) {
  const s = G.assets?.scenes?.[sid];
  return s?.state === 'done' ? `/media/${G.game.id}/assets/scenes/${sid}.png?v=${s.v}` : null;
}

async function pollAssets() {
  if (!G.game) return;
  const gid = G.game.id;
  let assets;
  // Polling also re-queues missing images (after a server restart) and puts this game's images first
  const scene = G.sceneId ? `?scene=${encodeURIComponent(G.sceneId)}` : '';
  try { assets = await get(`/api/games/${gid}/assets${scene}`); } catch { return; }
  if (G.game?.id !== gid) return;   // left or switched game while waiting
  G.assets = assets;
  const url = sceneUrl(G.sceneId);
  G.stage.setPending(!url);
  if (url) G.stage.setScene(url);
  for (const cid of G.stage.castIds()) G.stage.show(cid, spriteUrl(cid, G.castExpr[cid] || 'calm'));
  paintAssetChip();
}

function paintAssetChip() {
  const chip = $('#asset-chip');
  const sc = G.assets?.scenes?.[G.sceneId];
  if (sc && sc.state !== 'done') {
    chip.textContent = sc.state === 'error' ? t('chip.sceneError') : sc.state === 'running'
      ? t('chip.sceneRunning') : t('chip.sceneQueued', { n: sc.ahead ?? 0 });
    chip.hidden = false;
    return;
  }
  const all = Object.values(G.assets?.sprites || {}).flatMap((m) => Object.values(m));
  const ready = all.filter((x) => x.state === 'done').length;
  chip.hidden = !all.length || ready === all.length;
  chip.textContent = t('chip.sprites', { ready, all: all.length });
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
    const n = cut >= 0 ? from + cut + 1 : lo;
    out.push(rest.slice(0, n));
    rest = rest.slice(n).trimStart();
  }
  el.textContent = shown;
  return [...out, rest];
}

function showLine(line) {
  // A line too long for the box shows its first page; the rest waits at the front of the queue
  const [first, ...more] = pages(line.text);
  if (more.length) G.queue.unshift(...more.map((text) => ({ ...line, text, of: line.of || line })));
  line = { ...line, text: first };
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

function typeStep() {
  if (G.stage) G.stage.refreshScene();
  const T = G.typing;
  if (T) {
    const n = Math.min(T.text.length, Math.floor((performance.now() - T.t0) / 1000 * settings.speed));
    if (n !== T.n) { T.n = n; $('#dialog-text').textContent = T.text.slice(0, n); }
    if (n >= T.text.length) { G.typing = null; afterLine(); }
  }
  requestAnimationFrame(typeStep);
}

function afterLine() {
  if (G.queue.length) { G.waitingClick = true; $('#dialog-next').hidden = false; return; }
  if (G.final) { finishTurn(); return; }
  // More lines are still streaming: keep this one on screen until the player clicks
  if (G.running) { G.waitingClick = true; $('#dialog-wait').hidden = false; }
}

function advance() {
  if (!$('#choices').hidden) return;
  if (G.typing) { G.typing.t0 = -1e9; return; }
  if (G.queue.length) { G.waitingClick = false; sound.play('click'); showLine(G.queue.shift()); }
}

function pushLine(line) {
  G.queue.push(line);
  if (!G.typing && !G.waitingClick) advance();
  else if (!G.typing) { $('#dialog-next').hidden = false; $('#dialog-wait').hidden = true; }
}

// All lines of the turn are read and the node is known: scene change, then choices
function finishTurn() {
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
    setTimeout(() => showChoices(node), 1400);
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
  setTimeout(() => { card.hidden = true; }, 3300);
}

function showChoices(node) {
  if (node.result.ending) { showEnding(node.result.ending); return; }
  const taken = new Set(node.children.map((c) => G.tree.nodes[c]?.player_input?.text).filter(Boolean));
  $('#options').innerHTML = node.result.options.map((o, i) =>
    `<button class="btn" data-i="${i}">${esc(o)}${taken.has(o) && !G.game.batch ? `<small>${esc(t('game.taken'))}</small>` : ''}</button>`).join('');
  $('#options').querySelectorAll('.btn').forEach((b) => {
    b.onclick = () => sendInput('option', node.result.options[Number(b.dataset.i)]);
  });
  $('#free-input').value = G.lastInput?.kind === 'free' && G.lastInput.failed ? G.lastInput.text : '';
  $('#choices').hidden = false;
  $('#dialog-wait').hidden = true;
  setBusy(false);
}

// The branch ended: an ending card instead of choices
function showEnding(ending) {
  $('#ending-kind').textContent = t(ending.type === 'good' ? 'ending.good' : 'ending.bad');
  $('#ending').classList.toggle('bad', ending.type !== 'good');
  $('#ending-title').textContent = ending.title;
  $('#ending').hidden = false;
  $('#dialog-wait').hidden = true;
  setBusy(false);
}

// ---------- turns ----------

function setBusy(busy) {
  document.querySelectorAll('#toolbar [data-act="save"], #toolbar [data-act="tree"], #toolbar [data-act="load"]')
    .forEach((b) => { b.disabled = busy; });
}

function paintRetry(text) {
  $('#retry-text').textContent = text;
  $('#retry').hidden = !text;
}

async function sendInput(kind, text) {
  text = (text || '').trim();
  if (kind !== 'opening' && !text) return;
  sound.play('select');
  $('#choices').hidden = true;
  setBusy(true);
  G.lastInput = { kind, text };
  const parentId = G.currentId;
  if (kind !== 'opening') pushLine({ kind: 'player', speaker: G.game.protagonist.name, char_id: null, text });
  const turnLines = [];
  G.turnStart = Date.now();
  let lastStatus = '';
  const clock = setInterval(() => {
    const s = Math.round((Date.now() - G.turnStart) / 1000);
    if (lastStatus) paintRetry(lastStatus);
    else if (s >= 10) paintRetry(t('game.writing', { s }));
  }, 500);
  G.running = job(`/api/games/${G.game.id}/turn`, { parent_id: parentId, input: { kind, text } }, (ev) => {
    if (ev.type === 'line') { turnLines.push(ev.line); pushLine(ev.line); } else if (ev.type === 'reset') {
      G.queue = G.queue.filter((l) => !turnLines.includes(l.of || l));
      toast(t('game.reset'));
    } else if (ev.type === 'status') {
      lastStatus = ev.state === 'waiting' ? '' : statusText(ev);
    } else if (ev.type === 'phase') {
      lastStatus = t(`phase.${ev.code}`);
    }
  });
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
    pollAssets();
    if (!G.typing && !G.queue.length) finishTurn();
    else if (!G.typing && !G.waitingClick) advance();
  } catch (e) {
    G.queue = [];
    G.typing = null;
    G.lastInput = { kind, text, failed: true };
    toast(e.code === 'cancelled' ? t('game.cancelled') : e.message, e.code !== 'cancelled');
    const cur = G.tree.nodes[G.currentId];
    if (cur) { showStatic(cur); showChoices(cur); } else if (G.onExit) G.onExit();
  } finally {
    clearInterval(clock);
    paintRetry('');
    G.running = null;
  }
}

// Show a node's last line and its choices without replaying (after errors)
function showStatic(node) {
  const last = node.lines[node.lines.length - 1];
  if (last) { showLine({ ...last, text: pages(last.text).at(-1) }); G.typing.t0 = -1e9; }
}

// ---------- entering a node ----------

function castFor(node) {
  const seen = [];
  for (const l of node.lines) if (l.char_id) { G.castExpr[l.char_id] = l.expr; if (!seen.includes(l.char_id)) seen.push(l.char_id); }
  return seen.slice(-3);
}

export async function enterGame(stage, gid, nodeId, onExit) {
  G.stage = stage;
  G.onExit = onExit;
  $('#choices').hidden = true;   // hide the previous node's options at once, so they cannot be clicked while loading
  $('#ending').hidden = true;
  const box = progress(t('game.loading'), '');
  try {
    const data = await get(`/api/games/${gid}`);
    Object.assign(G, { game: data.game, tree: data.tree, assets: data.assets });
  } catch (e) {
    box.close();
    toast(e.message, true);
    return false;
  }
  box.close();
  // Free input length follows the story's language, not the UI language
  const max = 120 * (LIMIT_SCALE[G.game.lang] || 1);
  $('#free-input').maxLength = max;
  $('#free-input').placeholder = t('game.freePh', { n: max });
  Object.assign(G, { queue: [], typing: null, waitingClick: false, final: null, castExpr: {}, lastInput: null });
  $('#scr-game').hidden = false;
  clearInterval(G.pollTimer);
  G.pollTimer = setInterval(pollAssets, 3000);
  if (!nodeId || !G.tree.nodes[nodeId]) {
    G.currentId = null;
    G.sceneId = G.game.first_scene;
    get(`/api/games/${gid}?scene=${G.game.first_scene}`).catch(() => {});
    stage.setScene(sceneUrl(G.sceneId), { transition: true });
    stage.setCast([]);
    stage.setPending(!sceneUrl(G.sceneId));
    sound.setMood('mysterious');
    $('#dialog-text').textContent = '';
    $('#nameplate').hidden = true;
    paintAssetChip();
    sendInput('opening', '');
    return true;
  }
  const node = G.tree.nodes[nodeId];
  G.currentId = nodeId;
  G.sceneId = node.scene_id;
  if (!sceneUrl(node.scene_id)) get(`/api/games/${gid}?scene=${node.scene_id}`).catch(() => {});
  const cast = castFor(node);
  stage.setScene(sceneUrl(node.scene_id), { transition: true, onSwap: () => {
    sceneCard(node.scene_id);
    stage.setCast(cast.map((cid) => ({ cid, url: spriteUrl(cid, G.castExpr[cid]) })));
  } });
  stage.setPending(!sceneUrl(node.scene_id));
  stage.setWeather(node.weather);
  sound.setMood(node.bgm_mood);
  sound.setWeather(node.weather);
  paintAssetChip();
  // Re-read the node's lines, then its choices
  $('#dialog-text').textContent = '';
  G.final = node;
  node.lines.forEach((l) => G.queue.push(l));
  setTimeout(advance, 1100);
  return true;
}

export function leaveGame() {
  if (G.running) G.running.cancel();
  clearInterval(G.pollTimer);
  G.game = null;
  G.queue = [];
  G.typing = null;
  G.final = null;
  $('#scr-game').hidden = true;
  $('#asset-chip').hidden = true;
  $('#ending').hidden = true;
  sound.setWeather('none');
}

export function currentGameId() { return G.game?.id; }

// ---------- save / load / tree ----------

function depthOf(id) { let d = 0; for (let n = G.tree.nodes[id]; n; n = G.tree.nodes[n.parent]) d++; return d; }

function slotHtml(s, i, mode) {
  if (!s) return `<button class="slot empty" data-i="${i}"><span class="num">${i + 1}</span><div class="thumb">${esc(t('slots.empty'))}</div>` +
    `<div class="meta"><b>&nbsp;</b>&nbsp;</div></button>`;
  const thumb = s.thumb ? ` style="background-image:url('${s.thumb}')"` : '';
  return `<button class="slot" data-i="${i}"><span class="num">${i + 1}</span>` +
    `<div class="thumb"${thumb}></div>` +
    `<div class="meta"><b>${esc(s.label)}</b>${esc(String(s.saved_at || '').slice(0, 16).replace('T', ' '))}</div>` +
    (mode === 'load' ? `<span class="del btn tiny ghost" data-del="${i}">${esc(t('slots.del'))}</span>` : '') + '</button>';
}

export async function openSlots(mode, onLoad) {
  $('#slots-title').textContent = t(mode === 'save' ? 'slots.save' : 'slots.load');
  let slots;
  try { slots = await get('/api/slots'); } catch (e) { toast(e.message, true); return; }
  const paint = () => {
    $('#slot-grid').innerHTML = slots.map((s, i) => slotHtml(s, i, mode)).join('');
    $('#slot-grid').querySelectorAll('.slot').forEach((b) => { b.onclick = (e) => pick(e, Number(b.dataset.i)); });
  };
  const pick = async (e, i) => {
    if (e.target.dataset.del) {
      e.stopPropagation();
      if (await confirmBox(t('slots.delAsk', { n: i + 1 }), t('common.delete'))) { slots = await del(`/api/slots/${i}`); paint(); }
      return;
    }
    if (mode === 'save') {
      if (slots[i] && !(await confirmBox(t('slots.overwrite', { n: i + 1, label: slots[i].label }), t('slots.overwriteOk')))) return;
      const label = t('slots.label', { title: G.game.title, scene: G.game.scenes[G.sceneId]?.name || '', turn: depthOf(G.currentId) });
      try {
        slots = await post(`/api/slots/${i}`, { game_id: G.game.id, node_id: G.currentId, label });
        paint();
        toast(t('slots.saved', { n: i + 1 }));
      } catch (err) { toast(err.message, true); }
    } else if (slots[i]) {
      closeModal('#mdl-slots');
      onLoad(slots[i].game_id, slots[i].node_id);
    }
  };
  $('#autosave-row').innerHTML = '';
  if (mode === 'load') {
    const auto = await get('/api/autosave').catch(() => null);
    if (auto) {
      const games = await get('/api/games').catch(() => []);
      const title = games.find((g) => g.id === auto.game_id)?.title || auto.game_id;
      const thumb = auto.thumb ? ` style="background-image:url('${auto.thumb}')"` : '';
      $('#autosave-row').innerHTML = `<button class="slot"><div class="thumb"${thumb}></div><div class="meta"><b>${esc(t('slots.auto', { title }))}</b>` +
        `${esc(String(auto.saved_at || '').slice(0, 16).replace('T', ' ') + t('slots.autoNote'))}</div></button>`;
      $('#autosave-row .slot').onclick = () => { closeModal('#mdl-slots'); onLoad(auto.game_id, auto.node_id); };
    }
  }
  paint();
  openModal('#mdl-slots');
}

export function openTree() {
  openModal('#mdl-tree');   // visible first: the tree measures its labels and scrolls to the current turn
  renderTree(G.tree, G.game, G.currentId, async (id, turn) => {
    const sc = G.game.scenes[G.tree.nodes[id].scene_id]?.name || '';
    if (!(await confirmBox(t('tree.jump', { n: turn, scene: sc }), t('tree.jumpOk')))) return;
    closeModal('#mdl-tree');
    enterGame(G.stage, G.game.id, id, G.onExit);
  });
}

// ---------- wiring ----------

export function initGame() {
  requestAnimationFrame(typeStep);
  $('#scr-game').addEventListener('click', (e) => {
    if (!e.target.closest('button, input, form, #choices, #retry')) advance();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#scr-game').hidden || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advance(); }
  });
  $('#free-form').addEventListener('submit', (e) => { e.preventDefault(); sendInput('free', $('#free-input').value); });
  $('#retry-cancel').onclick = () => G.running && G.running.cancel();
}
