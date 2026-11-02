// Both kinds of quest as one list of pages, and the rules for playing that list (pure, tested in
// quest_pages.test.mjs): the next page, the options a choice page shows, answers, keyword talk, playing a choice
// again and the result. The screen is quiz_play.js.
import { sceneOf } from './quest.js?v=69d1ef9c6b81';
import { normalizeStory } from './quest_story.js?v=69d1ef9c6b81';

// ---------- a simple quest as pages ----------

// Title card, background, then per level a "Level n" card, one page per line and the A/B question, then the ending
// lines and "Mission Complete!". Every page names its picture (intro, l<level id>, ending).
export function pagesOf(q) {
  const out = [];
  const add = (p) => out.push({ id: `p${out.length + 1}`, goto: '', ...p });
  const say = (r, scene) => (!r.speaker || /^narrator$/i.test(r.speaker)
    ? add({ type: 'narration', text: r.text, scene })
    : add({ type: 'talk', speaker: r.speaker, label: '', text: r.text, scene }));
  add({ type: 'chapter', heading: '', title: q.title, scene: 'intro' });
  if (q.background) add({ type: 'narration', text: q.background, scene: 'intro' });
  q.levels.forEach((l, i) => {
    const scene = `l${l.id}`;
    add({ type: 'chapter', heading: `Level ${i + 1}`, title: l.title, scene });
    l.lines.forEach((r) => say(r, scene));
    add({ type: 'puzzle', kind: 'choice', title: '', text: l.question, options: [l.a, l.b], answer: l.answer === 'B' ? 1 : 0,
      accept: [], placeholder: '', hints: l.hint ? [l.hint] : [], reveal: '', right: l.right, wrong: l.wrong, scene });
  });
  q.ending.forEach((r) => say(r, 'ending'));
  add({ type: 'ending', title: 'Mission Complete!', text: '任務完成！', scene: 'ending' });
  return out;
}

// A simple quest copied as a story quest: one scene per picture, the pages of pagesOf. pictures lists
// [picture of the simple quest, picture of the story quest] so the copy keeps the drawn pictures.
export function storyFromSimple(q) {
  const slots = [['intro', 'intro', 'Intro'], ...q.levels.map((l, i) => [`l${l.id}`, `l${i + 1}`, `Level ${i + 1}`]),
    ['ending', 'ending', 'Ending']];
  const sceneId = new Map(slots.map(([slot, id]) => [slot, id]));
  const quest = normalizeStory({
    ...q, id: '', mode: 'story', items: [],
    scenes: slots.map(([slot, id, name]) => ({ id, name, scene: sceneOf(q, slot) })),
    pages: pagesOf(q).map((p) => ({ ...p, scene: sceneId.get(p.scene) || '' })),
  });
  return { quest, pictures: slots.map(([slot, id]) => [slot, `s${id}`]) };
}

// What the player plays: the pages with each scene replaced by its picture name, and the items
export function playable(q) {
  if (q.mode !== 'story') return { pages: pagesOf(q), items: [] };
  const scenes = new Set(q.scenes.map((s) => s.id));
  return {
    pages: q.pages.map((p) => ('scene' in p ? { ...p, scene: scenes.has(p.scene) ? `s${p.scene}` : '' } : p)),
    items: q.items.map((it) => ({ ...it, pic: `i${it.id}` })),
  };
}

// ---------- playing ----------

const PUZZLE = { tried: [], misses: 0, wrong: false, hints: 0, gaveUp: false, solved: false };

// at: index of the page; taken: "<page id>:<option id>" for every option picked; items: [{ id, text }] in the order
// they were got; pic: the picture shown (a page with no scene keeps the one before); chapter: id of the last
// chapter card; endings: ids of the endings reached
function go(G, s, i, now) {
  const p = G.pages[i];
  if (!p) return { ...s, done: true, ended: now };
  return { ...s, at: i, puzzle: PUZZLE, pic: p.scene || s.pic, chapter: p.type === 'chapter' ? p.id : s.chapter };
}

export function startState(G, now = Date.now(), from = 0) {
  const s = { at: 0, taken: [], items: [], mistakes: 0, retryAt: '', retried: false, endings: [], pic: '', chapter: '',
    started: now, ended: 0, done: false, puzzle: PUZZLE };
  // Played from a page in the middle: the picture is the last one set before it
  const pic = G.pages.slice(0, from + 1).reduce((last, p) => p.scene || last, '');
  return { ...go(G, s, from, now), pic };
}

// A jump to a page that is not there goes to the next page
function nextIndex(G, at, goto) {
  const i = goto ? G.pages.findIndex((p) => p.id === goto) : -1;
  return i >= 0 ? i : at + 1;
}

export const page = (G, s) => G.pages[s.at];

// once: gone after it was picked; needs: shows only after all of those options on the same page were picked; on a
// second try at the choice that allows one, the option picked the first time is gone
export function visibleOptions(G, s) {
  const p = page(G, s);
  if (p?.type !== 'choice') return [];
  const took = (id) => s.taken.includes(`${p.id}:${id}`);
  return p.options.filter((o) => !(took(o.id) && (o.once || (s.retried && s.retryAt === p.id)))
    && o.needs.every(took));
}

function take(G, s, p) {
  const it = G.items.find((x) => x.id === p.item);
  if (!it) return s;
  const had = s.items.find((x) => x.id === it.id);
  const text = p.action === 'update' ? p.text || had?.text || it.text : had?.text ?? it.text;
  const items = had ? s.items.map((x) => (x.id === it.id ? { id: x.id, text } : x)) : [...s.items, { id: it.id, text }];
  return { ...s, items };
}

// One step forward. An unsolved puzzle and a choice with options to pick wait; an item page puts its item in the
// bag when it is left; after an ending (or the last page) comes the result.
export function advance(G, s, now = Date.now()) {
  if (s.done) return s;
  const p = page(G, s);
  if (!p) return { ...s, done: true, ended: now };
  if (p.type === 'puzzle' && !s.puzzle.solved && !s.puzzle.gaveUp) return s;
  if (p.type === 'choice' && visibleOptions(G, s).length) return s;
  if (p.type === 'ending') return { ...s, done: true, ended: now, endings: [...s.endings, p.id] };
  const t = p.type === 'item' ? take(G, s, p) : s;
  return go(G, t, p.type === 'choice' ? s.at + 1 : nextIndex(G, s.at, p.goto), now);
}

export function pick(G, s, optionId, now = Date.now()) {
  const p = page(G, s);
  const o = visibleOptions(G, s).find((x) => x.id === optionId);
  if (s.done || !o) return s;
  const t = { ...s, taken: [...s.taken, `${p.id}:${o.id}`], retryAt: p.retry ? p.id : s.retryAt };
  return go(G, t, nextIndex(G, s.at, o.goto), now);
}

// Typed answers and keywords: no spaces around, any case, runs of spaces count as one, end punctuation ignored
export const clean = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?。！？,，]+$/u, '');
export const matches = (value, accept) => !!clean(value) && accept.some((a) => clean(a) === clean(value));

// value: the option's index (choice) or the typed text (input). A wrong answer counts one mistake and opens the
// first hint.
export function answer(G, s, value) {
  const p = page(G, s);
  if (s.done || p?.type !== 'puzzle' || s.puzzle.solved || s.puzzle.gaveUp) return s;
  const choice = p.kind === 'choice';
  if (choice && (!Number.isInteger(value) || value < 0 || value >= p.options.length || s.puzzle.tried.includes(value))) return s;
  if (!choice && !clean(value)) return s;
  if (choice ? value === p.answer : matches(value, p.accept)) {
    return { ...s, puzzle: { ...s.puzzle, solved: true, wrong: false } };
  }
  const z = s.puzzle;
  return { ...s, mistakes: s.mistakes + 1, puzzle: { ...z, wrong: true, misses: z.misses + 1,
    tried: choice ? [...z.tried, value] : z.tried, hints: Math.max(z.hints, p.hints.length ? 1 : 0) } };
}

export function hint(G, s) {
  const p = page(G, s);
  if (p?.type !== 'puzzle' || s.puzzle.solved || s.puzzle.hints >= p.hints.length) return s;
  return { ...s, puzzle: { ...s.puzzle, hints: s.puzzle.hints + 1 } };
}

// A typed puzzle can be given up once every hint is open (or after a wrong answer when it has no hints)
export function canGiveUp(G, s) {
  const p = page(G, s);
  if (p?.type !== 'puzzle' || p.kind !== 'input' || s.puzzle.solved || s.puzzle.gaveUp) return false;
  return p.hints.length ? s.puzzle.hints >= p.hints.length : s.puzzle.misses > 0;
}

export const giveUp = (G, s) => (canGiveUp(G, s) ? { ...s, puzzle: { ...s.puzzle, gaveUp: true } } : s);

// Keyword talk with a person: a keyword equal to the question first, then one found in it as a whole word (Chinese
// words anywhere in it); '' when nothing matches
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u;
const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, w) => (CJK.test(w) ? text.includes(w)
  : new RegExp(`(?<![\\p{L}\\p{N}])${escRe(w)}(?![\\p{L}\\p{N}])`, 'u').test(text));

export function replyOf(item, question) {
  const c = clean(question);
  if (!c) return '';
  const rows = item.keywords.filter((k) => k.reply);
  const hit = rows.find((k) => k.words.some((w) => clean(w) === c))
    || rows.find((k) => k.words.some((w) => clean(w) && hasWord(c, clean(w))));
  return hit ? hit.reply : '';
}

// "If you had chosen differently": once per play, after an ending, back to the last choice that allows it
export const canRetry = (s) => s.done && !s.retried && !!s.retryAt && s.endings.length > 0;

export function retry(G, s, now = Date.now()) {
  const i = G.pages.findIndex((p) => p.id === s.retryAt);
  if (!canRetry(s) || i < 0) return s;
  return go(G, { ...s, retried: true, done: false, ended: 0 }, i, now);
}

export const stars = (mistakes) => (mistakes === 0 ? 3 : mistakes <= 2 ? 2 : 1);

// ending: the last ending page reached (null when the pages ran out first); seconds from the start to the result
export function result(G, s) {
  const endings = s.endings.map((id) => G.pages.find((p) => p.id === id)).filter(Boolean);
  return { ending: endings[endings.length - 1] || null, endings, mistakes: s.mistakes, stars: stars(s.mistakes),
    seconds: Math.max(0, Math.round((s.ended - s.started) / 1000)) };
}
