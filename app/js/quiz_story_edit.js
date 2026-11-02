// The story editor: a story quest's info, its pages (added, copied, moved and deleted one by one), its items and
// scenes with their pictures, saving and trying it from any page. The HTML is in quiz_story_forms.js, the rules in
// quest_story.js. Edits stay as typed; the quest is cleaned up (normalizeStory) when it is read and saved.
import { post } from './api.js?v=69d1ef9c6b81';
import { t } from './i18n.js?v=69d1ef9c6b81';
import { $, confirmBox, toastError } from './ui.js?v=69d1ef9c6b81';
import { newId } from './quest.js?v=69d1ef9c6b81';
import { STORY_MAX, item, normalizeStory, page, questPictures, storyProblems } from './quest_story.js?v=69d1ef9c6b81';
import { playQuest } from './quiz_play.js?v=69d1ef9c6b81';
import { drawPics, uploadPic } from './quiz_pics.js?v=69d1ef9c6b81';
import { infoHtml, itemsHtml, jumpsOf, pagesHtml, rowHtml, scenesHtml, summary } from './quiz_story_forms.js?v=69d1ef9c6b81';

let nav = null;      // { show(screenId), title(), quests() }
let S = null;        // story quest open in the editor
let tab = 'pages';   // info, pages, items or scenes
let cur = 0;         // index of the page open in the pages tab
let dirty = false;
let pics = {};       // slot -> picture address
let picSlot = '';    // the slot the picture file chooser is open for
let addType = 'talk';

export const newStory = () => ({ mode: 'story', title: '', pages: [
  { type: 'chapter', heading: 'Chapter 1', title: '' }, { type: 'narration', text: '' }, { type: 'ending', title: 'The End' }] });

// keep: back from trying it, so the same tab and page open again
export function openStoryEditor(quest, keep = false) {
  S = normalizeStory(quest);
  pics = quest.pictures || {};
  dirty = false;
  if (!keep) { tab = 'pages'; cur = 0; }
  cur = Math.min(cur, Math.max(0, S.pages.length - 1));
  nav.show('scr-quiz-story');
  render();
  if (!keep) $('#qs-body').scrollTop = 0;
  setMsg('');
}

// Draws the open tab again where it was scrolled to
function render() {
  const keep = ['#qs-body', '#qs-list', '#qs-form'].map((sel) => [sel, $(sel)?.scrollTop || 0]);
  for (const b of document.querySelectorAll('#qs-tabs [data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
  $('#qs-body').innerHTML = tab === 'info' ? infoHtml(S) : tab === 'items' ? itemsHtml(S, pics)
    : tab === 'scenes' ? scenesHtml(S, pics) : pagesHtml(S, cur, addType);
  for (const [sel, top] of keep) if ($(sel)) $(sel).scrollTop = top;
}

function showPage(i) {
  cur = i;
  render();
  $('#qs-form').scrollTop = 0;
  $(`#qs-list [data-page="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
}

function setMsg(text, error = false) {
  $('#qs-msg').textContent = text;
  $('#qs-msg').classList.toggle('error', error);
}

const at = (path) => path.split('.').reduce((o, k) => o[k], S);

// A list filled past its end (the third hint before the second) gets '' in the gaps, not holes
function setAt(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const host = keys.reduce((o, k) => o[k], S);
  host[last] = value;
  if (Array.isArray(host)) for (let i = 0; i < host.length; i += 1) if (host[i] === undefined) host[i] = '';
}

function valueOf(el) {
  const as = el.dataset.as;
  if (as === 'num') return Number(el.value);
  if (as === 'bool') return el.checked;
  if (as === 'lines') return el.value.split('\n');
  if (as === 'need') {
    const rest = at(el.dataset.k).filter((x) => x !== el.value);
    return el.checked ? [...rest, el.value] : rest;
  }
  return el.value;
}

// Another page type keeps what both types have; choice options and puzzle options become each other
function retype(p, type) {
  const labels = (p.options || []).map((o) => (typeof o === 'string' ? o : o.label));
  if (type === 'choice') return page({ ...p, type, options: (labels.length ? labels : ['', '']).map((label) => ({ label })) });
  if (type === 'puzzle') return page({ ...p, type, options: labels });
  return page({ ...p, type });
}

function onField(e) {
  const el = e.target;
  if (el.id === 'qs-add-type') { addType = el.value; return; }
  if (el.id === 'qs-type') {
    if (e.type !== 'change') return;
    S.pages[cur] = retype(S.pages[cur], el.value);
    dirty = true;
    render();
    return;
  }
  if (!el.dataset?.k || (el.type === 'radio' && !el.checked)) return;
  setAt(el.dataset.k, valueOf(el));
  dirty = true;
  if (e.type !== 'change') return;
  if ('redraw' in el.dataset) render();
  // Only the open page's row: a click on another row while this field loses focus must still land
  else if (tab === 'pages' && S.pages[cur]) {
    const row = $(`#qs-list [data-page="${cur}"]`);
    if (row) row.outerHTML = rowHtml(S, cur, cur);
  }
}

// Pages whose jump (or one of whose options) goes to the page with this id
const pointingAt = (id) => S.pages.flatMap((x, i) => (x.id !== id && jumpsOf(x).includes(id) ? [i] : []));

async function deletePage() {
  const p = S.pages[cur];
  const refs = pointingAt(p.id);
  const ask = refs.length ? t('qs.delRefAsk', { n: cur + 1, list: refs.map((i) => i + 1).join(t('common.sep')) })
    : summary(p, S) !== t('qs.empty') ? t('qs.delAsk', { n: cur + 1 }) : '';
  if (ask && !(await confirmBox(ask, t('common.delete')))) return false;
  for (const i of refs) {
    const x = S.pages[i];
    if (x.type === 'choice') for (const o of x.options) { if (o.goto === p.id) o.goto = ''; } else x.goto = '';
  }
  S.pages.splice(cur, 1);
  cur = Math.max(0, Math.min(cur, S.pages.length - 1));
  return true;
}

// A puzzle shows at least two option boxes; adding or deleting one first fills the list up to what is shown
function puzzleOptions(p) {
  p.options = Array.from({ length: Math.max(2, p.options.length) }, (_, j) => p.options[j] ?? '');
  return p.options;
}

function addOption(p) {
  if (p.type === 'puzzle') { if (puzzleOptions(p).length < STORY_MAX.options) p.options.push(''); return; }
  p.options.push({ id: newId(p.options, 'o'), label: '', goto: '', once: false, needs: [] });
}

function deleteOption(p, j) {
  if (p.type === 'puzzle') {
    if (puzzleOptions(p).length <= 2) return;
    p.options.splice(j, 1);
    if (p.answer === j) p.answer = 0; else if (p.answer > j) p.answer -= 1;
    return;
  }
  const [gone] = p.options.splice(j, 1);
  for (const o of p.options) o.needs = o.needs.filter((n) => n !== gone.id);
}

async function deleteItem(i) {
  const it = S.items[i];
  const used = S.pages.flatMap((p, n) => (p.type === 'item' && p.item === it.id ? [n + 1] : []));
  const name = it.name || t('qs.empty');
  const ask = used.length ? t('qs.itDelAsk', { name, list: used.join(t('common.sep')) }) : t('qs.itDelAsk0', { name });
  if (!(await confirmBox(ask, t('common.delete')))) return false;
  for (const p of S.pages) if (p.type === 'item' && p.item === it.id) p.item = '';
  S.items.splice(i, 1);
  return true;
}

async function deleteScene(i) {
  const s = S.scenes[i];
  const used = S.pages.flatMap((p, n) => (p.scene === s.id ? [n + 1] : []));
  const name = s.name || t('qs.empty');
  const ask = used.length ? t('qs.scDelAsk', { name, list: used.join(t('common.sep')) }) : t('qs.scDelAsk0', { name });
  if (!(await confirmBox(ask, t('common.delete')))) return false;
  for (const p of S.pages) if (p.scene === s.id) p.scene = '';
  S.scenes.splice(i, 1);
  return true;
}

function movePage(by) {
  const [p] = S.pages.splice(cur, 1);
  cur += by;
  S.pages.splice(cur, 0, p);
}

function insertPage(p) {
  const i = S.pages.length ? cur + 1 : 0;
  S.pages.splice(i, 0, p);
  cur = i;
}

// What the picture tools in quiz_pics.js need from this editor
const picTools = () => ({ save, setMsg, show: (p) => { pics = p; render(); } });
const missingPics = () => questPictures(S).filter((s) => !pics[s]);

// Each button: what it changes; false when nothing changed (a question was answered no), so nothing is redrawn
async function act(name, d) {
  const p = S.pages[cur];
  const i = Number(d.i);
  const j = Number(d.j);
  if (name === 'pic') { drawPics([d.slot], missingPics(), picTools()); return false; }
  if (name === 'upload') { picSlot = d.slot; $('#qs-pic-file').click(); return false; }
  if (name === 'picsAll') { drawPics([], missingPics(), picTools()); return false; }
  if (name === 'tryFrom') { tryPlay(cur); return false; }
  if (name === 'pgAdd') insertPage(retype({ id: newId(S.pages, 'p') }, addType));
  if (name === 'pgCopy') insertPage({ ...structuredClone(p), id: newId(S.pages, 'p') });
  if (name === 'pgUp') movePage(-1);
  if (name === 'pgDown') movePage(1);
  if (name === 'pgDel') return deletePage();
  if (name === 'optAdd') addOption(p);
  if (name === 'optDel') deleteOption(p, j);
  if (name === 'addChar') S.characters.push({ name: '', who: '' });
  if (name === 'delChar') S.characters.splice(i, 1);
  if (name === 'itAdd') {
    const it = item({ id: newId(S.items), kind: d.kind });
    S.items.push(d.kind === 'person' ? { ...it, keywords: [{ words: '', reply: '' }] } : it);
  }
  if (name === 'itDel') return deleteItem(i);
  if (name === 'kwAdd') S.items[i].keywords.push({ words: '', reply: '' });
  if (name === 'kwDel') S.items[i].keywords.splice(j, 1);
  if (name === 'scAdd') S.scenes.push({ id: newId(S.scenes), name: '', scene: '' });
  if (name === 'scDel') return deleteScene(i);
  return true;
}

async function onClick(e) {
  const row = e.target.closest('[data-page]');
  if (row) { showPage(Number(row.dataset.page)); return; }
  const b = e.target.closest('[data-do]');
  if (!b || b.disabled) return;
  const added = b.dataset.do === 'itAdd' || b.dataset.do === 'scAdd';
  if (!(await act(b.dataset.do, b.dataset))) return;
  dirty = true;
  render();
  if (tab === 'pages') $(`#qs-list [data-page="${cur}"]`)?.scrollIntoView({ block: 'nearest' });
  if (added) $('#qs-body').scrollTop = $('#qs-body').scrollHeight;
}

async function save() {
  try {
    const saved = await post(`/api/quiz/${S.id || 'new'}`, S);
    S.id = saved.id;
    dirty = false;
    return saved;
  } catch (e) { toastError(e); return null; }
}

async function tryPlay(from = 0) {
  const missing = storyProblems(normalizeStory(S));
  if (missing.length) {
    setMsg(t('quiz.cannotPlay', { list: missing.slice(0, 3).map((x) => t(`qs.p.${x.code}`, { n: x.n })).join(t('common.sep')) }), true);
    return;
  }
  const saved = await save();
  if (saved) playQuest({ ...saved, pictures: pics }, nav, { back: () => openStoryEditor({ ...saved, pictures: pics }, true), from });
}

async function leave() {
  if (dirty && !(await confirmBox(t('quiz.leaveAsk'), t('quiz.leaveOk')))) return;
  nav.quests();
}

// navigation: main.js's { show, title } plus quests() to go back to the list
export function initStoryEditor(navigation) {
  nav = navigation;
  const body = $('#qs-body');
  body.addEventListener('input', onField);
  body.addEventListener('change', onField);
  body.addEventListener('click', onClick);
  $('#qs-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b || b.dataset.tab === tab) return;
    tab = b.dataset.tab;
    render();
    body.scrollTop = 0;
  });
  $('#qs-pic-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadPic(picSlot, f, picTools()); };
  $('#qs-save').onclick = async () => { if (await save()) setMsg(t('quiz.saved')); };
  $('#qs-try').onclick = () => tryPlay(0);
  $('#qs-back').onclick = leave;
}
