// Playing an SDGs English quest: the story background, then five levels (dialogue one line per click, one A/B
// question; a wrong answer shows the hint and the same question again), then the ending and "Mission Complete!".
import { t } from './i18n.js?v=de84f38ef71d';
import { $, esc } from './ui.js?v=de84f38ef71d';
import { SDG_LOOK } from './quest.js?v=de84f38ef71d';

const SPEAKER_COLORS = ['#f2c46d', '#8fd0ff', '#ffa3b5', '#a6e3a1', '#d3b4ff', '#ffcf99'];

// ---------- the rules (pure, tested in quiz.test.mjs) ----------

export const startState = () => ({ stage: 'intro', level: 0, shown: 0, picked: null, mistakes: 0 });

const linesOf = (q, s) => (s.stage === 'ending' ? q.ending : q.levels[s.level].lines);
export const asking = (q, s) => s.stage === 'level' && s.shown >= linesOf(q, s).length;
export const solved = (q, s) => asking(q, s) && s.picked === q.levels[s.level].answer;

// One click: the next dialogue line, or the next level once this one is solved; the question itself waits for an answer
export function advance(q, s) {
  if (s.stage === 'intro') return { ...s, stage: 'level', level: 0, shown: 1, picked: null };
  if (s.stage === 'level') {
    if (!asking(q, s)) return { ...s, shown: s.shown + 1 };
    if (!solved(q, s)) return s;
    if (s.level + 1 < q.levels.length) return { ...s, level: s.level + 1, shown: 1, picked: null };
    return { ...s, stage: 'ending', shown: 1, picked: null };
  }
  if (s.stage === 'ending') return s.shown < q.ending.length ? { ...s, shown: s.shown + 1 } : { ...s, stage: 'done' };
  return s;
}

// Picking A or B: a wrong side counts one mistake and leaves the question open; after the right side nothing changes
export function choose(q, s, side) {
  if (!asking(q, s) || solved(q, s)) return s;
  const right = side === q.levels[s.level].answer;
  return { ...s, picked: side, mistakes: s.mistakes + (right ? 0 : 1) };
}

export const stars = (mistakes) => (mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1);

// ---------- the screen ----------

let Q = null;
let S = null;
let back = null;
let colorOf = () => '';

function bubble(l) {
  const narrator = !l.speaker || /^narrator$/i.test(l.speaker);
  if (narrator) return `<p class="qp-line qp-narr" lang="en">${esc(l.text)}</p>`;
  return `<div class="qp-line" style="--who:${colorOf(l.speaker)}"><b lang="en">${esc(l.speaker)}</b><p lang="en">${esc(l.text)}</p></div>`;
}

// The picture for the part being played: the opening, the level, or the ending (also on the last screen)
function paintPicture() {
  const slot = S.stage === 'intro' ? 'intro' : S.stage === 'level' ? `l${S.level + 1}` : 'ending';
  const src = Q.pictures?.[slot];
  $('#qp-pic').hidden = !src;
  if (src && $('#qp-img').getAttribute('src') !== src) $('#qp-img').src = src;
}

function paint() {
  paintPicture();
  const body = $('#qp-body');
  const foot = $('#qp-foot');
  const total = Q.levels.length;
  $('#qp-progress').textContent = S.stage === 'level' ? `Level ${S.level + 1} / ${total}`
    : S.stage === 'intro' ? t('quiz.play.story') : t('quiz.play.end');
  $('#qp-dots').innerHTML = Q.levels.map((_, i) => {
    const done = S.stage === 'ending' || S.stage === 'done' || i < S.level || (i === S.level && solved(Q, S));
    return `<i class="${done ? 'done' : i === S.level && S.stage === 'level' ? 'now' : ''}"></i>`;
  }).join('');

  if (S.stage === 'intro') {
    body.innerHTML = `<h3 lang="en">${esc(Q.title)}</h3>
      <p class="qp-bg" lang="en">${esc(Q.background)}</p>
      <div class="qp-cast">${Q.characters.map((c) => `<span style="--who:${colorOf(c.name)}"><b lang="en">${esc(c.name)}</b>${c.who ? `<small>${esc(c.who)}</small>` : ''}</span>`).join('')}</div>`;
    foot.innerHTML = `<button class="btn primary" data-qp="next">${esc(t('quiz.play.start'))}</button>`;
  } else if (S.stage === 'done') {
    const n = stars(S.mistakes);
    body.innerHTML = `<div class="qp-done"><p class="qp-mission">Mission Complete!<br>任務完成！</p>
      <p class="qp-stars" aria-label="${esc(t('quiz.play.starsLabel', { n }))}">${'★'.repeat(n)}<span>${'★'.repeat(3 - n)}</span></p>
      <p class="hint">${esc(S.mistakes ? t('quiz.play.mistakes', { n: S.mistakes }) : t('quiz.play.perfect'))}</p></div>`;
    foot.innerHTML = `<button class="btn" data-qp="again">${esc(t('quiz.play.again'))}</button>
      <button class="btn primary" data-qp="exit">${esc(t('common.back'))}</button>`;
  } else {
    const rows = linesOf(Q, S).slice(0, S.shown);
    const head = S.stage === 'ending' ? `<h3>Ending</h3>` : `<h3 lang="en">Level ${S.level + 1}: ${esc(Q.levels[S.level].title)}</h3>`;
    let ask = '';
    if (asking(Q, S)) {
      const l = Q.levels[S.level];
      const opt = (side, text) => {
        const state = S.picked === side ? (side === l.answer ? ' right' : ' wrong') : '';
        return `<button class="qp-opt${state}" data-qp="pick" data-side="${side}"${solved(Q, S) ? ' disabled' : ''}>
          <b>${side}</b><span lang="en">${esc(text)}</span></button>`;
      };
      const feedback = !S.picked ? '' : solved(Q, S)
        ? `<p class="qp-ok" role="status">✔ Correct! ${esc(t('quiz.play.correct'))}</p>`
        : `<div class="qp-hint" role="status"><b>✘ Not quite. Try again!</b><p lang="en">💡 Hint: ${esc(l.hint)}</p></div>`;
      ask = `<div class="qp-ask"><p class="qp-q" lang="en">${esc(l.question)}</p>
        <div class="qp-opts">${opt('A', l.a)}${opt('B', l.b)}</div>${feedback}</div>`;
    }
    body.innerHTML = head + rows.map(bubble).join('') + ask;
    const waiting = asking(Q, S) && !solved(Q, S);
    const label = solved(Q, S) ? (S.level + 1 < total ? t('quiz.play.nextLevel') : t('quiz.play.toEnding'))
      : S.stage === 'ending' && S.shown >= Q.ending.length ? t('quiz.play.finish') : t('quiz.play.next');
    foot.innerHTML = waiting ? `<p class="hint">${esc(t('quiz.play.pickHint'))}</p>`
      : `<button class="btn primary" data-qp="next">${esc(label)} ▶</button>`;
  }
  body.scrollTop = body.scrollHeight;
  foot.querySelector('button')?.focus({ preventScroll: true });
}

function step(next) {
  if (next === S) return;
  S = next;
  paint();
}

// What the read-aloud button says: the latest line, or the question with both options, or the hint after a miss
function speakText() {
  if (S.stage === 'intro') return Q.background;
  if (S.stage === 'done') return 'Mission Complete!';
  if (asking(Q, S)) {
    const l = Q.levels[S.level];
    if (S.picked && !solved(Q, S)) return `Hint: ${l.hint}`;
    return `${l.question} A: ${l.a}. B: ${l.b}.`;
  }
  const last = linesOf(Q, S)[S.shown - 1];
  return last ? last.text : '';
}

function speak() {
  const synth = globalThis.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(speakText());
  u.lang = 'en-US';
  u.rate = 0.9;
  synth.speak(u);
}

function exit() {
  globalThis.speechSynthesis?.cancel();
  back();
}

export function playQuest(quest, navigation, { back: onBack }) {
  Q = quest;
  back = onBack;
  const names = Q.characters.map((c) => c.name.toLowerCase());
  colorOf = (name) => SPEAKER_COLORS[Math.max(0, names.indexOf(String(name).toLowerCase())) % SPEAKER_COLORS.length];
  const look = SDG_LOOK[Q.sdg] || SDG_LOOK.other;
  const panel = $('#qp-panel');
  panel.style.setProperty('--sdg', look.color);
  $('#qp-badge').textContent = look.icon;
  $('#qp-title').textContent = Q.title;
  $('#qp-speak').hidden = !globalThis.speechSynthesis;
  S = startState();
  navigation.show('scr-quiz-play');
  paint();
}

export function initPlayer() {
  $('#qp-foot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qp]');
    if (!b) return;
    if (b.dataset.qp === 'next') step(advance(Q, S));
    if (b.dataset.qp === 'again') { S = startState(); paint(); }
    if (b.dataset.qp === 'exit') exit();
  });
  $('#qp-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-qp="pick"]');
    if (b) { if (!b.disabled) step(choose(Q, S, b.dataset.side)); return; }
    // A click on the dialogue shows the next line, like the story mode's dialog box
    if (S.stage === 'level' && !asking(Q, S)) step(advance(Q, S));
    else if (S.stage === 'ending') step(advance(Q, S));
  });
  $('#qp-speak').onclick = speak;
  $('#qp-exit').onclick = exit;
  document.addEventListener('keydown', (e) => {
    if ($('#scr-quiz-play').hidden || e.target.closest('input, textarea, select') || document.querySelector('.modal:not([hidden])')) return;
    const key = e.key.toUpperCase();
    if ((key === 'A' || key === 'B') && asking(Q, S)) { e.preventDefault(); step(choose(Q, S, key)); }
  });
}
