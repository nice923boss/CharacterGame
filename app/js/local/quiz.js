// SDGs English quest (browser build only): the AI writes a draft of a simple quest's levels and ending; quests of
// both modes live in IndexedDB. The quest shapes and their rules are in ../quest.js and ../quest_story.js.
import * as store from './store.js?v=6f163306a287';
import * as llm from './llm.js?v=6f163306a287';
import * as images from './images.js?v=6f163306a287';
import { lastJson } from './story.js?v=6f163306a287';
import { DRAFT_LEVELS, LIMITS, level, lines, normalize, problems, shuffleSides } from '../quest.js?v=6f163306a287';
import { normalizeQuest, questPictures, questProblems, questScene } from '../quest_story.js?v=6f163306a287';
import { storyFromSimple } from '../quest_pages.js?v=6f163306a287';

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

export function draftMessages(q, count = q.levels.length) {
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
1. Exactly ${count} level${count === 1 ? '' : 's'}. The story moves forward level by level toward the goal, and every level's action
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

function draftFrom(d, count) {
  if (!d || !Array.isArray(d.levels) || d.levels.length < count) return null;
  const levels = d.levels.slice(0, count).map(level);
  const draft = { background: str(d.background, LIMITS.background), levels, ending: lines(d.ending),
    intro_scene: str(d.intro_scene, LIMITS.scene), ending_scene: str(d.ending_scene, LIMITS.scene) };
  const missing = problems({ ...normalize({}), title: 'x', ...draft });
  return missing.length ? null : draft;
}

// Job: { quest, count } in (count: levels to write, 1 to DRAFT_LEVELS, the quest's own number when missing); one final
// event with the draft (background, levels, ending). One repair round when the reply is not a complete game.
export async function generate(body, emit, conn, signal) {
  const q = normalize(body?.quest);
  if (!q.title || !q.characters.length || !q.problem || !q.goal) throw { code: 'quiz_input' };
  const count = Math.min(DRAFT_LEVELS, Math.max(1, Math.round(Number(body?.count)) || q.levels.length));
  emit({ type: 'phase', code: 'quiz_draft' });
  const status = (ev) => { if (ev.type === 'status') emit(ev); };
  const messages = draftMessages(q, count);
  let res = await llm.stream(messages, status, 0.8, conn, signal);
  let draft = draftFrom(lastJson(res.content), count);
  if (!draft) {
    emit({ type: 'phase', code: 'quiz_repair' });
    const again = [...messages, { role: 'assistant', content: res.content },
      { role: 'user', content: `That reply was not a complete game. Reply again with the full JSON object only: exactly ${count} level${count === 1 ? '' : 's'}, each with lines, question, options A and B, answer and hint, plus background and ending.` }];
    res = await llm.stream(again, status, 0.6, conn, signal);
    draft = draftFrom(lastJson(res.content), count);
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

// NVIDIA's content filter refuses some first names (Alex, Sam) in any scene, on every seed (2026-11-02 probe), and a
// name tells the picture nothing, so the cast's names become "a person"
function withoutNames(text, characters) {
  return characters.reduce((s, c) => {
    const name = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return s.replace(new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, 'giu'), 'a person');
  }, text);
}

export const picturePrompt = (q, slot) => `${STYLE}, ${withoutNames(questScene(q, slot), q.characters)}, ${TAIL}`;

// slot -> address of the picture, for the quest's slots that have one
export function pictures(q) {
  const out = {};
  for (const slot of questPictures(q)) {
    const path = picPath(q.id, slot);
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
  const names = questPictures(q);
  const asked = (Array.isArray(body?.slots) ? body.slots : []).filter((s) => names.includes(s));
  const slots = asked.length ? asked : names.filter((s) => !store.hasFile(picPath(id, s)));
  for (const [i, slot] of slots.entries()) {
    if (signal?.aborted) throw { code: 'cancelled' };
    emit({ type: 'picture_start', slot, n: i + 1, total: slots.length });
    const blob = await images.picture(picturePrompt(q, slot), PIC_W, PIC_H);
    if (!(await all())[id]) throw { code: 'quiz_missing' };
    await store.putFile(picPath(id, slot), blob);
    emit({ type: 'picture', slot, pictures: pictures(q) });
  }
  emit({ type: 'final', pictures: pictures(q) });
}

// A picture the author chose on the computer (the editor has already cut it to size) takes the slot's place
export async function putPicture(id, slot, blob) {
  const q = await load(id);
  if (!questPictures(q).includes(slot) || !(blob instanceof Blob) || !/^image\/(jpeg|png|webp)$/.test(blob.type)) throw { code: 'quiz_pic_bad' };
  await store.putFile(picPath(id, slot), blob);
  return { pictures: pictures(q) };
}

// ---------- storage ----------

async function all() { return (await store.kvGet(KV)) || {}; }

export async function list() {
  return Object.values(await all())
    .map((raw) => normalizeQuest(raw))
    .map((q) => ({ id: q.id, mode: q.mode, title: q.title, sdg: q.sdg, updated_at: q.updated_at, ready: !questProblems(q).length }))
    .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)));
}

export async function load(id) {
  const q = (await all())[id];
  if (!q) throw { code: 'quiz_missing' };
  const quest = normalizeQuest(q);
  return { ...quest, pictures: pictures(quest) };
}

// The quest's pictures that no longer belong to it (its level, scene or item was deleted) are deleted
async function dropOrphans(q) {
  const keep = new Set(questPictures(q).map((slot) => picPath(q.id, slot)));
  const prefix = `quiz/${q.id}/`;
  for (const path of store.filePaths()) if (path.startsWith(prefix) && !keep.has(path)) await store.deleteFile(path);
}

// id "new" makes a new quest; returns the saved quest. A quest keeps its mode once saved.
export async function save(id, raw) {
  const quests = await all();
  if (id !== 'new' && !quests[id]) throw { code: 'quiz_missing' };
  const now = store.nowIso();
  const qid = id === 'new' ? `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` : id;
  const mode = quests[qid] ? normalizeQuest(quests[qid]).mode : raw?.mode;
  const q = { ...normalizeQuest({ ...raw, mode }), id: qid, created_at: quests[qid]?.created_at || now, updated_at: now };
  await store.kvPut(KV, { ...quests, [qid]: q });
  await dropOrphans(q);
  return q;
}

// A simple quest copied as a new story quest, with its pictures; the simple quest stays as it was
export async function copyAsStory(id) {
  const q = await load(id);
  if (q.mode !== 'simple') throw { code: 'quiz_mode' };
  const { quest, pictures: names } = storyFromSimple(q);
  const copy = await save('new', quest);
  for (const [from, to] of names) {
    const blob = await store.fileBlob(picPath(id, from));
    if (blob) await store.putFile(picPath(copy.id, to), blob);
  }
  return { ...copy, pictures: pictures(copy) };
}

// ---------- quest file (.sdgquest.json) ----------

const FILE_KIND = 'sdg-quest';
const FILE_VERSION = 2;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  // Chunks keep String.fromCharCode under the argument limit
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
}

// The quest with its pictures inside, so one file carries the whole game to another browser
export async function exportFile(id) {
  const { id: _, pictures: __, ...quest } = await load(id);
  const pics = {};
  for (const slot of questPictures(quest)) {
    const blob = await store.fileBlob(picPath(id, slot));
    if (blob) pics[slot] = await dataUrl(blob);
  }
  return { kind: FILE_KIND, version: FILE_VERSION, ...quest, pictures: pics };
}

// A quest file (version 1 or 2) becomes a new quest; version 1 files are simple quests with no mode, and their
// levels get the ids 1 to n, so pictures l1 to l5 stay with their levels. Pictures that are not a JPEG, PNG or WebP
// data URL are left out.
export async function importFile(raw) {
  if (raw?.kind !== FILE_KIND) throw { code: 'quiz_file_bad' };
  if (Number(raw.version) > FILE_VERSION) throw { code: 'quiz_file_new' };
  const q = await save('new', raw);
  let count = 0;
  for (const slot of questPictures(q)) {
    const m = DATA_URL.exec(typeof raw.pictures?.[slot] === 'string' ? raw.pictures[slot] : '');
    if (!m) continue;
    const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
    await store.putFile(picPath(q.id, slot), new Blob([bytes], { type: m[1] }));
    count += 1;
  }
  return { ...q, pictures: pictures(q), imported_pictures: count };
}

export async function remove(id) {
  const { [id]: gone, ...rest } = await all();
  if (!gone) throw { code: 'quiz_missing' };
  await store.kvPut(KV, rest);
  for (const path of store.filePaths()) if (path.startsWith(`quiz/${id}/`)) await store.deleteFile(path);
  return { ok: true };
}
