// New-game screen: world presets, protagonist, 1 to 4 characters, then the server setup job.
// The story is written in the current UI language; presets.json holds one preset set per language.
import { get, job } from './api.js';
import { errorText, lang, scaleMaxLength, t } from './i18n.js';
import { $, esc, progress, statusText } from './ui.js';

const MAX_CHARS = 4;
// Batch mode limits and timing, from server/config.py and the spike in docs/dev-log.md
const BATCH_MAX_NODES = 400;
const BATCH_MAX_SCENES = 8;
const SEC_PER_TURN = 15, BATCH_CONCURRENCY = 6, SEC_PER_SCENE = 66, SEC_PER_SPRITE = 48, EXPRESSIONS = 5;
const MIN_TURNS = 3, MAX_TURNS = 10;
const FIELDS = [
  ['name', 'input', 12],
  ['appearance', 'textarea', 300],
  ['personality', 'input', 200],
  ['speech', 'input', 200],
  ['relationship', 'input', 200],
];

let allPresets = null;
let novelTitle = '';   // title of the imported novel; its chapters are the cards in #chapter-list
const presets = () => allPresets[lang];

function charCard(c = {}) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.innerHTML = `<header><span class="idx"></span><button class="btn tiny ghost" type="button">${esc(t('setup.remove'))}</button></header>` +
    FIELDS.map(([k, tag, max]) => tag === 'textarea'
      ? `<label>${esc(t(`char.${k}`))}<textarea data-k="${k}" maxlength="${max}" rows="2">${esc(c[k])}</textarea></label>`
      : `<label>${esc(t(`char.${k}`))}<input data-k="${k}" maxlength="${max}" value="${esc(c[k])}"></label>`).join('');
  card.querySelector('button').onclick = () => { card.remove(); renumber(); };
  scaleMaxLength(card, lang);
  return card;
}

function renumber() {
  const cards = [...document.querySelectorAll('#char-list .char-card')];
  cards.forEach((c, i) => { c.querySelector('.idx').textContent = t('setup.charN', { n: i + 1 }); });
  paintEstimate();
  $('#char-count').textContent = `${cards.length} / ${MAX_CHARS}`;
  $('#char-add').disabled = cards.length >= MAX_CHARS;
}

// Same count as tree_size in server/turn_service.py: the opening is turn 1
const treeSize = (n, turns) => Array.from({ length: turns }, (_, k) => n ** k).reduce((a, b) => a + b, 0);
const batchMode = () => document.querySelector('input[name="gen-mode"]:checked').value === 'batch';
const batchPlan = () => ({ options: Number($('#b-options').value), turns: Number($('#b-turns').value) });

function paintEstimate() {
  $('#mode-bar').classList.toggle('batch', batchMode());
  const { options, turns } = batchPlan();
  const nodes = treeSize(options, turns);
  const over = nodes > BATCH_MAX_NODES;
  const scenes = Math.min(BATCH_MAX_SCENES, 1 + Math.round(nodes * 0.17));
  const chars = document.querySelectorAll('#char-list .char-card').length;
  const text = Math.ceil((nodes * SEC_PER_TURN) / BATCH_CONCURRENCY / 60);
  const img = Math.ceil((scenes * SEC_PER_SCENE + chars * EXPRESSIONS * SEC_PER_SPRITE) / 60);
  $('#batch-est').textContent = over ? t('setup.b.over', { nodes, max: BATCH_MAX_NODES }) : t('setup.b.est', { nodes, text, img });
  $('#batch-est').classList.toggle('error', over);
  $('#setup-start').disabled = batchMode() && over;
}

function fillWorld(w) {
  for (const k of ['era', 'place', 'genre', 'tone', 'extra', 'goal']) $(`#w-${k}`).value = w[k] || '';
}

// ---------- imported novel ----------

function chapterCard(c) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.innerHTML = `<header><span class="idx"></span><button class="btn tiny ghost" type="button">${esc(t('setup.remove'))}</button></header>` +
    `<label>${esc(t('setup.novel.chTitle'))}<input data-k="title" maxlength="20" value="${esc(c.title)}"></label>` +
    `<label>${esc(t('setup.novel.chSummary'))}<textarea data-k="summary" maxlength="200" rows="3">${esc(c.summary)}</textarea></label>`;
  card.querySelector('button').onclick = () => { card.remove(); renumberChapters(); };
  scaleMaxLength(card, lang);
  return card;
}

function renumberChapters() {
  const cards = [...document.querySelectorAll('#chapter-list .char-card')];
  cards.forEach((c, i) => { c.querySelector('.idx').textContent = t('setup.novel.chN', { n: i + 1 }); });
  $('#novel-box').hidden = !cards.length;
  if (!cards.length) novelTitle = '';
}

function showNovel(novel) {
  novelTitle = novel.title;
  $('#novel-name').textContent = novel.title ? t('setup.novel.name', { title: novel.title }) : '';
  $('#chapter-list').innerHTML = '';
  novel.chapters.forEach((c) => $('#chapter-list').append(chapterCard(c)));
  renumberChapters();
}

// Batch turns for a novel: one chapter per turn where the tree size allows it
function fitTurns(chapters) {
  const options = batchPlan().options;
  let turns = Math.max(MIN_TURNS, Math.min(MAX_TURNS, chapters));
  while (turns > MIN_TURNS && treeSize(options, turns) > BATCH_MAX_NODES) turns -= 1;
  $('#b-turns').value = String(turns);
  paintEstimate();
}

// UTF-8 first (the usual case), then UTF-16 by its BOM, then the common Chinese legacy encodings
function decodeText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  for (const enc of ['utf-8', 'big5', 'gbk']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch { /* not this encoding */ }
  }
  return null;
}

// The AI reads the novel in parts and fills the form with its world, cast and chapter outline; the player can edit all of it
async function importNovel(file) {
  const text = decodeText(await file.arrayBuffer());
  if (text === null) { setMsg(t('setup.novel.decodeFail'), true); return; }
  const title = file.name.replace(/\.[^.]*$/, '').replace(/[《》]/g, '').trim();
  let running = null;
  const box = progress(t('setup.novel.reading'), t('setup.novel.readingSub'), () => running && running.cancel());
  running = job('/api/novel/analyze', { lang, title, text }, (ev) => {
    if (ev.type === 'progress') box.update(t('setup.novel.progress', ev));
    else if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.retry(ev, () => running.retryNow());
    if (ev.type === 'status' && ev.state !== 'waiting') box.update(null, statusText(ev));
  });
  try {
    const { draft } = await running.done;
    $('#world-preset').value = 'custom';
    fillWorld(draft.world);
    $('#p-name').value = draft.protagonist.name;
    $('#p-profile').value = draft.protagonist.profile;
    $('#char-list').innerHTML = '';
    draft.characters.forEach((c) => $('#char-list').append(charCard(c)));
    renumber();
    showNovel(draft.novel);
    fitTurns(draft.novel.chapters.length);
    setMsg(t('setup.novel.done', { n: draft.novel.chapters.length }));
  } catch (e) {
    setMsg(e.message, true);
  } finally {
    box.close();
  }
}

export async function initSetup() {
  allPresets = await get('presets.json');
  $('#world-preset').onchange = () => {
    const v = $('#world-preset').value;
    fillWorld(v === 'custom' ? {} : presets().worlds[Number(v)]);
  };
  $('#char-add').onclick = () => { $('#char-list').append(charCard()); renumber(); };
  document.querySelectorAll('#mode-bar input, #mode-bar select').forEach((el) => { el.onchange = paintEstimate; });
  $('#novel-import').onclick = () => $('#novel-file').click();
  $('#novel-file').onchange = () => {
    const file = $('#novel-file').files[0];
    $('#novel-file').value = '';
    if (file) importNovel(file);
  };
  $('#novel-clear').onclick = () => { $('#chapter-list').innerHTML = ''; renumberChapters(); };
}

// Called every time the setup screen opens, so a language switch on the title screen is picked up
export function resetSetup() {
  const p = presets();
  $('#world-preset').innerHTML = p.worlds.map((w, i) => `<option value="${i}">${esc(w.label)}</option>`).join('') +
    `<option value="custom">${esc(t('setup.custom'))}</option>`;
  $('#world-preset').value = '0';
  fillWorld(p.worlds[0]);
  $('#p-name').value = p.protagonist.name;
  $('#p-profile').value = p.protagonist.profile;
  $('#char-list').innerHTML = '';
  p.characters.forEach((c) => $('#char-list').append(charCard(c)));
  $('#chapter-list').innerHTML = '';
  renumberChapters();
  scaleMaxLength($('#scr-setup'), lang);
  renumber();
  setMsg(t('setup.hint'));
}

function setMsg(text, error = false) {
  $('#setup-msg').textContent = text;
  $('#setup-msg').classList.toggle('error', error);
}

function payload() {
  const world = {};
  for (const k of ['era', 'place', 'genre', 'tone', 'extra', 'goal']) world[k] = $(`#w-${k}`).value.trim();
  const characters = [...document.querySelectorAll('#char-list .char-card')].map((card) => {
    const c = {};
    card.querySelectorAll('[data-k]').forEach((el) => { c[el.dataset.k] = el.value.trim(); });
    return c;
  });
  const chapters = [...document.querySelectorAll('#chapter-list .char-card')].map((card) => ({
    title: card.querySelector('[data-k="title"]').value.trim(), summary: card.querySelector('[data-k="summary"]').value.trim(),
  }));
  return { lang, world, protagonist: { name: $('#p-name').value.trim(), profile: $('#p-profile').value.trim() }, characters,
    ...(batchMode() ? { batch: batchPlan() } : {}), ...(chapters.length ? { novel: { title: novelTitle, chapters } } : {}) };
}

// Runs the setup job; resolves with the created game, or null when cancelled or failed (message shown)
export const isBatchMode = batchMode;

export async function startGame() {
  const body = payload();
  if (!body.world.era || !body.world.place) { setMsg(t('setup.needWorld'), true); return null; }
  if (!body.characters.length) { setMsg(t('setup.needChar'), true); return null; }
  if (body.batch && !body.world.goal) { setMsg(errorText('batch_goal'), true); return null; }
  const t0 = Date.now();
  let running = null;
  const box = progress(t('setup.building'), t('setup.buildingSub'), () => running && running.cancel());
  running = job('/api/games', body, (ev) => {
    if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.retry(ev, () => running.retryNow());
    if (ev.type === 'status' && ev.state !== 'waiting') box.update(null, statusText(ev));
  });
  try {
    const final = await running.done;
    setMsg(t('setup.done', { s: Math.round((Date.now() - t0) / 1000) }));
    return final.game;
  } catch (e) {
    setMsg(e.message, true);
    return null;
  } finally {
    box.close();
  }
}
