// Playing a quest (both kinds) in the upright frame: the picture on top and one page at a time below it, like the
// story game's dialog box; the bag of items, keyword talk, hints, the result. The rules are quest_pages.js.
import { t } from './i18n.js?v=69d1ef9c6b81';
import { $, esc, setBackdrop } from './ui.js?v=69d1ef9c6b81';
import { SDG_LOOK } from './quest.js?v=69d1ef9c6b81';
import { playable, startState, page, visibleOptions, advance, pick, answer, hint, canGiveUp, giveUp, replyOf,
  canRetry, retry, result } from './quest_pages.js?v=69d1ef9c6b81';

const KIND_ICON = { doc: '📄', image: '🖼️', person: '🧑' };
const LETTERS = 'ABCDEFGH';
// Pages with nothing to pick: a tap anywhere goes on. Chapter, notice and item cover the whole frame.
const FULL = new Set(['chapter', 'notice', 'item']);

let Q = null;          // the quest with its pictures
let G = null;          // playable(Q)
let S = null;          // the play state
let from = 0;          // the page the play starts on (the editor can start from any page)
let back = null;
let bag = null;        // null: closed; '': the list; an item id: that item open
let talks = new Map(); // person id -> [{ q, a }] asked during this play
let typed = '';        // the last typed answer, kept in the box after a wrong try

const pic = (name) => Q.pictures?.[name] || '';
const itemOf = (id) => G.items.find((it) => it.id === id);
const go = (label) => `<button class="qp-btn primary" type="button" data-qp="next">${esc(label)} ▶</button>`;
const more = '<i class="qp-more" aria-hidden="true">▼</i>';

// ---------- pages ----------

function puzzleHtml(p) {
  const z = S.puzzle;
  const over = z.solved || z.gaveUp;
  const head = `${p.title ? `<h3>${esc(p.title)}</h3>` : ''}<p>${esc(p.text)}</p>`;
  let ask = '';
  if (p.kind === 'choice') {
    // Blank options stay out; their index still counts so the answer index stays right
    ask = `<div class="qp-opts">${p.options.map((label, i) => {
      if (!label) return '';
      const state = z.solved && i === p.answer ? ' right' : z.tried.includes(i) ? ' wrong' : '';
      return `<button class="qp-opt${state}" type="button" data-qp="answer" data-i="${i}"${over || z.tried.includes(i) ? ' disabled' : ''}>
        <b>${LETTERS[i]}</b><span>${esc(label)}</span></button>`;
    }).join('')}</div>`;
  } else if (!over) {
    ask = `<form class="qp-type" data-qp="type"><input id="qp-input" autocomplete="off" maxlength="80"
      placeholder="${esc(p.placeholder || t('quiz.play.typeHere'))}" value="${esc(typed)}">
      <button class="qp-btn primary" type="submit">${esc(t('common.send'))}</button></form>`;
  }
  let say = '';
  if (z.solved) say = `<p class="qp-ok" role="status">✔ ${esc(p.right || `Correct! ${t('quiz.play.correct')}`)}</p>`;
  else if (z.gaveUp) say = `<p class="qp-reveal" role="status">${esc(p.reveal || t('quiz.play.answerIs', { a: p.accept[0] || '' }))}</p>`;
  // data-n makes each new wrong answer a new message, so it fades in again (a hint alone leaves it still)
  else if (z.wrong) say = `<p class="qp-no" role="status" data-n="${z.misses}">✘ ${esc(p.wrong || 'Not quite. Try again!')}</p>`;
  const hints = p.hints.slice(0, z.hints).map((h) => `<p class="qp-hint">💡 ${esc(h)}</p>`).join('');
  const tools = over ? go(t('quiz.play.go')) : [
    z.hints < p.hints.length
      ? `<button class="qp-btn" type="button" data-qp="hint">${esc(t('quiz.play.hint', { n: z.hints + 1, max: p.hints.length }))}</button>` : '',
    canGiveUp(G, S) ? `<button class="qp-btn" type="button" data-qp="giveup">${esc(t('quiz.play.giveUp'))}</button>` : '',
  ].join('');
  return `<div class="qp-box">${head}</div>${ask}${say}${hints}${tools ? `<div class="qp-tools">${tools}</div>` : ''}`;
}

function choiceHtml(p) {
  const opts = visibleOptions(G, S);
  const head = p.title || p.text ? `<div class="qp-box">${p.title ? `<h3>${esc(p.title)}</h3>` : ''}${p.text ? `<p>${esc(p.text)}</p>` : ''}${opts.length ? '' : more}</div>` : '';
  return head + (opts.length ? `<div class="qp-opts">${opts.map((o, i) => `<button class="qp-opt" type="button" data-qp="pick" data-id="${esc(o.id)}">
    <b>${i + 1}</b><span>${esc(o.label)}</span></button>`).join('')}</div>` : '');
}

function itemHtml(p) {
  const it = itemOf(p.item);
  if (!it) return '';
  const src = pic(it.pic);
  return `<div class="qp-card qp-item"><small>${esc(t(p.action === 'update' ? 'quiz.play.updated' : 'quiz.play.got'))}</small>
    ${src ? `<img src="${esc(src)}" alt="">` : `<span class="qp-ico" aria-hidden="true">${KIND_ICON[it.kind]}</span>`}
    <h3>${esc(it.name)}</h3><p>${esc(p.text || it.text)}</p><p class="qp-tap">${esc(t('quiz.play.tap'))}</p></div>`;
}

function pageHtml(p) {
  if (!p) return '';
  if (p.type === 'narration') return `<div class="qp-box"><p>${esc(p.text)}</p>${more}</div>`;
  if (p.type === 'talk') {
    return `<div class="qp-box qp-talk"><b class="qp-name">${esc(p.speaker)}${p.label ? `<small>${esc(p.label)}</small>` : ''}</b>
      <p>${esc(p.text)}</p>${more}</div>`;
  }
  if (p.type === 'caption') return `<p class="qp-caption">${esc(p.text)}</p>`;
  if (p.type === 'chapter') {
    return `<div class="qp-chapter">${p.heading ? `<small>${esc(p.heading)}</small>` : ''}<h2>${esc(p.title)}</h2>
      <p class="qp-tap">${esc(t('quiz.play.tap'))}</p></div>`;
  }
  if (p.type === 'notice') {
    return `<div class="qp-card qp-notice" role="dialog"><h3>📜 ${esc(p.title || t('quiz.play.notice'))}</h3><p>${esc(p.text)}</p>
      ${go(t('common.ok'))}</div>`;
  }
  if (p.type === 'item') return itemHtml(p);
  if (p.type === 'choice') return choiceHtml(p);
  if (p.type === 'puzzle') return puzzleHtml(p);
  // ending: the result comes after it
  return `<div class="qp-card qp-end"><h2>${esc(p.title || t('quiz.play.end'))}</h2>${p.text ? `<p>${esc(p.text)}</p>` : ''}
    ${go(t('quiz.play.toResult'))}</div>`;
}

function resultHtml() {
  const r = result(G, S);
  const n = r.stars;
  const time = `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, '0')}`;
  return `<div class="qp-card qp-result">
    <p class="qp-mission">${esc(r.ending?.title || 'Mission Complete!')}</p>
    ${r.ending?.text ? `<p>${esc(r.ending.text)}</p>` : ''}
    <p class="qp-stars" aria-label="${esc(t('quiz.play.starsLabel', { n }))}">${'★'.repeat(n)}<span>${'★'.repeat(3 - n)}</span></p>
    <p class="qp-stats">${esc(r.mistakes ? t('quiz.play.mistakes', { n: r.mistakes }) : t('quiz.play.perfect'))}<br>${esc(t('quiz.play.time', { time }))}</p>
    ${r.endings.length > 1 ? `<p class="qp-stats">${esc(t('quiz.play.endings'))}</p>
      <p class="qp-ends">${r.endings.map((e) => `<span>${esc(e.title || t('quiz.play.end'))}</span>`).join('')}</p>` : ''}
    <div class="qp-acts">
      ${canRetry(S) ? `<button class="qp-btn" type="button" data-qp="retry">${esc(t('quiz.play.retry'))}</button>` : ''}
      <button class="qp-btn" type="button" data-qp="again">${esc(t('quiz.play.again'))}</button>
      <button class="qp-btn primary" type="button" data-qp="exit">${esc(t('common.back'))}</button>
    </div></div>`;
}

// ---------- the bag ----------

function bagHtml() {
  const head = (title, backTo) => `<header class="qp-sheet-head">
    ${backTo ? `<button class="qp-btn" type="button" data-bag="list">← ${esc(t('quiz.play.bag'))}</button>` : `<h3>🎒 ${esc(t('quiz.play.bag'))}</h3>`}
    ${backTo ? `<h3>${esc(title)}</h3>` : ''}
    <button class="qp-icon" type="button" data-bag="close" aria-label="${esc(t('common.close'))}">✕</button></header>`;
  const it = bag && itemOf(bag);
  if (!it) {
    const list = S.items.map(({ id }) => {
      const x = itemOf(id);
      const src = pic(x.pic);
      return `<button type="button" data-bag="open" data-id="${esc(id)}">${src ? `<img src="${esc(src)}" alt="">`
        : `<span class="qp-ico" aria-hidden="true">${KIND_ICON[x.kind]}</span>`}<span>${esc(x.name)}</span></button>`;
    }).join('');
    return head(t('quiz.play.bag'), false) + (list ? `<div class="qp-bag-list">${list}</div>` : `<p class="qp-stats">${esc(t('quiz.play.bagEmpty'))}</p>`);
  }
  const text = S.items.find((x) => x.id === it.id)?.text ?? it.text;
  const src = pic(it.pic);
  let talk = '';
  if (it.kind === 'person') {
    const log = (talks.get(it.id) || []).map((r) => `<p class="q">${esc(r.q)}</p><p class="a">${esc(r.a)}</p>`).join('');
    talk = `<div class="qp-log" aria-live="polite">${log}</div>
      <form class="qp-type" data-bag="ask"><input id="qp-ask" autocomplete="off" maxlength="80" placeholder="${esc(t('quiz.play.askPh'))}">
      <button class="qp-btn primary" type="submit">${esc(t('quiz.play.ask'))}</button></form>`;
  }
  return `${head(it.name, true)}<div class="qp-detail">${src ? `<img src="${esc(src)}" alt="">` : ''}<p>${esc(text)}</p>${talk}</div>`;
}

function paintBag() {
  const el = $('#qp-bag');
  el.hidden = bag === null;
  // The sheet itself stays between repaints, so it slides up only when the bag opens
  const sheet = el.firstElementChild;
  if (bag === null) el.innerHTML = '';
  else if (sheet) { sheet.innerHTML = bagHtml(); sheet.scrollTop = 0; }
  else el.innerHTML = `<div class="qp-sheet">${bagHtml()}</div>`;
  if (bag !== null) (el.querySelector('#qp-ask') || el.querySelector('[data-bag]')).focus({ preventScroll: true });
}

// ---------- painting ----------

// The parts of the page last painted. Repainting the same page (a wrong answer, a hint) keeps those still;
// only the new parts fade in, and only a newly wrong option shakes. An option that only turns disabled stays still.
let shown = new Set();
function keepStill(body, samePage) {
  const parts = [...body.querySelectorAll(':scope > *, .qp-opt')];
  const marks = parts.map((el) => el.outerHTML.replace(' disabled=""', ''));
  if (samePage) parts.forEach((el, i) => el.classList.toggle('still', shown.has(marks[i])));
  shown = new Set(marks);
}

function paint(samePage = false) {
  const p = page(G, S);
  const src = pic(S.pic);
  const img = $('#qp-img');
  $('#qp-pic').hidden = !src;
  if (src && img.getAttribute('src') !== src) img.src = src;
  $('#qp-fill').style.backgroundImage = src ? `url(${JSON.stringify(src)})` : '';
  setBackdrop(src);
  const ch = G.pages.find((x) => x.id === S.chapter);
  $('#qp-title').textContent = ch ? [ch.heading, ch.title].filter(Boolean).join(' · ') : Q.title;
  $('#qp-bar').style.width = `${S.done ? 100 : Math.round((100 * S.at) / Math.max(1, G.pages.length - 1))}%`;
  $('#qp-bag-n').textContent = S.items.length || '';
  $('#qp').classList.toggle('full', !S.done && FULL.has(p?.type));
  const body = $('#qp-body');
  body.innerHTML = S.done ? resultHtml() : pageHtml(p);
  keepStill(body, samePage);
  // A page keeps its buttons in view; the result starts at the ending's title
  body.scrollTop = S.done ? 0 : body.scrollHeight;
  paintBag();
  // Focus stays off the buttons so a run of Space presses never picks an option by accident; a typed answer gets the box
  if (bag === null) (body.querySelector('#qp-input') || body).focus({ preventScroll: true });
}

function step(next) {
  if (next === S) return;
  const samePage = next.at === S.at && next.done === S.done;
  if (!samePage) typed = '';
  S = next;
  paint(samePage);
}

function restart() {
  S = startState(G, Date.now(), from);
  talks = new Map();
  typed = '';
  bag = null;
  paint();
}

// ---------- reading aloud ----------

function speakText() {
  if (S.done) return result(G, S).ending?.title || 'Mission Complete!';
  const p = page(G, S);
  if (!p) return '';
  if (p.type === 'chapter') return [p.heading, p.title].filter(Boolean).join('. ');
  if (p.type === 'item') return [itemOf(p.item)?.name, p.text || itemOf(p.item)?.text].filter(Boolean).join('. ');
  if (p.type === 'choice') return [p.title, p.text, ...visibleOptions(G, S).map((o) => o.label)].filter(Boolean).join('. ');
  if (p.type === 'puzzle') {
    const z = S.puzzle;
    if (z.wrong && !z.solved) return [p.wrong || 'Not quite. Try again!', ...p.hints.slice(0, z.hints)].join(' ');
    if (z.solved && p.right) return p.right;
    return [p.text, ...(p.kind === 'choice' ? p.options.filter(Boolean).map((o, i) => `${LETTERS[i]}: ${o}`) : [])].join('. ');
  }
  return [p.title, p.text].filter(Boolean).join('. ');
}

function speak() {
  const synth = globalThis.speechSynthesis;
  const text = speakText();
  if (!synth || !text) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = /[㐀-鿿]/.test(text) ? 'zh-TW' : 'en-US';
  u.rate = 0.9;
  synth.speak(u);
}

function exit() {
  globalThis.speechSynthesis?.cancel();
  setBackdrop(null);
  back();
}

// ---------- entry ----------

// from: the index of the page to start on (the editor's "play from this page")
export function playQuest(quest, navigation, { back: onBack, from: start = 0 }) {
  Q = quest;
  G = playable(Q);
  back = onBack;
  from = Math.min(Math.max(0, start), Math.max(0, G.pages.length - 1));
  const look = SDG_LOOK[Q.sdg] || SDG_LOOK.other;
  $('#qp').style.setProperty('--sdg', look.color);
  $('#qp-badge').textContent = look.icon;
  $('#qp-speak').hidden = !globalThis.speechSynthesis;
  $('#qp-bag-btn').hidden = !G.items.length;
  for (const [id, key] of [['#qp-speak', 'quiz.play.read'], ['#qp-bag-btn', 'quiz.play.bag'], ['#qp-exit', 'quiz.play.exit']]) {
    $(id).title = t(key);
    $(id).setAttribute('aria-label', t(key));
  }
  navigation.show('scr-quiz-play');
  restart();
}

function act(b) {
  const a = b.dataset.qp;
  if (a === 'next') step(advance(G, S));
  if (a === 'pick') step(pick(G, S, b.dataset.id));
  if (a === 'answer') step(answer(G, S, Number(b.dataset.i)));
  if (a === 'hint') step(hint(G, S));
  if (a === 'giveup') step(giveUp(G, S));
  if (a === 'retry') step(retry(G, S));
  if (a === 'again') restart();
  if (a === 'exit') exit();
}

// A number key picks the option with that number (A, B... also pick a puzzle's options)
function keyPick(key) {
  const p = page(G, S);
  if (S.done || !p) return false;
  if (p.type === 'choice') {
    const o = visibleOptions(G, S)[Number(key) - 1];
    if (o) step(pick(G, S, o.id));
    return !!o;
  }
  if (p.type !== 'puzzle' || p.kind !== 'choice' || key.length !== 1) return false;
  const i = /^[1-8]$/.test(key) ? Number(key) - 1 : LETTERS.indexOf(key);
  if (i < 0 || !p.options[i]) return false;
  step(answer(G, S, i));
  return true;
}

export function initPlayer() {
  const body = $('#qp-body');
  body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-qp]');
    if (b) { if (!b.disabled && b.tagName === 'BUTTON') act(b); return; }
    if (!e.target.closest('form, .qp-opts, .qp-result')) step(advance(G, S));
  });
  body.addEventListener('submit', (e) => {
    e.preventDefault();
    typed = $('#qp-input').value;
    step(answer(G, S, typed));
    if (!S.puzzle.solved && !S.puzzle.gaveUp) $('#qp-input')?.select();
  });
  $('#qp-pic').addEventListener('click', () => step(advance(G, S)));
  $('#qp-bag').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bag]');
    if (e.target === e.currentTarget || b?.dataset.bag === 'close') bag = null;
    else if (b?.dataset.bag === 'list') bag = '';
    else if (b?.dataset.bag === 'open') bag = b.dataset.id;
    else return;
    paintBag();
    if (bag === null) $('#qp-bag-btn').focus({ preventScroll: true });
  });
  $('#qp-bag').addEventListener('submit', (e) => {
    e.preventDefault();
    const it = itemOf(bag);
    const q = $('#qp-ask').value.trim();
    if (!it || !q) return;
    talks.set(it.id, [...(talks.get(it.id) || []), { q, a: replyOf(it, q) || it.miss || t('quiz.play.noReply') }]);
    paintBag();
    // The box sits last, under the newest answer. Only the sheet scrolls: scrollIntoView also shifted the player frame
    const sheet = $('#qp-bag .qp-sheet');
    sheet.scrollTop = sheet.scrollHeight;
  });
  $('#qp-bag-btn').onclick = () => { bag = ''; paintBag(); };
  $('#qp-speak').onclick = speak;
  $('#qp-exit').onclick = exit;
  document.addEventListener('keydown', (e) => {
    if ($('#scr-quiz-play').hidden || document.querySelector('.modal:not([hidden])')) return;
    if (e.key === 'Escape' && bag !== null) { bag = null; paintBag(); return; }
    if (bag !== null || e.target.closest('input, textarea, select') || e.ctrlKey || e.altKey || e.metaKey) return;
    if ((e.key === ' ' || e.key === 'Enter') && !e.target.closest('button')) { e.preventDefault(); step(advance(G, S)); return; }
    if (keyPick(e.key.toUpperCase())) e.preventDefault();
  });
}
