// The shape of an SDGs English quest and its rules, with no storage or AI: shared by the editor, the player and
// local/quiz.js. Five levels, each with English dialogue and one A/B question that has exactly one correct answer.
export const LEVELS = 5;
export const SDGS = ['6', '11', '12', '13', 'other'];
export const SDG_LOOK = {
  6: { icon: '💧', color: '#26bde2' }, 11: { icon: '🏙️', color: '#fd9d24' }, 12: { icon: '♻️', color: '#bf8b2e' },
  13: { icon: '🌍', color: '#3f7e44' }, other: { icon: '🌱', color: '#56c02b' },
};
// Field limits; the editor uses the same numbers for maxlength
export const LIMITS = { title: 80, name: 30, who: 120, place: 200, problem: 300, goal: 300, idea: 400, background: 900,
  levelTitle: 80, line: 300, question: 300, option: 200, hint: 300, sdgOther: 80 };
export const MAX_CHARS = 6;
const MAX_LINES = 8;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// The player adds "Level n:" itself, so a title that already starts with it loses that part
const levelTitle = (v) => str(v, LIMITS.levelTitle).replace(/^level\s*\d+\s*[:：.\-]\s*/i, '');
const answer = (v) => (String(v ?? '').trim().toUpperCase().startsWith('B') ? 'B' : 'A');

// Dialogue lines; a line with no text is dropped
export function lines(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_LINES)
    .map((r) => ({ speaker: str(r?.speaker, LIMITS.name), text: str(r?.text, LIMITS.line) }))
    .filter((r) => r.text);
}

export function level(raw) {
  const o = raw?.options && typeof raw.options === 'object' ? raw.options : {};
  return {
    title: levelTitle(raw?.title), lines: lines(raw?.lines), question: str(raw?.question, LIMITS.question),
    a: str(raw?.a ?? o.A ?? o.a, LIMITS.option), b: str(raw?.b ?? o.B ?? o.b, LIMITS.option),
    answer: answer(raw?.answer), hint: str(raw?.hint, LIMITS.hint),
  };
}

export const blankLevel = () => level({});

// Any object in, a quest of the right shape out: always five levels, text clipped to the limits
export function normalize(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  const levels = (Array.isArray(q.levels) ? q.levels : []).slice(0, LEVELS).map(level);
  while (levels.length < LEVELS) levels.push(blankLevel());
  return {
    id: typeof q.id === 'string' && /^[A-Za-z0-9_]+$/.test(q.id) ? q.id : '',
    title: str(q.title, LIMITS.title),
    sdg: SDGS.includes(String(q.sdg)) ? String(q.sdg) : '6',
    sdg_other: str(q.sdg_other, LIMITS.sdgOther),
    characters: (Array.isArray(q.characters) ? q.characters : []).slice(0, MAX_CHARS)
      .map((c) => ({ name: str(c?.name, LIMITS.name), who: str(c?.who, LIMITS.who) })).filter((c) => c.name),
    place: str(q.place, LIMITS.place), problem: str(q.problem, LIMITS.problem), goal: str(q.goal, LIMITS.goal),
    idea: str(q.idea, LIMITS.idea), background: str(q.background, LIMITS.background),
    levels, ending: lines(q.ending),
    created_at: str(q.created_at, 40), updated_at: str(q.updated_at, 40),
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
