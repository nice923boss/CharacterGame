// Story quests, made page by page (narration, talk, captions, chapter cards, puzzles, notices, items, choices and
// endings), and the functions that take a quest of either mode. The simple (form) mode is in quest.js; the rules
// for playing are in quest_pages.js.
import * as simple from './quest.js?v=69d1ef9c6b81';
import { base, okId, str, withIds } from './quest.js?v=69d1ef9c6b81';

export const PAGE_TYPES = ['narration', 'talk', 'caption', 'chapter', 'puzzle', 'notice', 'item', 'choice', 'ending'];
export const ITEM_KINDS = ['doc', 'image', 'person'];
export const STORY_MAX = { pages: 300, items: 30, scenes: 40, keywords: 30, options: 4, hints: 3, accept: 10, words: 10 };
export const STORY_LIMITS = { text: 600, name: 30, label: 30, heading: 40, title: 80, option: 200, hint: 300,
  feedback: 300, placeholder: 60, itemText: 900, reply: 400, word: 40, scene: 400, sceneName: 40 };
const L = STORY_LIMITS;

// Page text keeps its line breaks (at most one empty line in a row); spaces inside a line are collapsed
const para = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const ref = (v) => (okId(v) ? v : '');
const arr = (v, max) => (Array.isArray(v) ? v : []).slice(0, max);
const obj = (v) => (v && typeof v === 'object' ? v : {});

function words(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,，、]/);
  return list.map((w) => str(w, L.word)).filter(Boolean).slice(0, STORY_MAX.words);
}

function option(raw) {
  const o = obj(raw);
  return { id: ref(o.id), label: str(o.label, L.option), goto: ref(o.goto), once: o.once === true,
    needs: arr(o.needs, STORY_MAX.options).filter(okId) };
}

// The fields of each page type; a page of an unknown type becomes narration
export function page(raw) {
  const r = obj(raw);
  const type = PAGE_TYPES.includes(r.type) ? r.type : 'narration';
  const p = { id: ref(r.id), type };
  const text = para(r.text, L.text);
  const scene = ref(r.scene);
  const goto = ref(r.goto);
  if (type === 'narration' || type === 'caption') return { ...p, text, scene, goto };
  if (type === 'talk') return { ...p, speaker: str(r.speaker, L.name), label: str(r.label, L.label), text, scene, goto };
  if (type === 'chapter') return { ...p, heading: str(r.heading, L.heading), title: str(r.title, L.title), scene, goto };
  if (type === 'notice') return { ...p, title: str(r.title, L.title), text, goto };
  if (type === 'item') {
    return { ...p, item: ref(r.item), action: r.action === 'update' ? 'update' : 'get', text: para(r.text, L.itemText), goto };
  }
  if (type === 'ending') return { ...p, title: str(r.title, L.title), text, scene };
  if (type === 'choice') {
    const options = withIds(arr(r.options, STORY_MAX.options).map(option), 'o');
    const ids = options.map((o) => o.id);
    return { ...p, title: str(r.title, L.title), text, scene, retry: r.retry === true,
      options: options.map((o) => ({ ...o, needs: o.needs.filter((n) => n !== o.id && ids.includes(n)) })) };
  }
  // puzzle: a choice puzzle keeps blank options where the author left them, so the answer index stays right
  const options = arr(r.options, STORY_MAX.options).map((o) => str(o, L.option));
  const answer = Number.isInteger(r.answer) && r.answer >= 0 && r.answer < options.length ? r.answer : 0;
  return { ...p, title: str(r.title, L.title), text, scene, kind: r.kind === 'input' ? 'input' : 'choice', options,
    answer, accept: arr(r.accept, STORY_MAX.accept).map((a) => str(a, L.option)).filter(Boolean),
    placeholder: str(r.placeholder, L.placeholder),
    hints: arr(r.hints, STORY_MAX.hints).map((h) => str(h, L.hint)).filter(Boolean),
    reveal: para(r.reveal, L.feedback), right: para(r.right, L.feedback), wrong: para(r.wrong, L.feedback), goto };
}

// doc: a document to read; image: a picture with a caption; person: someone to talk to by keywords
export function item(raw) {
  const r = obj(raw);
  return {
    id: ref(r.id), kind: ITEM_KINDS.includes(r.kind) ? r.kind : 'doc', name: str(r.name, L.name),
    text: para(r.text, L.itemText), scene: str(r.scene, L.scene),
    keywords: arr(r.keywords, STORY_MAX.keywords).map((k) => ({ words: words(obj(k).words), reply: para(obj(k).reply, L.reply) }))
      .filter((k) => k.words.length || k.reply),
    miss: para(r.miss, L.feedback),
  };
}

const sceneRow = (raw) => ({ id: ref(obj(raw).id), name: str(obj(raw).name, L.sceneName), scene: str(obj(raw).scene, L.scene) });

export function normalizeStory(raw) {
  const q = obj(raw);
  return {
    ...base(q), mode: 'story',
    scenes: withIds(arr(q.scenes, STORY_MAX.scenes).map(sceneRow)),
    items: withIds(arr(q.items, STORY_MAX.items).map(item)),
    pages: withIds(arr(q.pages, STORY_MAX.pages).map(page), 'p'),
  };
}

// Whether some ending can be reached from the first page, following every jump and every choice (conditions on
// options are not looked at)
function reachesEnding(pages) {
  const at = new Map(pages.map((p, i) => [p.id, i]));
  const next = (i, goto) => (goto ? at.get(goto) : i + 1);
  const seen = new Set();
  const todo = [0];
  while (todo.length) {
    const i = todo.pop();
    if (i === undefined || i >= pages.length || seen.has(i)) continue;
    seen.add(i);
    const p = pages[i];
    if (p.type === 'ending') return true;
    if (p.type === 'choice' && p.options.length) for (const o of p.options) todo.push(next(i, o.goto));
    else todo.push(next(i, p.goto));
  }
  return false;
}

// What still keeps a story quest from being played; n is the page number shown in the editor
export function storyProblems(q) {
  const out = [];
  if (!q.title) out.push({ code: 'title' });
  if (!q.pages.length) return [...out, { code: 'pages' }];
  const ids = new Set(q.pages.map((p) => p.id));
  const items = new Set(q.items.map((i) => i.id));
  q.pages.forEach((p, i) => {
    const n = i + 1;
    const add = (code) => out.push({ code, n });
    if (['narration', 'talk', 'caption', 'notice'].includes(p.type) && !p.text) add('text');
    if (p.type === 'talk' && !p.speaker) add('speaker');
    if (p.type === 'chapter' && !p.title && !p.heading) add('chapter');
    if (p.type === 'puzzle') {
      if (!p.text && !p.title) add('puzzle_text');
      if (p.kind === 'choice' && (p.options.length < 2 || p.options.some((o) => !o))) add('puzzle_options');
      if (p.kind === 'input' && !p.accept.length) add('puzzle_answer');
    }
    if (p.type === 'item' && !items.has(p.item)) add('item_missing');
    if (p.type === 'choice' && !p.options.length) add('choice_options');
    if (p.type === 'choice' && p.options.some((o) => !o.label)) add('choice_label');
    const jumps = p.type === 'choice' ? p.options.map((o) => o.goto) : [p.goto];
    if (jumps.some((g) => g && !ids.has(g))) add('goto');
  });
  if (!q.pages.some((p) => p.type === 'ending')) out.push({ code: 'no_ending' });
  else if (!reachesEnding(q.pages)) out.push({ code: 'ending_reach' });
  return out;
}

// ---------- either mode ----------

export const normalizeQuest = (raw) => (obj(raw).mode === 'story' ? normalizeStory(raw) : simple.normalize(raw));
export const questProblems = (q) => (q.mode === 'story' ? storyProblems(q) : simple.problems(q));

// Picture names: a story quest has one per scene (s<id>) and one per item (i<id>)
export const questPictures = (q) => (q.mode === 'story'
  ? [...q.scenes.map((s) => `s${s.id}`), ...q.items.map((i) => `i${i.id}`)] : simple.picturesOf(q));

export function questScene(q, slot) {
  if (q.mode !== 'story') return simple.sceneOf(q, slot);
  const s = q.scenes.find((x) => `s${x.id}` === slot);
  if (s) return s.scene || s.name;
  const it = q.items.find((x) => `i${x.id}` === slot);
  if (!it) return '';
  return it.scene || (it.kind === 'person' ? `portrait of ${it.name}` : `close-up of ${it.name}, on a table`);
}
