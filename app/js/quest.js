// The shape of an SDGs English quest and its rules, with no storage or AI: shared by the editor, the player and
// local/quiz.js. A quest made with the form (mode "simple") has 1 to 20 levels, each with English dialogue and one
// A/B question that has exactly one correct answer. Story quests (made page by page) are in quest_story.js.
export const MAX_LEVELS = 20;
export const DRAFT_LEVELS = 10;   // most levels one AI draft writes
export const SDGS = ['6', '11', '12', '13', 'other'];
export const SDG_LOOK = {
  6: { icon: '💧', color: '#26bde2' }, 11: { icon: '🏙️', color: '#fd9d24' }, 12: { icon: '♻️', color: '#bf8b2e' },
  13: { icon: '🌍', color: '#3f7e44' }, other: { icon: '🌱', color: '#56c02b' },
};
// Field limits; the editor uses the same numbers for maxlength
export const LIMITS = { title: 80, name: 30, who: 120, place: 200, problem: 300, goal: 300, idea: 400, background: 900,
  levelTitle: 80, line: 300, question: 300, option: 200, hint: 300, feedback: 300, sdgOther: 80, scene: 400 };
export const MAX_CHARS = 6;
const MAX_LINES = 8;

export const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(v);
// The player adds "Level n:" itself, so a title that already starts with it loses that part
const levelTitle = (v) => str(v, LIMITS.levelTitle).replace(/^level\s*\d+\s*[:：.\-]\s*/i, '');
const answer = (v) => (String(v ?? '').trim().toUpperCase().startsWith('B') ? 'B' : 'A');

// A missing, odd or repeated id becomes the first free "<prefix><n>" counting from the item's place in the list,
// so the levels of a version 1 file (which have no ids) get 1 to n and keep their old pictures l1 to l5
export function withIds(list, prefix = '') {
  const taken = new Set(list.map((x) => x.id));
  const seen = new Set();
  return list.map((x, i) => {
    let id = okId(x.id) && !seen.has(x.id) ? x.id : '';
    for (let n = i + 1; !id; n += 1) if (!taken.has(`${prefix}${n}`)) id = `${prefix}${n}`;
    taken.add(id);
    seen.add(id);
    return { ...x, id };
  });
}

// A random id for something new, so it never takes over the picture of something deleted earlier
export function newId(list, prefix = '') {
  let id;
  do id = `${prefix}${Math.random().toString(36).slice(2, 7)}`; while (!okId(id) || list.some((x) => x.id === id));
  return id;
}

// The fields both kinds of quest have
export function base(q) {
  return {
    id: typeof q.id === 'string' && /^[A-Za-z0-9_]+$/.test(q.id) ? q.id : '',
    mode: q.mode === 'story' ? 'story' : 'simple',
    title: str(q.title, LIMITS.title),
    sdg: SDGS.includes(String(q.sdg)) ? String(q.sdg) : '6',
    sdg_other: str(q.sdg_other, LIMITS.sdgOther),
    characters: (Array.isArray(q.characters) ? q.characters : []).slice(0, MAX_CHARS)
      .map((c) => ({ name: str(c?.name, LIMITS.name), who: str(c?.who, LIMITS.who) })).filter((c) => c.name),
    created_at: str(q.created_at, 40), updated_at: str(q.updated_at, 40),
  };
}

// Dialogue lines; a line with no text is dropped
export function lines(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_LINES)
    .map((r) => ({ speaker: str(r?.speaker, LIMITS.name), text: str(r?.text, LIMITS.line) }))
    .filter((r) => r.text);
}

// right / wrong: the author's own words after a right or a wrong answer (optional; the player has default words)
export function level(raw) {
  const o = raw?.options && typeof raw.options === 'object' ? raw.options : {};
  return {
    id: okId(raw?.id) ? raw.id : '',
    title: levelTitle(raw?.title), lines: lines(raw?.lines), question: str(raw?.question, LIMITS.question),
    a: str(raw?.a ?? o.A ?? o.a, LIMITS.option), b: str(raw?.b ?? o.B ?? o.b, LIMITS.option),
    answer: answer(raw?.answer), hint: str(raw?.hint, LIMITS.hint),
    right: str(raw?.right, LIMITS.feedback), wrong: str(raw?.wrong, LIMITS.feedback), scene: str(raw?.scene, LIMITS.scene),
  };
}

export const newLevel = (levels) => ({ ...level({}), id: newId(levels) });

// Any object in, a simple quest of the right shape out: 1 to 20 levels, each with an id, text clipped to the limits
export function normalize(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const levels = withIds((Array.isArray(q.levels) ? q.levels : []).slice(0, MAX_LEVELS).map(level));
  if (!levels.length) levels.push({ ...level({}), id: '1' });
  return {
    ...base(q), mode: 'simple',
    place: str(q.place, LIMITS.place), problem: str(q.problem, LIMITS.problem), goal: str(q.goal, LIMITS.goal),
    idea: str(q.idea, LIMITS.idea), background: str(q.background, LIMITS.background),
    levels, ending: lines(q.ending),
    intro_scene: str(q.intro_scene, LIMITS.scene), ending_scene: str(q.ending_scene, LIMITS.scene),
  };
}

// What still keeps a quest from being played; [] when every level is complete
export function problems(q) {
  const out = [];
  if (!q.title) out.push({ code: 'title' });
  if (!q.background) out.push({ code: 'background' });
  q.levels.forEach((l, i) => {
    const n = i + 1;
    if (!l.lines.some((r) => r.text)) out.push({ code: 'lines', n });
    if (!l.question) out.push({ code: 'question', n });
    if (!l.a || !l.b) out.push({ code: 'options', n });
    else if (l.a.toLowerCase() === l.b.toLowerCase()) out.push({ code: 'same', n });
    if (!l.hint) out.push({ code: 'hint', n });
  });
  if (!q.ending.some((r) => r.text)) out.push({ code: 'ending' });
  return out;
}

// The AI tends to put the correct answer first: each level gets it on a random side
export function shuffleSides(levels, rand = Math.random) {
  return levels.map((l) => {
    if (rand() < 0.5) return l;
    return { ...l, a: l.b, b: l.a, answer: l.answer === 'A' ? 'B' : 'A' };
  });
}

// One picture per stage of the game: the story background, each level (named by its id, so a picture stays with
// its level when levels move or are deleted), the ending
export const picturesOf = (q) => ['intro', ...q.levels.map((l) => `l${l.id}`), 'ending'];

// The English description a picture is drawn from: the one written for it, or one made from the place, the level
// and its first line when it was left empty
export function sceneOf(q, slot) {
  const first = (rows) => rows[0]?.text || '';
  if (slot === 'intro') return q.intro_scene || `${q.place}. ${q.background.split('. ')[0]}`;
  if (slot === 'ending') return q.ending_scene || `${q.place}. ${first(q.ending)}`;
  const l = q.levels.find((x) => `l${x.id}` === slot);
  return !l ? '' : l.scene || `${q.place}. ${l.title}. ${first(l.lines)}`;
}
