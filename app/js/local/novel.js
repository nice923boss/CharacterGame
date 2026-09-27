// Browser port of server/novel_service.py: turn a .txt novel into a new-game draft (world, protagonist, characters,
// chapters) for the setup form. Parts of the book become notes (NOVEL_PARALLEL calls at a time), then one call adapts
// all the notes into the draft. Nothing is saved: the player edits the draft and starts the game.
import { DATA } from './data.js';
import * as llm from './llm.js';
import { clip, lastJson, novelMessages, novelNotesMessages, toTrad } from './story.js';

const { MAX_CHARACTERS, LIMIT_SCALE, NOVEL_MAX_CHAPTERS, NOVEL_PART_CHARS, NOVEL_MAX_PARTS, NOVEL_PARALLEL,
  NOVEL_MIN_CHAPTERS } = DATA.limits;
const { LANGS, NARRATOR } = DATA.parser;
const WORLD_KEYS = ['era', 'place', 'genre', 'tone', 'extra', 'goal'];
const CHAR_LIMITS = [['appearance', 300], ['personality', 200], ['speech', 200], ['relationship', 200]];

// Cut at a line break in the last 40% of each part, so a part rarely ends mid-sentence
export function splitParts(text, size = NOVEL_PART_CHARS) {
  const parts = [];
  while (text.length > size) {
    const at = text.lastIndexOf('\n', size - 1);
    const cut = at >= Math.floor(size * 0.6) ? at : size;
    parts.push(text.slice(0, cut).trim());
    text = text.slice(cut);
  }
  if (text.trim()) parts.push(text.trim());
  return parts.filter(Boolean);
}

const cleanText = (text) => String(text ?? '').replace(/\r\n?/g, '\n').replace(/^﻿/, '').replace(/\n{3,}/g, '\n\n').trim();

const titlePart = (title, lang) => (!title ? '' : lang === 'zh' ? `《${title}》` : ` "${title}"`);

// Fit the model's draft into the setup form limits; names are unique and never the narrator's
function cleanDraft(d, lang, title) {
  const x = LIMIT_SCALE[lang];
  const s = (v, limit) => {
    const text = String(v ?? '').trim();
    return clip(lang === 'zh' ? toTrad(text) : text, limit * x);
  };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const rows = (v) => (Array.isArray(v) ? v.map(obj) : []);
  const w = obj(d.world);
  const p = obj(d.protagonist);
  const world = Object.fromEntries(WORLD_KEYS.map((k) => [k, s(w[k], 200)]));
  const protagonist = { name: s(p.name, 12), profile: s(p.profile, 200) };
  const taken = new Set([protagonist.name, ...Object.values(NARRATOR)]);
  const characters = [];
  for (const c of rows(d.characters)) {
    const name = s(c.name, 12);
    if (name && !taken.has(name) && characters.length < MAX_CHARACTERS) {
      taken.add(name);
      characters.push({ name, ...Object.fromEntries(CHAR_LIMITS.map(([k, limit]) => [k, s(c[k], limit)])) });
    }
  }
  const chapters = rows(d.chapters).map((c) => ({ title: s(c.title, 20), summary: s(c.summary, 200) }))
    .filter((c) => c.title && c.summary).slice(0, NOVEL_MAX_CHAPTERS);
  if (!(world.era && world.place && protagonist.name && characters.length && chapters.length)) throw { code: 'novel_unusable' };
  return { world, protagonist, characters, novel: { title: clip(title, 60 * x), chapters } };
}

export async function analyzeNovel(payload, emit, conn, signal) {
  const lang = LANGS.includes(payload.lang) ? payload.lang : 'zh';
  const text = cleanText(payload.text);
  const title = String(payload.title ?? '').trim().replace(/^[《"']+|[》"']+$/g, '').slice(0, 60);
  if (!text) throw { code: 'novel_empty' };
  const parts = splitParts(text);
  if (parts.length > NOVEL_MAX_PARTS) {
    throw { code: 'novel_too_long', params: { limit: NOVEL_PART_CHARS * NOVEL_MAX_PARTS, length: text.length } };
  }
  const statusOnly = (ev) => { if (ev.type === 'status') emit(ev); };
  const notes = new Array(parts.length);
  let next = 0;
  let done = 0;
  emit({ type: 'progress', done: 0, total: parts.length });
  const worker = async () => {
    while (next < parts.length) {
      const i = next;
      next += 1;
      const res = await llm.stream(novelNotesMessages(titlePart(title, lang), i + 1, parts.length, parts[i], lang),
        statusOnly, 0.3, conn, signal);
      notes[i] = res.content.trim();
      done += 1;
      emit({ type: 'progress', done, total: parts.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(NOVEL_PARALLEL, parts.length) }, worker));
  emit({ type: 'phase', code: 'novel_outline' });
  const res = await llm.stream(novelMessages(titlePart(title, lang), notes, lang, MAX_CHARACTERS, NOVEL_MIN_CHAPTERS,
    NOVEL_MAX_CHAPTERS), statusOnly, 0.4, conn, signal);
  const d = lastJson(res.content);
  if (!d || typeof d !== 'object') {
    console.warn('novel draft unusable');
    throw { code: 'novel_unusable' };
  }
  const draft = cleanDraft(d, lang, title);
  console.info(`novel analysed: ${text.length} chars, ${parts.length} parts, ${draft.characters.length} characters, ` +
    `${draft.novel.chapters.length} chapters`);
  emit({ type: 'final', draft });
  return draft;
}
