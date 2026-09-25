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
const FIELDS = [
  ['name', 'input', 12],
  ['appearance', 'textarea', 300],
  ['personality', 'input', 200],
  ['speech', 'input', 200],
  ['relationship', 'input', 200],
];

let allPresets = null;
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

export async function initSetup() {
  allPresets = await get('presets.json');
  $('#world-preset').onchange = () => {
    const v = $('#world-preset').value;
    fillWorld(v === 'custom' ? {} : presets().worlds[Number(v)]);
  };
  $('#char-add').onclick = () => { $('#char-list').append(charCard()); renumber(); };
  document.querySelectorAll('#mode-bar input, #mode-bar select').forEach((el) => { el.onchange = paintEstimate; });
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
  return { lang, world, protagonist: { name: $('#p-name').value.trim(), profile: $('#p-profile').value.trim() }, characters,
    ...(batchMode() ? { batch: batchPlan() } : {}) };
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
    else if (ev.type === 'status' && ev.state !== 'waiting') box.update(null, statusText(ev));
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
