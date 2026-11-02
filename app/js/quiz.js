// SDGs English quest: the list of quests (form and story), the form editor (basic info, AI draft, 1 to 20 levels,
// ending) and file export. The story editor is quiz_story_edit.js, playing is quiz_play.js; the storage and the AI
// draft are in local/quiz.js (browser build only).
import { del, get, job, post } from './api.js?v=6f163306a287';
import { t } from './i18n.js?v=6f163306a287';
import { $, confirmBox, esc, progress, toast, toastError } from './ui.js?v=6f163306a287';
import { DRAFT_LEVELS, LIMITS, MAX_CHARS, MAX_LEVELS, SDGS, SDG_LOOK, newId, newLevel, normalize, picturesOf, problems } from './quest.js?v=6f163306a287';
import { playQuest } from './quiz_play.js?v=6f163306a287';
import { drawPics, uploadPic } from './quiz_pics.js?v=6f163306a287';
import { initStoryEditor, newStory, openStoryEditor } from './quiz_story_edit.js?v=6f163306a287';

export const sdgName = (q) => (q.sdg === 'other' ? q.sdg_other || t('quiz.sdg.other') : t(`quiz.sdg.${q.sdg}`));

let nav = null;     // { show(screenId), title() } from main.js
let Q = null;       // quest open in the editor
let dirty = false;
let pics = {};      // slot -> picture address for the quest in the editor
let picSlot = '';   // the slot the picture file chooser is open for
let draftCount = 0; // levels the AI draft writes; 0 until the author picks a number

// ---------- quest list ----------

export async function openQuests() {
  nav.show('scr-quiz');
  const host = $('#qz-list');
  let rows = [];
  try { rows = await get('/api/quiz'); } catch (e) { toastError(e); }
  host.innerHTML = rows.length ? rows.map((r) => `
    <div class="qz-row" data-id="${esc(r.id)}" style="--sdg:${SDG_LOOK[r.sdg]?.color || SDG_LOOK.other.color}">
      <span class="qz-badge">${SDG_LOOK[r.sdg]?.icon || ''}</span>
      <span class="meta"><b>${esc(r.title || t('quiz.untitled'))}</b>
        <small>${esc(`${t(`quiz.mode.${r.mode}`)} · ${r.ready ? t('quiz.ready') : t('quiz.unready')}`)}</small></span>
      <button class="btn small primary" data-row="play"${r.ready ? '' : ' disabled'}>${esc(t('quiz.playBtn'))}</button>
      <button class="btn small" data-row="edit">${esc(t('quiz.edit'))}</button>
      ${r.mode === 'simple' ? `<button class="btn small" data-row="story" title="${esc(t('quiz.toStoryHint'))}">${esc(t('quiz.toStory'))}</button>` : ''}
      <button class="btn small" data-row="export">${esc(t('quiz.export'))}</button>
      <button class="btn small ghost" data-row="delete">${esc(t('common.delete'))}</button>
    </div>`).join('') : `<p class="hint qz-empty">${esc(t('quiz.empty'))}</p>`;
}

async function rowAction(act, id) {
  try {
    if (act === 'edit') {
      const q = await get(`/api/quiz/${id}`);
      if (q.mode === 'story') openStoryEditor(q); else openEditor(q);
      return;
    }
    if (act === 'story') {
      const copy = await post(`/api/quiz/${id}/story`, {});
      toast(t('quiz.toStoryDone', { title: copy.title || t('quiz.untitled') }));
      openStoryEditor(copy);
      return;
    }
    if (act === 'play') { playQuest(await get(`/api/quiz/${id}`), nav, { back: openQuests }); return; }
    if (act === 'export') { download(await get(`/api/quiz/${id}/file`)); return; }
    if (act === 'delete') {
      const q = await get(`/api/quiz/${id}`);
      if (!(await confirmBox(t('quiz.deleteAsk', { title: q.title || t('quiz.untitled') }), t('common.delete')))) return;
      await del(`/api/quiz/${id}`);
      openQuests();
    }
  } catch (e) { toastError(e); }
}

// q: the quest file with its pictures inside (exportFile in local/quiz.js)
function download(q) {
  const blob = new Blob([JSON.stringify(q, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(q.title || 'quest').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)}.sdgquest.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importFile(file) {
  try {
    const q = await post('/api/quiz/import', JSON.parse(await file.text()));
    const title = q.title || t('quiz.untitled');
    toast(q.imported_pictures ? t('quiz.importedPics', { title, n: q.imported_pictures }) : t('quiz.imported', { title }));
    openQuests();
  } catch (e) {
    console.warn('quest import failed', e);
    toast(e.code ? e.message : t('quiz.importBad'), true);
  }
}

// ---------- editor ----------

function openEditor(quest) {
  Q = normalize(quest);
  pics = quest.pictures || {};
  if (!Q.characters.length) Q.characters = [{ name: '', who: '' }, { name: '', who: '' }];
  dirty = false;
  draftCount = 0;
  nav.show('scr-quiz-edit');
  render();
  $('#qz-edit-body').scrollTop = 0;
  setMsg('');
}

const field = (k, label, value, { area = false, max, ph = '', rows = 2, lang = '' } = {}) => `
  <label><span>${esc(label)}</span>${area
    ? `<textarea data-k="${k}" rows="${rows}" maxlength="${max}" placeholder="${esc(ph)}"${lang ? ` lang="${lang}"` : ''}>${esc(value)}</textarea>`
    : `<input data-k="${k}" maxlength="${max}" value="${esc(value)}" placeholder="${esc(ph)}"${lang ? ` lang="${lang}"` : ''}>`}</label>`;

function linesHtml(path, rows) {
  return `<div class="qz-lines">${rows.map((l, i) => `
    <div class="qz-line">
      <input data-k="${path}.${i}.speaker" list="qz-names" maxlength="${LIMITS.name}" value="${esc(l.speaker)}" placeholder="${esc(t('quiz.speaker'))}" lang="en">
      <input data-k="${path}.${i}.text" maxlength="${LIMITS.line}" value="${esc(l.text)}" placeholder="${esc(t('quiz.lineText'))}" lang="en">
      <button class="btn tiny ghost" data-do="delLine" data-path="${path}" data-i="${i}" aria-label="${esc(t('quiz.delLine'))}">✕</button>
    </div>`).join('')}
    <button class="btn tiny" data-do="addLine" data-path="${path}">${esc(t('quiz.addLine'))}</button></div>`;
}

const picName = (slot) => (slot === 'intro' ? t('quiz.pic.intro') : slot === 'ending' ? t('quiz.pic.ending')
  : t('quiz.levelN', { n: Q.levels.findIndex((l) => `l${l.id}` === slot) + 1 }));

// The picture of one part with its description and a draw / redraw button
function pictureHtml(slot, sceneKey, scene) {
  return `<div class="qz-pic">
    ${pics[slot] ? `<img src="${esc(pics[slot])}" alt="${esc(picName(slot))}">` : `<span class="qz-nopic">${esc(t('quiz.pic.none'))}</span>`}
    <div>${field(sceneKey, t(sceneKey === 'intro_scene' ? 'quiz.introScene' : sceneKey === 'ending_scene' ? 'quiz.endingScene' : 'quiz.scene'), scene,
      { area: true, max: LIMITS.scene, lang: 'en', ph: t('quiz.ph.scene') })}
      <button class="btn tiny" data-do="pic" data-slot="${slot}">${esc(t(pics[slot] ? 'quiz.pic.redraw' : 'quiz.pic.draw'))}</button>
      <button class="btn tiny" data-do="upload" data-slot="${slot}">${esc(t(pics[slot] ? 'quiz.pic.replace' : 'quiz.pic.upload'))}</button></div>
  </div>`;
}

function levelHtml(l, i) {
  const p = `levels.${i}`;
  const radio = (side) => `<label class="qz-ans"><input type="radio" name="qz-ans-${i}" data-k="${p}.answer" value="${side}"${l.answer === side ? ' checked' : ''}>
    <span>${esc(t('quiz.correctIs', { side }))}</span></label>`;
  const last = Q.levels.length - 1;
  const tool = (act, text, label, off) => `<button class="btn tiny ghost" data-do="${act}" data-i="${i}" aria-label="${esc(label)}" title="${esc(label)}"${off ? ' disabled' : ''}>${esc(text)}</button>`;
  return `<section class="qz-sec qz-level"><div class="qz-head"><h3>${esc(t('quiz.levelN', { n: i + 1 }))}</h3>
    ${tool('lvUp', '↑', t('quiz.lvUp'), i === 0)}${tool('lvDown', '↓', t('quiz.lvDown'), i === last)}${tool('lvDel', `✕ ${t('quiz.lvDel')}`, t('quiz.lvDel'), last === 0)}</div>
    ${field(`${p}.title`, t('quiz.levelTitle'), l.title, { max: LIMITS.levelTitle, lang: 'en', ph: 'Clean the River' })}
    <span class="qz-sub">${esc(t('quiz.dialogue'))}</span>${linesHtml(`${p}.lines`, l.lines)}
    ${field(`${p}.question`, t('quiz.question'), l.question, { max: LIMITS.question, lang: 'en', ph: 'What should they do?' })}
    <div class="row2">${field(`${p}.a`, t('quiz.optA'), l.a, { max: LIMITS.option, lang: 'en' })}${field(`${p}.b`, t('quiz.optB'), l.b, { max: LIMITS.option, lang: 'en' })}</div>
    <div class="qz-answers">${radio('A')}${radio('B')}</div>
    ${field(`${p}.hint`, t('quiz.hint'), l.hint, { max: LIMITS.hint, lang: 'en', ph: t('quiz.ph.hint') })}
    <div class="row2">${field(`${p}.right`, t('quiz.right'), l.right, { max: LIMITS.feedback, lang: 'en', ph: `Correct! ${t('quiz.play.correct')}` })}${field(`${p}.wrong`, t('quiz.wrong'), l.wrong, { max: LIMITS.feedback, lang: 'en', ph: 'Not quite. Try again!' })}</div>
    ${pictureHtml(`l${l.id}`, `${p}.scene`, l.scene)}
  </section>`;
}

const levelCount = () => draftCount || Math.min(DRAFT_LEVELS, Q.levels.length);

function render() {
  const body = $('#qz-edit-body');
  const top = body.scrollTop;
  const sdgOptions = SDGS.map((s) => `<option value="${s}"${Q.sdg === s ? ' selected' : ''}>${esc(`${SDG_LOOK[s].icon} ${t(`quiz.sdg.${s}`)}`)}</option>`).join('');
  body.innerHTML = `
  <section class="qz-sec"><h3>${esc(t('quiz.step1'))}</h3>
    ${field('title', t('quiz.gameTitle'), Q.title, { max: LIMITS.title, ph: 'Save the Blue River' })}
    <div class="row2">
      <label><span>${esc(t('quiz.sdg'))}</span><select data-k="sdg">${sdgOptions}</select></label>
      ${Q.sdg === 'other' ? field('sdg_other', t('quiz.sdgOther'), Q.sdg_other, { max: LIMITS.sdgOther, ph: 'SDG 14 Life Below Water' }) : '<span></span>'}
    </div>
    <span class="qz-sub">${esc(t('quiz.chars'))}</span>
    ${Q.characters.map((c, i) => `<div class="qz-line qz-char">
      <input data-k="characters.${i}.name" maxlength="${LIMITS.name}" value="${esc(c.name)}" placeholder="${esc(t('quiz.charName'))}" lang="en">
      <input data-k="characters.${i}.who" maxlength="${LIMITS.who}" value="${esc(c.who)}" placeholder="${esc(t('quiz.charWho'))}">
      <button class="btn tiny ghost" data-do="delChar" data-i="${i}" aria-label="${esc(t('quiz.delChar'))}">✕</button></div>`).join('')}
    <button class="btn tiny" data-do="addChar"${Q.characters.length >= MAX_CHARS ? ' disabled' : ''}>${esc(t('quiz.addChar'))}</button>
    ${field('place', t('quiz.place'), Q.place, { max: LIMITS.place, ph: t('quiz.ph.place') })}
    ${field('problem', t('quiz.problem'), Q.problem, { area: true, max: LIMITS.problem, ph: t('quiz.ph.problem') })}
    ${field('goal', t('quiz.goal'), Q.goal, { area: true, max: LIMITS.goal, ph: t('quiz.ph.goal') })}
    ${field('idea', t('quiz.idea'), Q.idea, { area: true, max: LIMITS.idea, ph: t('quiz.ph.idea') })}
    <div class="qz-draft"><label class="qz-count"><span>${esc(t('quiz.draftCount'))}</span>
      <input id="qz-count" type="number" min="1" max="${DRAFT_LEVELS}" value="${levelCount()}"></label>
      <button class="btn primary" data-do="draft">${esc(t('quiz.draft'))}</button>
      <p class="hint">${esc(t('quiz.draftHint', { max: DRAFT_LEVELS }))}</p></div>
  </section>
  <section class="qz-sec"><h3>${esc(t('quiz.step2'))}</h3>
    ${field('background', t('quiz.background'), Q.background, { area: true, rows: 4, max: LIMITS.background, lang: 'en', ph: t('quiz.ph.background') })}
    ${pictureHtml('intro', 'intro_scene', Q.intro_scene)}
    <div class="qz-draft"><button class="btn" data-do="picsAll">${esc(t('quiz.pic.all'))}</button>
      <p class="hint">${esc(t('quiz.pic.allHint'))}</p></div>
  </section>
  ${Q.levels.map(levelHtml).join('')}
  <div class="qz-draft"><button class="btn" data-do="lvAdd"${Q.levels.length >= MAX_LEVELS ? ' disabled' : ''}>${esc(t('quiz.lvAdd'))}</button>
    <p class="hint">${esc(t('quiz.lvCount', { n: Q.levels.length, max: MAX_LEVELS }))}</p></div>
  <section class="qz-sec"><h3>${esc(t('quiz.endingTitle'))}</h3>
    <span class="qz-sub">${esc(t('quiz.endingHint'))}</span>${linesHtml('ending', Q.ending)}
    ${pictureHtml('ending', 'ending_scene', Q.ending_scene)}
  </section>
  <datalist id="qz-names">${[...Q.characters.map((c) => c.name).filter(Boolean), 'Narrator'].map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
  body.scrollTop = top;
  paintKey();
}

function paintKey() {
  $('#qz-key').textContent = t('quiz.key', { list: Q.levels.map((l, i) => `${i + 1}${l.answer}`).join(' ') });
}

function setMsg(text, error = false) {
  $('#qz-msg').textContent = text;
  $('#qz-msg').classList.toggle('error', error);
}

const at = (path) => path.split('.').reduce((o, k) => o[k], Q);
function setAt(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], Q)[last] = value;
}

function problemText(p) { return t(`quiz.p.${p.code}`, { n: p.n }); }

async function save() {
  try {
    const saved = await post(`/api/quiz/${Q.id || 'new'}`, Q);
    Q.id = saved.id;
    dirty = false;
    return saved;
  } catch (e) { toastError(e); return null; }
}

async function draft() {
  if (!Q.title || !Q.characters.some((c) => c.name) || !Q.problem || !Q.goal) { setMsg(t('quiz.needDraft'), true); return; }
  const count = levelCount();
  const written = Q.background || Q.levels.some((l) => l.question || l.lines.length);
  if (written && !(await confirmBox(t('quiz.draftAsk', { n: count }), t('quiz.draftOk')))) return;
  let running = null;
  const box = progress(t('quiz.drafting'), t('quiz.draftingSub'), () => running && running.cancel());
  running = job('/api/quiz/generate', { quest: Q, count }, (ev) => {
    if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.status(ev, () => running.retryNow());
  });
  try {
    const { draft: d } = await running.done;
    // A level keeps the id (and so the picture) of the level that was in its place; extra levels get new ids
    const levels = d.levels.reduce((out, l, i) => [...out, { ...l, id: Q.levels[i]?.id || newId([...Q.levels, ...out]) }], []);
    Object.assign(Q, { background: d.background, levels, ending: d.ending, intro_scene: d.intro_scene, ending_scene: d.ending_scene });
    dirty = true;
    render();
    $('#qz-edit-body').querySelector('.qz-sec:nth-child(2)')?.scrollIntoView({ block: 'start' });
    await save();
    setMsg(t('quiz.drafted'));
  } catch (e) {
    if (e.code === 'cancelled') setMsg(e.message); else { setMsg(e.message, true); toastError(e); }
  } finally {
    box.close();
  }
}

// What the picture tools in quiz_pics.js need from this editor
const picTools = () => ({ save, setMsg, show: (p) => { pics = p; render(); } });
const missingPics = () => picturesOf(Q).filter((s) => !pics[s]);

// Deleting a level that has something in it asks first; its picture goes when the quest is saved
async function deleteLevel(i) {
  const l = Q.levels[i];
  const filled = l.title || l.question || l.a || l.b || l.hint || l.scene || l.lines.length || pics[`l${l.id}`];
  if (filled && !(await confirmBox(t('quiz.lvDelAsk', { n: i + 1 }), t('common.delete')))) return;
  Q.levels.splice(i, 1);
  dirty = true;
  render();
}

function moveLevel(i, by) {
  const [l] = Q.levels.splice(i, 1);
  Q.levels.splice(i + by, 0, l);
}

// The text of the whole quest laid out like the worksheet, for copying onto paper or into a document
export function worksheetText(q) {
  const say = (rows) => rows.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join('\n');
  const parts = [`Game Title: ${q.title}`, `SDG: ${sdgName(q)}`,
    `Main Characters: ${q.characters.map((c) => (c.who ? `${c.name} (${c.who})` : c.name)).join(', ')}`,
    `Story Background:\n${q.background}`];
  q.levels.forEach((l, i) => {
    parts.push(`Level ${i + 1}: ${l.title}\n${say(l.lines)}\nQuestion: ${l.question}\nA. ${l.a}\nB. ${l.b}\n` +
      `Correct Answer: ${l.answer}\nHint: ${l.hint}` +
      `${l.right ? `\nIf Correct: ${l.right}` : ''}${l.wrong ? `\nIf Wrong: ${l.wrong}` : ''}`);
  });
  parts.push(`Ending:\n${say(q.ending)}\nMission Complete! 任務完成！`);
  parts.push(`Answer Key: ${q.levels.map((l, i) => `${i + 1}${l.answer}`).join(' ')}`);
  return parts.join('\n\n');
}

async function copySheet() {
  try {
    await navigator.clipboard.writeText(worksheetText(Q));
    toast(t('quiz.copied'));
  } catch (e) {
    console.warn('clipboard failed', e);
    toast(t('quiz.copyFail'), true);
  }
}

async function tryPlay() {
  const missing = problems(Q);
  if (missing.length) {
    setMsg(t('quiz.cannotPlay', { list: missing.slice(0, 3).map(problemText).join(t('common.sep')) }), true);
    return;
  }
  const saved = await save();
  if (saved) playQuest({ ...saved, pictures: pics }, nav, { back: () => openEditor({ ...saved, pictures: pics }) });
}

async function leaveEditor() {
  if (dirty && !(await confirmBox(t('quiz.leaveAsk'), t('quiz.leaveOk')))) return;
  openQuests();
}

export function initQuiz(navigation) {
  nav = navigation;
  initStoryEditor({ ...navigation, quests: openQuests });
  $('#qz-new').onclick = () => openEditor({ levels: [{}, {}, {}, {}, {}] });
  $('#qz-new-story').onclick = () => openStoryEditor(newStory());
  $('#qz-import').onclick = () => $('#qz-file').click();
  $('#qz-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('#qz-pic-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadPic(picSlot, f, picTools()); };
  $('#qz-home-back').onclick = () => nav.title();
  $('#qz-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-row]');
    if (b && !b.disabled) rowAction(b.dataset.row, b.closest('.qz-row').dataset.id);
  });
  const body = $('#qz-edit-body');
  const onField = (e) => {
    if (e.target.id === 'qz-count') {
      draftCount = Math.min(DRAFT_LEVELS, Math.max(1, Math.round(Number(e.target.value)) || 1));
      if (e.type === 'change') e.target.value = draftCount;
      return;
    }
    const el = e.target.closest('[data-k]');
    if (!el || (el.type === 'radio' && !el.checked)) return;
    setAt(el.dataset.k, el.value);
    dirty = true;
    if (el.dataset.k === 'sdg') render();
    if (el.type === 'radio') paintKey();
    if (/^characters\.\d+\.name$/.test(el.dataset.k)) {
      $('#qz-names').innerHTML = [...Q.characters.map((c) => c.name).filter(Boolean), 'Narrator'].map((n) => `<option value="${esc(n)}">`).join('');
    }
  };
  body.addEventListener('input', onField);
  body.addEventListener('change', onField);
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    const act = b.dataset.do;
    if (act === 'draft') { draft(); return; }
    if (act === 'pic') { drawPics([b.dataset.slot], missingPics(), picTools()); return; }
    if (act === 'upload') { picSlot = b.dataset.slot; $('#qz-pic-file').click(); return; }
    if (act === 'picsAll') { drawPics([], missingPics(), picTools()); return; }
    if (act === 'lvDel') { deleteLevel(Number(b.dataset.i)); return; }
    if (act === 'lvUp') moveLevel(Number(b.dataset.i), -1);
    if (act === 'lvDown') moveLevel(Number(b.dataset.i), 1);
    if (act === 'lvAdd') Q.levels.push(newLevel(Q.levels));
    if (act === 'addChar') Q.characters.push({ name: '', who: '' });
    if (act === 'delChar') Q.characters.splice(Number(b.dataset.i), 1);
    if (act === 'addLine') at(b.dataset.path).push({ speaker: '', text: '' });
    if (act === 'delLine') at(b.dataset.path).splice(Number(b.dataset.i), 1);
    dirty = true;
    render();
  });
  $('#qz-save').onclick = async () => { if (await save()) setMsg(t('quiz.saved')); };
  $('#qz-copy').onclick = copySheet;
  $('#qz-try').onclick = tryPlay;
  $('#qz-edit-back').onclick = leaveEditor;
}

