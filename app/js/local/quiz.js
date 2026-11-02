// SDGs English quest (browser build only): the AI writes a draft of the five levels and the ending; quests live in
// IndexedDB. The quest shape and its rules are in ../quest.js.
import * as store from './store.js?v=b9289d23998c';
import * as llm from './llm.js?v=b9289d23998c';
import * as images from './images.js?v=b9289d23998c';
import { lastJson } from './story.js?v=b9289d23998c';
import { LEVELS, LIMITS, PICTURES, level, lines, normalize, problems, sceneOf, shuffleSides } from '../quest.js?v=b9289d23998c';

const SDG_EN = {
  6: 'SDG 6 Clean Water and Sanitation', 11: 'SDG 11 Sustainable Cities and Communities',
  12: 'SDG 12 Responsible Consumption and Production (reduce waste)', 13: 'SDG 13 Climate Action',
};
const KV = 'quizzes';
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- AI draft ----------

const SYSTEM = `You write short English learning games for Taiwanese junior and senior high school students.
Use simple, clear English (CEFR A2 to B1): short sentences, common words, present or past tense.
Reply with one JSON object only, no other text.`;

export function draftMessages(q) {
  const sdg = q.sdg === 'other' ? (q.sdg_other || 'another Sustainable Development Goal') : SDG_EN[q.sdg];
  const cast = q.characters.map((c) => `- ${c.name}${c.who ? `: ${c.who}` : ''}`).join('\n');
  const user = `Write an interactive story game about ${sdg}.
The student's notes may be in Chinese; write everything in English, but keep the character names as given.

Game title: ${q.title}
Main characters:
${cast}
Place: ${q.place}
Problem: ${q.problem}
Goal: ${q.goal}
${q.idea ? `Extra ideas: ${q.idea}\n` : ''}
Rules:
1. Exactly ${LEVELS} levels. The story moves forward level by level toward the goal, and every level's action
   is a real, concrete action for ${sdg}.
2. Each level has 2 to 4 dialogue lines spoken by the main characters (a "Narrator" line is allowed), then one
   question with two options, A and B.
3. Exactly ONE option is correct. The wrong option must be clearly worse for ${sdg}, but still something a
   person might choose. Do not make both options good.
4. The hint is one or two sentences that help the player think again (explain the idea, do not just say "the
   answer is A").
5. The ending has 2 to 4 dialogue lines that show the goal reached.
6. "background" is 2 to 4 sentences: who the characters are, where they are, the problem and the goal.
7. Every "scene" (one per level, plus "intro_scene" and "ending_scene") is one English sentence describing a
   picture for that moment: the place, the people and what they are doing. Describe how the people look (age,
   hair, clothes) the same way every time instead of using their names. No words or signs in the picture.

JSON shape:
{"background": "...",
 "levels": [{"title": "Short level title, without the level number", "lines": [{"speaker": "Name", "text": "..."}],
             "question": "What should they do?", "options": {"A": "...", "B": "..."}, "answer": "A",
             "hint": "...", "scene": "..."}],
 "ending": [{"speaker": "Name", "text": "..."}],
 "intro_scene": "...", "ending_scene": "..."}`;
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
}

function draftFrom(d) {
  if (!d || !Array.isArray(d.levels) || d.levels.length < LEVELS) return null;
  const levels = d.levels.slice(0, LEVELS).map(level);
  const draft = { background: str(d.background, LIMITS.background), levels, ending: lines(d.ending),
    intro_scene: str(d.intro_scene, LIMITS.scene), ending_scene: str(d.ending_scene, LIMITS.scene) };
  const missing = problems({ ...normalize({}), title: 'x', ...draft });
  return missing.length ? null : draft;
}

// Job: { quest } in; one final event with the draft (background, levels, ending). One repair round when the reply
// is not a complete game.
export async function generate(body, emit, conn, signal) {
  const q = normalize(body?.quest);
  if (!q.title || !q.characters.length || !q.problem || !q.goal) throw { code: 'quiz_input' };
  emit({ type: 'phase', code: 'quiz_draft' });
  const status = (ev) => { if (ev.type === 'status') emit(ev); };
  const messages = draftMessages(q);
  let res = await llm.stream(messages, status, 0.8, conn, signal);
  let draft = draftFrom(lastJson(res.content));
  if (!draft) {
    emit({ type: 'phase', code: 'quiz_repair' });
    const again = [...messages, { role: 'assistant', content: res.content },
      { role: 'user', content: `That reply was not a complete game. Reply again with the full JSON object only: exactly ${LEVELS} levels, each with lines, question, options A and B, answer and hint, plus background and ending.` }];
    res = await llm.stream(again, status, 0.6, conn, signal);
    draft = draftFrom(lastJson(res.content));
  }
  if (!draft) throw { code: 'quiz_bad_reply' };
  emit({ type: 'final', draft: { ...draft, levels: shuffleSides(draft.levels) } });
}

// ---------- pictures ----------

const PIC_W = 960;
const PIC_H = 720;
const STYLE = 'colorful anime storybook illustration, cel shaded, warm friendly mood, detailed background';
const TAIL = 'no text, no letters, no words, no signs with writing';
const picPath = (id, slot) => `quiz/${id}/${slot}.jpg`;

export const picturePrompt = (q, slot) => `${STYLE}, ${sceneOf(q, slot)}, ${TAIL}`;

// slot -> address of the picture, for the slots that have one
export function pictures(id) {
  const out = {};
  for (const slot of PICTURES) {
    const path = picPath(id, slot);
    if (store.hasFile(path)) out[slot] = store.fileUrl(path);
  }
  return out;
}

// Job: { slots } in (all missing pictures when empty); one "picture" event per drawn picture, then the final
// event with every picture the quest has. The quest is read as saved, so the editor saves first.
export async function drawPictures(id, body, emit, conn, signal) {
  if (!conn.key) throw { code: 'no_key' };
  if (!conn.relay) throw { code: 'no_relay' };
  const q = await load(id);
  const asked = (Array.isArray(body?.slots) ? body.slots : []).filter((s) => PICTURES.includes(s));
  const slots = asked.length ? asked : PICTURES.filter((s) => !store.hasFile(picPath(id, s)));
  for (const [i, slot] of slots.entries()) {
    if (signal?.aborted) throw { code: 'cancelled' };
    emit({ type: 'picture_start', slot, n: i + 1, total: slots.length });
    const blob = await images.picture(picturePrompt(q, slot), PIC_W, PIC_H);
    if (!(await all())[id]) throw { code: 'quiz_missing' };
    await store.putFile(picPath(id, slot), blob);
    emit({ type: 'picture', slot, pictures: pictures(id) });
  }
  emit({ type: 'final', pictures: pictures(id) });
}

// ---------- storage ----------

async function all() { return (await store.kvGet(KV)) || {}; }

export async function list() {
  return Object.values(await all())
    .map((q) => ({ id: q.id, title: q.title, sdg: q.sdg, updated_at: q.updated_at, ready: !problems(normalize(q)).length }))
    .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
}

export async function load(id) {
  const q = (await all())[id];
  if (!q) throw { code: 'quiz_missing' };
  return { ...normalize(q), pictures: pictures(id) };
}

// id "new" makes a new quest; returns the saved quest
export async function save(id, raw) {
  const quests = await all();
  if (id !== 'new' && !quests[id]) throw { code: 'quiz_missing' };
  const now = store.nowIso();
  const qid = id === 'new' ? `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : id;
  const q = { ...normalize(raw), id: qid, created_at: quests[qid]?.created_at || now, updated_at: now };
  await store.kvPut(KV, { ...quests, [qid]: q });
  return q;
}

export async function remove(id) {
  const { [id]: gone, ...rest } = await all();
  if (!gone) throw { code: 'quiz_missing' };
  await store.kvPut(KV, rest);
  for (const slot of PICTURES) if (store.hasFile(picPath(id, slot))) await store.deleteFile(picPath(id, slot));
  return { ok: true };
}
