// SDGs English quest: the list of quests, the editor (basic info, AI draft, five levels, ending) and file export.
// Playing a quest is in quiz_play.js; the storage and the AI draft are in local/quiz.js (browser build only).
import { del, get, job, post } from './api.js?v=a2430d6da8c1';
import { t } from './i18n.js?v=a2430d6da8c1';
import { $, confirmBox, esc, progress, toast, toastError } from './ui.js?v=a2430d6da8c1';
import { LIMITS, MAX_CHARS, PICTURES, SDGS, SDG_LOOK, normalize, problems } from './quest.js?v=a2430d6da8c1';
import { playQuest } from './quiz_play.js?v=a2430d6da8c1';

export const sdgName = (q) => (q.sdg === 'other' ? q.sdg_other || t('quiz.sdg.other') : t(`quiz.sdg.${q.sdg}`));

let nav = null;     // { show(screenId), title() } from main.js
let Q = null;       // quest open in the editor
let dirty = false;
let pics = {};      // slot -> picture address for the quest in the editor
let picSlot = '';   // the slot the picture file chooser is open for

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
        <small>${esc(r.ready ? t('quiz.ready') : t('quiz.unready'))}</small></span>
      <button class="btn small primary" data-row="play"${r.ready ? '' : ' disabled'}>${esc(t('quiz.playBtn'))}</button>
      <button class="btn small" data-row="edit">${esc(t('quiz.edit'))}</button>
      <button class="btn small" data-row="export">${esc(t('quiz.export'))}</button>
      <button class="btn small ghost" data-row="delete">${esc(t('common.delete'))}</button>
    </div>`).join('') : `<p class="hint qz-empty">${esc(t('quiz.empty'))}</p>`;
}

async function rowAction(act, id) {
  try {
    if (act === 'edit') { openEditor(await get(`/api/quiz/${id}`)); return; }
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

const picName = (slot) => (slot === 'intro' ? t('quiz.pic.intro') : slot === 'ending' ? t('quiz.pic.ending') : t('quiz.levelN', { n: slot.slice(1) }));

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
  return `<section class="qz-sec qz-level"><h3>${esc(t('quiz.levelN', { n: i + 1 }))}</h3>
    ${field(`${p}.title`, t('quiz.levelTitle'), l.title, { max: LIMITS.levelTitle, lang: 'en', ph: 'Clean the River' })}
    <span class="qz-sub">${esc(t('quiz.dialogue'))}</span>${linesHtml(`${p}.lines`, l.lines)}
    ${field(`${p}.question`, t('quiz.question'), l.question, { max: LIMITS.question, lang: 'en', ph: 'What should they do?' })}
    <div class="row2">${field(`${p}.a`, t('quiz.optA'), l.a, { max: LIMITS.option, lang: 'en' })}${field(`${p}.b`, t('quiz.optB'), l.b, { max: LIMITS.option, lang: 'en' })}</div>
    <div class="qz-answers">${radio('A')}${radio('B')}</div>
    ${field(`${p}.hint`, t('quiz.hint'), l.hint, { max: LIMITS.hint, lang: 'en', ph: t('quiz.ph.hint') })}
    <div class="row2">${field(`${p}.right`, t('quiz.right'), l.right, { max: LIMITS.feedback, lang: 'en', ph: `Correct! ${t('quiz.play.correct')}` })}${field(`${p}.wrong`, t('quiz.wrong'), l.wrong, { max: LIMITS.feedback, lang: 'en', ph: 'Not quite. Try again!' })}</div>
    ${pictureHtml(`l${i + 1}`, `${p}.scene`, l.scene)}
  </section>`;
}

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
    <div class="qz-draft"><button class="btn primary" data-do="draft">${esc(t('quiz.draft'))}</button>
      <p class="hint">${esc(t('quiz.draftHint'))}</p></div>
  </section>
  <section class="qz-sec"><h3>${esc(t('quiz.step2'))}</h3>
    ${field('background', t('quiz.background'), Q.background, { area: true, rows: 4, max: LIMITS.background, lang: 'en', ph: t('quiz.ph.background') })}
    ${pictureHtml('intro', 'intro_scene', Q.intro_scene)}
    <div class="qz-draft"><button class="btn" data-do="picsAll">${esc(t('quiz.pic.all'))}</button>
      <p class="hint">${esc(t('quiz.pic.allHint'))}</p></div>
  </section>
  ${Q.levels.map(levelHtml).join('')}
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
  const written = Q.background || Q.levels.some((l) => l.question || l.lines.length);
  if (written && !(await confirmBox(t('quiz.draftAsk'), t('quiz.draftOk')))) return;
  let running = null;
  const box = progress(t('quiz.drafting'), t('quiz.draftingSub'), () => running && running.cancel());
  running = job('/api/quiz/generate', { quest: Q }, (ev) => {
    if (ev.type === 'phase') box.update(`${t(`phase.${ev.code}`)}…`);
    if (ev.type === 'status') box.status(ev, () => running.retryNow());
  });
  try {
    const { draft: d } = await running.done;
    Object.assign(Q, { background: d.background, levels: d.levels, ending: d.ending, intro_scene: d.intro_scene, ending_scene: d.ending_scene });
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

// Draws the given pictures (every missing one when slots is empty); the quest is saved first, the job reads it
async function drawPics(slots) {
  if (!slots.length && PICTURES.every((s) => pics[s])) { setMsg(t('quiz.pic.noneMissing')); return; }
  if (!(await save())) return;
  let running = null;
  const box = progress(t('quiz.pic.drawing', { n: 1, total: slots.length || PICTURES.filter((s) => !pics[s]).length }),
    t('quiz.pic.drawingSub'), () => running && running.cancel());
  running = job(`/api/quiz/${Q.id}/pictures`, { slots }, (ev) => {
    if (ev.type === 'picture_start') box.update(t('quiz.pic.drawing', { n: ev.n, total: ev.total }));
    if (ev.type === 'picture') { pics = ev.pictures; render(); }
  });
  try {
    pics = (await running.done).pictures;
    render();
    setMsg(t('quiz.pic.done'));
  } catch (e) {
    if (e.code === 'cancelled') setMsg(e.message); else { setMsg(e.message, true); toastError(e); }
  } finally {
    box.close();
  }
}

const PIC_W = 960;
const PIC_H = 720;

// A picture from the computer cut to the 4:3 frame the player shows (its middle), at the AI pictures' size; a
// transparent PNG gets a white background
async function fitPicture(file) {
  const img = await createImageBitmap(file);
  const scale = Math.max(PIC_W / img.width, PIC_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = PIC_W;
  canvas.height = PIC_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PIC_W, PIC_H);
  ctx.drawImage(img, (PIC_W - w) / 2, (PIC_H - h) / 2, w, h);
  img.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob gave nothing'))), 'image/jpeg', 0.9));
}

// The chosen file takes the place of the slot's picture (an AI one too); the quest is saved first so it has an id
async function uploadPic(slot, file) {
  let blob;
  try { blob = await fitPicture(file); } catch (e) {
    console.warn('picture file could not be read', file.type, e);
    setMsg(t('quiz.pic.notImage'), true);
    return;
  }
  if (!(await save())) return;
  try {
    pics = (await post(`/api/quiz/${Q.id}/picture/${slot}`, blob)).pictures;
    render();
    setMsg(t('quiz.pic.uploaded'));
  } catch (e) { setMsg(e.message, true); toastError(e); }
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
  $('#qz-new').onclick = () => openEditor({});
  $('#qz-import').onclick = () => $('#qz-file').click();
  $('#qz-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
  $('#qz-pic-file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadPic(picSlot, f); };
  $('#qz-home-back').onclick = () => nav.title();
  $('#qz-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-row]');
    if (b && !b.disabled) rowAction(b.dataset.row, b.closest('.qz-row').dataset.id);
  });
  const body = $('#qz-edit-body');
  const onField = (e) => {
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
    if (act === 'pic') { drawPics([b.dataset.slot]); return; }
    if (act === 'upload') { picSlot = b.dataset.slot; $('#qz-pic-file').click(); return; }
    if (act === 'picsAll') { drawPics([]); return; }
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

