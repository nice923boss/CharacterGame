// Browser port of server/turn_service.py: world setup and one story turn, reporting through emit(event).
// A node is written only after the whole turn succeeded, so a cancelled or failed turn leaves the tree as it was.
import { DATA } from './data.js?v=35d64fef8e0b';
import * as store from './store.js?v=35d64fef8e0b';
import * as images from './images.js?v=35d64fef8e0b';
import * as llm from './llm.js?v=35d64fef8e0b';
import {
  Cast, LineStream, applyState, clip, gameLang, lastJson, mostlyAscii, repair, repairMessages, setupMessages, slug,
  turnMessages,
} from './story.js?v=35d64fef8e0b';

const { MAX_CHARACTERS, MAX_FREE_INPUT, LIMIT_SCALE, BATCH_MAX_SCENES, BATCH_MAX_NODES, NOVEL_MAX_CHAPTERS } = DATA.limits;
const { LANGS, NARRATOR, MAX_GAME_TITLE } = DATA.parser;

// Nodes in a full batch tree: the opening is turn 1 and every non-ending node has `options` children
export const treeSize = (options, turns) => Array.from({ length: turns }, (_, k) => options ** k).reduce((a, b) => a + b, 0);

function checkText(value, field, limit, required = true, params = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw { code: 'required', params: { field, ...params } };
  if ([...text].length > limit) throw { code: 'too_long', params: { field, limit, ...params } };
  return text;
}

export async function createGame(payload, emit, conn, signal) {
  const lang = LANGS.includes(payload.lang) ? payload.lang : 'zh';
  const x = LIMIT_SCALE[lang];
  const world = Object.fromEntries(['era', 'place', 'genre', 'tone', 'extra', 'goal'].map((k) =>
    [k, checkText((payload.world || {})[k], k, 200 * x, k === 'era' || k === 'place')]));
  const p = payload.protagonist || {};
  const protagonist = { name: checkText(p.name, 'hero_name', 12 * x), profile: checkText(p.profile, 'hero_profile', 200 * x, false) };
  const rawChars = payload.characters || [];
  if (!(rawChars.length >= 1 && rawChars.length <= MAX_CHARACTERS)) throw { code: 'char_count', params: { max: MAX_CHARACTERS } };
  const chars = rawChars.map((c, idx) => ({
    id: `c${idx + 1}`,
    ...Object.fromEntries([['name', 12], ['appearance', 300], ['personality', 200], ['speech', 200], ['relationship', 200]]
      .map(([k, limit]) => [k, checkText(c[k], `char_${k}`, limit * x, true, { i: idx + 1 })])),
  }));
  const names = [...chars.map((c) => c.name), protagonist.name];
  if (new Set(names).size !== names.length || names.some((n) => Object.values(NARRATOR).includes(n))) {
    throw { code: 'dup_names', params: { narrator: NARRATOR[lang] } };
  }
  let batch = null;
  if (payload.batch) {
    batch = { options: Number(payload.batch.options), turns: Number(payload.batch.turns) };
    if (!(Number.isInteger(batch.options) && Number.isInteger(batch.turns) && batch.options >= 2 && batch.options <= 4 &&
          batch.turns >= 3 && batch.turns <= 10) || treeSize(batch.options, batch.turns) > BATCH_MAX_NODES) {
      throw { code: 'batch_size', params: { max: BATCH_MAX_NODES } };
    }
    if (!world.goal) throw { code: 'batch_goal' };
  }
  let novel = null;
  if (payload.novel) {
    const rows = payload.novel.chapters;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > NOVEL_MAX_CHAPTERS ||
        !rows.every((r) => r && typeof r === 'object')) {
      throw { code: 'chapter_count', params: { max: NOVEL_MAX_CHAPTERS } };
    }
    novel = {
      title: checkText(payload.novel.title, 'novel_title', 60 * x, false),
      chapters: rows.map((r, idx) => ({ title: checkText(r.title, 'chapter_title', 20 * x, true, { i: idx + 1 }),
        summary: checkText(r.summary, 'chapter_summary', 200 * x, true, { i: idx + 1 }) })),
    };
  }

  emit({ type: 'phase', code: 'setup_art' });
  const res = await llm.stream(setupMessages(world, chars, lang), (ev) => { if (ev.type === 'status') emit(ev); }, 0.5, conn, signal);
  const d = lastJson(res.content) || {};
  const looks = {};
  for (const c of Array.isArray(d.characters) ? d.characters : []) {
    if (c && typeof c === 'object') looks[String(c.name ?? '').trim()] = String(c.appearance_en ?? '').trim();
  }
  const fs = d.first_scene && typeof d.first_scene === 'object' ? d.first_scene : {};
  const sid = slug(fs.id ?? '') || 'opening';
  if (!mostlyAscii(String(fs.image_prompt ?? '')) || !chars.every((c) => mostlyAscii(looks[c.name] || ''))) {
    console.warn('setup json unusable');
    throw { code: 'setup_unusable' };
  }
  const seed = 1 + Math.floor(Math.random() * (2 ** 31 - 1000));
  const cast = new Cast(chars, protagonist.name, lang);
  const game = {
    id: await store.newGameId(), created_at: store.nowIso(), seed, lang,
    title: cast.conv(clip(String(d.title || world.place).trim(), MAX_GAME_TITLE[lang])),
    style_en: String(d.style_en ?? '').trim().slice(0, 200),
    world, protagonist,
    characters: chars.map((c, idx) => ({ ...c, appearance_en: looks[c.name], seed: seed + 17 * (idx + 1) })),
    scenes: { [sid]: { name: cast.conv(String(fs.name || (lang === 'zh' ? '序章' : 'Prologue'))), image_prompt: String(fs.image_prompt).trim() } },
    first_scene: sid,
    setup_model: res.candidate.model,
    ...(batch ? { batch } : {}),
    ...(novel ? { novel } : {}),
  };
  await store.saveGame(game);
  images.ensureGame(game, sid);
  emit({ type: 'final', game });
  return game;
}

export function existingChild(tree, parent, text) {
  const key = text.replace(/\s+/g, '');
  for (const cid of parent.children || []) {
    const child = tree.nodes[cid];
    if (child && String(child.player_input.text ?? '').replace(/\s+/g, '') === key) return child;
  }
  return null;
}

const locks = new Map();   // gid -> promise chain, so two turns never write the same tree at once
const writing = new Map();   // turns in progress by gid, parent and input: { settled, batch }
const partials = new Map();   // whole lines of a turn that broke off, same key: { text, until }
const PARTIAL_KEEP_MS = 600 * 1000;   // how long they wait for the player to try again

// A turn of this story is being written (by the player or the batch): the story cannot be deleted now
export const turnBusy = (gid) => [...writing.keys()].some((k) => k.startsWith(`${gid}
`));
const wholeLines = (text) => text.slice(0, text.lastIndexOf('\n') + 1);

function takePartial(key) {
  const p = partials.get(key);
  partials.delete(key);
  return p && Date.now() < p.until ? p.text : '';
}

function keepPartial(key, text, cast) {
  const now = Date.now();
  for (const [k, p] of partials) if (p.until <= now) partials.delete(k);
  if (text && new LineStream(cast).feed(text).length) partials.set(key, { text, until: now + PARTIAL_KEEP_MS });
}

// batch=true: written ahead by the batch walker, so no autosave, no sprite requests, and a known child is
// returned as is instead of being replayed
export async function runTurn(gid, parentId, playerInput, emit, conn, signal, batch = false) {
  const key = `${gid}\n${parentId}\n${String(playerInput.text ?? '').replace(/\s+/g, '')}`;
  const busy = writing.get(key);
  if (!batch && busy) {
    // This branch is being written already (by the batch, or by an earlier request): wait for it and
    // replay it instead of writing a second copy
    emit({ type: 'phase', code: busy.batch ? 'batch_wait' : 'same_wait' });
    await Promise.race([busy.settled, new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject({ code: 'cancelled' }), { once: true });
    })]);
  }
  if (writing.has(key)) return writeTurn(gid, parentId, playerInput, emit, conn, signal, batch, key);
  const done = writeTurn(gid, parentId, playerInput, emit, conn, signal, batch, key);
  const entry = { settled: done.then(() => null, () => null), batch };
  writing.set(key, entry);
  try {
    return await done;
  } finally {
    if (writing.get(key) === entry) writing.delete(key);
  }
}

async function replay(gid, game, node, emit) {
  // Same answer at the same node: replay the stored turn, no LLM call, tree unchanged
  for (const ln of node.lines) emit({ type: 'line', line: ln });
  await store.setAutosave(gid, node.id, node.scene_id);
  images.request(['scene', gid, node.scene_id], images.P_SCENE);
  emit({ type: 'final', node, scenes: game.scenes, replayed: true });
  return node;
}

// A failed repair call must not throw away a turn whose dialogue is already on screen
async function tryComplete(msgs, conn, signal, failed, label) {
  try {
    return (await llm.complete(msgs, 0.3, conn, signal)).content;
  } catch (e) {
    if (!e?.code || e.code === 'cancelled' || signal?.aborted) throw e;
    failed.push(`${label} call failed (${e.code})`);
    return '';
  }
}

async function writeTurn(gid, parentId, playerInput, emit, conn, signal, batch, key) {
  const game = await store.loadGame(gid);
  const tree = await store.loadTree(gid);
  const { kind } = playerInput;
  if (parentId == null) {
    if (kind !== 'opening') throw { code: 'already_started' };
    if (tree.root !== null) {
      // Sent again after the opening was saved (or the batch wrote it): replay it
      const root = tree.nodes[tree.root];
      return batch ? root : replay(gid, game, root, emit);
    }
    playerInput = { kind: 'opening', text: '' };
  } else {
    if (!tree.nodes[parentId]) throw { code: 'node_not_found' };
    if (kind !== 'option' && kind !== 'free') throw { code: 'bad_input_kind' };
    playerInput = { kind, text: checkText(playerInput.text, 'action', MAX_FREE_INPUT * LIMIT_SCALE[gameLang(game)]) };
  }
  const path = store.pathTo(tree, parentId);
  const parent = path.length ? path[path.length - 1] : null;
  if (parent?.result.ending) throw { code: 'branch_ended' };
  if (parent) {
    const known = existingChild(tree, parent, playerInput.text);
    if (known && batch) return known;
    if (known) return replay(gid, game, known, emit);
  }
  let sceneId = parent ? parent.scene_id : game.first_scene;
  const scene = { id: sceneId, ...game.scenes[sceneId] };
  const lang = gameLang(game);
  const cast = new Cast(game.characters, game.protagonist.name, lang);
  const msgs = turnMessages(game, path, playerInput, scene);
  // The same turn broke off before: keep its whole lines and ask only for the rest
  const partial = batch ? '' : takePartial(key);
  let lineStream = new LineStream(cast);
  let raw = partial;     // text of the current attempt, the resumed part included
  let broken = '';       // whole lines of the last attempt that was reset

  const emitLines = (lines) => {
    for (const ln of lines) {
      if (ln.char_id && !batch) images.request(['sprite', gid, ln.char_id, ln.expr], images.P_SPEAKER);
      emit({ type: 'line', line: ln });
    }
  };
  const onEvent = (ev) => {
    if (ev.type === 'delta') {
      raw += ev.text;
      emitLines(lineStream.feed(ev.text));
    } else if (ev.type === 'reset') {
      broken = wholeLines(raw);
      raw = partial;
      lineStream = new LineStream(cast);
      emit({ ...ev, keep: lineStream.feed(partial).length });   // the resumed lines stay
    } else emit(ev);
  };

  if (partial) {
    emit({ type: 'phase', code: 'resume_partial' });
    emitLines(lineStream.feed(partial));
  }
  let res;
  try {
    res = await llm.stream(partial ? repairMessages(msgs, partial, lang, 'continue') : msgs, onEvent, 0.8, conn, signal);
  } catch (e) {
    if (!batch) {
      const mine = wholeLines(raw);
      keepPartial(key, mine.length >= broken.length ? mine : broken, cast);
    }
    throw e;
  }
  const content = partial + res.content;
  emitLines(lineStream.finish());
  const { lines } = lineStream;
  if (!lines.length) throw { code: 'no_lines' };

  let d = lastJson(content);
  const failed = [];
  if (d === null) {
    emit({ type: 'phase', code: 'repair_json' });
    d = lastJson(await tryComplete(repairMessages(msgs, content, lang), conn, signal, failed, 'repair'));
  }
  const current = { scene_id: sceneId, bgm_mood: parent ? parent.bgm_mood : 'calm', weather: parent ? (parent.weather ?? 'none') : 'none' };
  const plan = game.batch;
  const allowEnding = !!parent && !!game.world.goal;
  const opts = { allowEnding, nOptions: plan ? plan.options : null, allowNewScene: !plan || Object.keys(game.scenes).length < BATCH_MAX_SCENES };
  let [result, notes] = repair(d, cast, game.scenes, current, opts);
  if (plan && allowEnding && !result.ending && path.length + 1 >= plan.turns) {
    // The tree is only finite if the last turn ends; ask for the ending JSON on its own
    emit({ type: 'phase', code: 'repair_json' });
    const extra = lastJson(await tryComplete(repairMessages(msgs, content, lang, 'force_ending'), conn, signal, failed, 'ending'));
    [result, notes] = repair({ ...(d || {}), ...(extra || {}) }, cast, game.scenes, current, opts);
    notes = [...notes, result.ending ? 'ending forced' : 'forced ending missing'];
  }
  notes = [...notes, ...failed, ...(partial ? ['resumed after a break'] : [])];
  if (signal?.aborted) throw { code: 'cancelled' };

  const prev = locks.get(gid) || Promise.resolve();
  let release;
  locks.set(gid, new Promise((resolve) => { release = resolve; }));
  await prev;
  let node;
  let scenes;
  try {
    const fresh = await store.loadTree(gid);
    if (batch && parent) {
      // The player may have reached this branch live while it was being written
      const twin = existingChild(fresh, fresh.nodes[parentId], playerInput.text);
      if (twin) return twin;
    }
    if (!parent && fresh.root !== null) {
      // Someone else saved the opening meanwhile; a tree has one root, so show theirs
      const root = fresh.nodes[fresh.root];
      if (batch) return root;
      emit({ type: 'reset', keep: 0 });
      return await replay(gid, game, root, emit);
    }
    const g = await store.loadGame(gid);
    if (result.scene_change) {
      let sc = result.scene;
      if (!g.scenes[sc.id]) {
        if (plan && Object.keys(g.scenes).length >= BATCH_MAX_SCENES) {
          // Parallel batch turns can pass the budget check together; the last ones stay put
          sc = null;
          result = { ...result, scene_change: false, scene: null };
          notes = [...notes, 'new scene dropped (scene budget used up)'];
        } else {
          g.scenes[sc.id] = { name: sc.name, image_prompt: sc.image_prompt };
          await store.saveGame(g);
        }
      }
      if (sc) sceneId = sc.id;
    }
    scenes = g.scenes;
    const baseState = parent ? parent.state
      : { affection: Object.fromEntries(game.characters.map((c) => [c.name, 0])), flags: [], items: [] };
    const summary = [...(parent ? parent.summary : []), ...(result.summary_update ? [result.summary_update] : [])];
    node = await store.addNode(gid, {
      parent: parentId ?? null, scene_id: sceneId, player_input: playerInput, lines, result,
      state: applyState(baseState, result.state_changes), summary, bgm_mood: result.bgm_mood, weather: result.weather,
      model: res.candidate.model, repair_notes: notes,
    });
    if (!batch) await store.setAutosave(gid, node.id, node.scene_id);
  } finally {
    release();
  }
  images.request(['scene', gid, sceneId], batch ? images.P_EXPR : images.P_SCENE);
  emit({ type: 'final', node, scenes });
  return node;
}
