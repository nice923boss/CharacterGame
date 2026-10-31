// New-game screen: world presets, protagonist, 1 to 4 characters, then the server setup job.
// The story is written in the current UI language; presets.json holds one preset set per language.
import { get, job } from './api.js';
import { errorText, lang, scaleMaxLength, t } from './i18n.js';
import { $, esc, helpNode, progress } from './ui.js';

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

const NARRATOR = { zh: '旁白', en: 'Narrator' };   // server/turn_parser.py NARRATOR: no one may take this name
// server/novel_service.py NOVEL_PART_CHARS x NOVEL_MAX_PARTS: the longest novel text the analysis accepts
const NOVEL_MAX_TEXT = 240000;
const NOVEL_MAX_BYTES = NOVEL_MAX_TEXT * 4;   // UTF-8 needs at most 4 bytes a character: bigger files cannot fit

let allPresets = null;
let novelTitle = '';   // title of the imported novel; its chapters are the cards in #chapter-list
let snapshot = '';     // the form right after resetSetup: anything else is the player's own work
const presets = () => allPresets[lang];

// Loads presets.json once; a load that failed at startup is tried again by the next "new story"
export async function loadPresets() {
  allPresets ||= await get('presets.json');
}

// A removed card hands focus to its neighbour, else to the button that adds one (M23)
function removeCard(card, fallback, after) {
  const list = [...card.parentElement.querySelectorAll('.char-card')];
  const i = list.indexOf(card);
  const next = list[i - 1] || list[i + 1];
  card.remove();
  after();
  const target = next ? next.querySelector('header button') : fallback();
  if (target && !target.disabled) target.focus();
}

function charCard(c = {}) {
  const card = document.createElement('div');
  card.className = 'char-card';
  card.innerHTML = `<header><span class="idx"></span><button class="btn tiny ghost" type="button">${esc(t('setup.remove'))}</button></header>` +
    FIELDS.map(([k, tag, max]) => tag === 'textarea'
      ? `<label>${esc(t(`char.${k}`))}<textarea data-k="${k}" maxlength="${max}" rows="2">${esc(c[k])}</textarea></label>`
      : `<label>${esc(t(`char.${k}`))}<input data-k="${k}" maxlength="${max}" value="${esc(c[k])}"></label>`).join('');
  card.querySelector('button').onclick = () => removeCard(card, () => $('#char-add'), renumber);
  scaleMaxLength(card, lang);
  return card;
}

function renumber() {
  const cards = [...document.querySelectorAll('#char-list .char-card')];
  cards.forEach((c, i) => {
    c.querySelector('.idx').textContent = t('setup.charN', { n: i + 1 });
    c.querySelector('header button').setAttribute('aria-label', t('setup.removeN', { n: i + 1 }));
  });
  paintEstimate();
  $('#char-count').textContent = `${cards.length} / ${MAX_CHARS}`;
  $('#char-add').disabled = cards.length >= MAX_CHARS;
}

// Same count as tree_size in server/turn_service.py: the opening is turn 1
const treeSize = (n, turns) => Array.from({ length: turns }, (_, k) => n ** k).reduce((a, b) => a + b, 0);
const batchMode = () => document.querySelector('input[name="gen-mode"]:checked').value === 'batch';
const batchPlan = () => ({ options: Number($('#b-options').value), turns: Number($('#b-turns').value) });

// Also decides whether the start button is on (a batch tree over the size limit cannot start)
export function paintEstimate() {
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
  card.querySelector('button').onclick = () => removeCard(card, () => $('#novel-import'), renumberChapters);
  scaleMaxLength(card, lang);
  return card;
}

function renumberChapters() {
  const cards = [...document.querySelectorAll('#chapter-list .char-card')];
  cards.forEach((c, i) => {
    c.querySelector('.idx').textContent = t('setup.novel.chN', { n: i + 1 });
    c.querySelector('header button').setAttribute('aria-label', t('setup.novel.removeN', { n: i + 1 }));
  });
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
  // A file this big is refused after the analysis reads it anyway: say so before loading it into memory
  if (file.size > NOVEL_MAX_BYTES) {
    setMsg(t('setup.novel.tooBig', { mb: (file.size / 1e6).toFixed(1), limit: NOVEL_MAX_TEXT }), true);
    return;
  }
  const text = decodeText(await file.arrayBuffer());
  if (text === null) { setMsg(t('setup.novel.decodeFail'), true); return; }
  const title = file.name.replace(/\.[^.]*$/, '').replace(/[《》]/g, '').trim();
  let running = null;
  const box = progress(t('setup.novel.reading'), t('setup.novel.readingSub'), () => running && running.cancel());
  running = job('/api/novel/analyze', { lang, title, text }, (ev) => {
    if (ev.type === 'progress') box.update(t('setup.novel.progress', ev));
    else if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.status(ev, () => running.retryNow());
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
    if (e.code === 'cancelled') setMsg(e.message); else setError(e);   // the player's own cancel is not an error
  } finally {
    box.close();
  }
}

// The controls are wired first, so the screen works once a failed preset load succeeds on a later try
export async function initSetup() {
  $('#world-preset').onchange = () => {
    const v = $('#world-preset').value;
    fillWorld(v === 'custom' ? {} : presets().worlds[Number(v)]);
  };
  $('#char-add').onclick = () => {
    const card = charCard();
    $('#char-list').append(card);
    renumber();
    card.querySelector('[data-k="name"]').focus();
  };
  document.querySelectorAll('#mode-bar input, #mode-bar select').forEach((el) => { el.onchange = paintEstimate; });
  $('#novel-import').onclick = () => $('#novel-file').click();
  $('#novel-file').onchange = () => {
    const file = $('#novel-file').files[0];
    $('#novel-file').value = '';
    if (file) importNovel(file);
  };
  $('#novel-clear').onclick = () => { $('#chapter-list').innerHTML = ''; renumberChapters(); $('#novel-import').focus(); };
  await loadPresets();
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
  snapshot = formState();
}

const formState = () => JSON.stringify([payload(), $('#world-preset').value]);
// The player changed something since the screen opened: leaving would lose it
export const setupDirty = () => !!snapshot && formState() !== snapshot;

function setMsg(text, error = false) {
  $('#setup-msg').textContent = text;
  $('#setup-msg').classList.toggle('error', error);
}

// An error with its "what to do" line and settings button (C10)
function setError(e) {
  setMsg(e.message, true);
  const help = helpNode(e.code);
  if (help) $('#setup-msg').append(help);
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

// The first thing create_game in server/turn_service.py would refuse, in its order, so the cursor can go to that
// field instead of the player hunting for it: [message, field] or null
function formProblem(body) {
  if (!body.world.era) return [t('setup.needWorld'), $('#w-era')];
  if (!body.world.place) return [t('setup.needWorld'), $('#w-place')];
  if (!body.protagonist.name) return [errorText('required', { field: 'hero_name' }), $('#p-name')];
  const cards = [...document.querySelectorAll('#char-list .char-card')];
  if (!cards.length) return [t('setup.needChar'), $('#char-add')];
  for (const [i, c] of body.characters.entries()) {
    const k = FIELDS.map(([f]) => f).find((f) => !c[f]);
    if (k) return [errorText('required', { field: `char_${k}`, i: i + 1 }), cards[i].querySelector(`[data-k="${k}"]`)];
  }
  const names = [...body.characters.map((c) => c.name), body.protagonist.name];
  const clash = names.findIndex((n, i) => names.indexOf(n) !== i || Object.values(NARRATOR).includes(n));
  if (clash >= 0) {
    return [errorText('dup_names', { narrator: NARRATOR[lang] }),
      clash < cards.length ? cards[clash].querySelector('[data-k="name"]') : $('#p-name')];
  }
  if (body.batch && !body.world.goal) return [errorText('batch_goal'), $('#w-goal')];
  const chapters = [...document.querySelectorAll('#chapter-list .char-card')];
  for (const [i, c] of (body.novel?.chapters || []).entries()) {
    const k = !c.title ? 'title' : !c.summary ? 'summary' : '';
    if (k) return [errorText('required', { field: `chapter_${k}`, i: i + 1 }), chapters[i].querySelector(`[data-k="${k}"]`)];
  }
  return null;
}

export async function startGame() {
  const body = payload();
  const problem = formProblem(body);
  if (problem) {
    const [msg, field] = problem;
    setMsg(msg, true);
    field.focus();
    field.scrollIntoView?.({ block: 'nearest' });
    return null;
  }
  const t0 = Date.now();
  let running = null;
  const box = progress(t('setup.building'), t('setup.buildingSub'), () => running && running.cancel());
  running = job('/api/games', body, (ev) => {
    if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.status(ev, () => running.retryNow());
  });
  try {
    const final = await running.done;
    setMsg(t('setup.done', { s: Math.round((Date.now() - t0) / 1000) }));
    return final.game;
  } catch (e) {
    if (e.code === 'cancelled') setMsg(e.message); else setError(e);
    return null;
  } finally {
    box.close();
  }
}
