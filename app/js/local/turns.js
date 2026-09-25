// Browser port of server/turn_service.py: world setup and one story turn, reporting through emit(event).
// A node is written only after the whole turn succeeded, so a cancelled or failed turn leaves the tree as it was.
import { DATA } from './data.js';
import * as store from './store.js';
import * as images from './images.js';
import * as llm from './llm.js';
import {
  Cast, LineStream, applyState, clip, gameLang, lastJson, mostlyAscii, repair, repairMessages, setupMessages, slug,
  turnMessages,
} from './story.js';

const { MAX_CHARACTERS, MAX_FREE_INPUT, LIMIT_SCALE, BATCH_MAX_SCENES } = DATA.limits;
const { LANGS, NARRATOR, MAX_GAME_TITLE } = DATA.parser;

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
  };
  await store.saveGame(game);
  images.ensureGame(game, sid);
  emit({ type: 'final', game });
  return game;
}

function existingChild(tree, parent, text) {
  const key = text.replace(/\s+/g, '');
  for (const cid of parent.children || []) {
    const child = tree.nodes[cid];
    if (child && String(child.player_input.text ?? '').replace(/\s+/g, '') === key) return child;
  }
  return null;
}

const locks = new Map();   // gid -> promise chain, so two turns never write the same tree at once

export async function runTurn(gid, parentId, playerInput, emit, conn, signal) {
  const game = await store.loadGame(gid);
  const tree = await store.loadTree(gid);
  const { kind } = playerInput;
  if (parentId == null) {
    if (tree.root !== null || kind !== 'opening') throw { code: 'already_started' };
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
    if (known) {
      // Same answer at the same node: replay the stored turn, no LLM call, tree unchanged
      for (const ln of known.lines) emit({ type: 'line', line: ln });
      await store.setAutosave(gid, known.id, known.scene_id);
      images.request(['scene', gid, known.scene_id], images.P_SCENE);
      emit({ type: 'final', node: known, scenes: game.scenes, replayed: true });
      return known;
    }
  }
  let sceneId = parent ? parent.scene_id : game.first_scene;
  const scene = { id: sceneId, ...game.scenes[sceneId] };
  const lang = gameLang(game);
  const cast = new Cast(game.characters, game.protagonist.name, lang);
  const msgs = turnMessages(game, path, playerInput, scene);
  let lineStream = new LineStream(cast);

  const emitLines = (lines) => {
    for (const ln of lines) {
      if (ln.char_id) images.request(['sprite', gid, ln.char_id, ln.expr], images.P_SPEAKER);
      emit({ type: 'line', line: ln });
    }
  };
  const onEvent = (ev) => {
    if (ev.type === 'delta') emitLines(lineStream.feed(ev.text));
    else if (ev.type === 'reset') { lineStream = new LineStream(cast); emit(ev); } else emit(ev);
  };

  const res = await llm.stream(msgs, onEvent, 0.8, conn, signal);
  emitLines(lineStream.finish());
  const { lines } = lineStream;
  if (!lines.length) throw { code: 'no_lines' };

  let d = lastJson(res.content);
  if (d === null) {
    emit({ type: 'phase', code: 'repair_json' });
    const fix = await llm.complete(repairMessages(msgs, res.content, lang), 0.3, conn, signal);
    d = lastJson(fix.content);
  }
  const current = { scene_id: sceneId, bgm_mood: parent ? parent.bgm_mood : 'calm', weather: parent ? (parent.weather ?? 'none') : 'none' };
  const plan = game.batch;
  const allowEnding = !!parent && !!game.world.goal;
  const opts = { allowEnding, nOptions: plan ? plan.options : null, allowNewScene: !plan || Object.keys(game.scenes).length < BATCH_MAX_SCENES };
  let [result, notes] = repair(d, cast, game.scenes, current, opts);
  if (plan && allowEnding && !result.ending && path.length + 1 >= plan.turns) {
    // The tree is only finite if the last turn ends; ask for the ending JSON on its own
    emit({ type: 'phase', code: 'repair_json' });
    const fix = await llm.complete(repairMessages(msgs, res.content, lang, 'force_ending'), 0.3, conn, signal);
    [result, notes] = repair({ ...(d || {}), ...(lastJson(fix.content) || {}) }, cast, game.scenes, current, opts);
    notes = [...notes, result.ending ? 'ending forced' : 'forced ending missing'];
  }
  if (signal?.aborted) throw { code: 'cancelled' };

  const prev = locks.get(gid) || Promise.resolve();
  let release;
  locks.set(gid, new Promise((resolve) => { release = resolve; }));
  await prev;
  let node;
  let scenes;
  try {
    const g = await store.loadGame(gid);
    if (result.scene_change) {
      const sc = result.scene;
      if (!g.scenes[sc.id]) {
        g.scenes[sc.id] = { name: sc.name, image_prompt: sc.image_prompt };
        await store.saveGame(g);
      }
      sceneId = sc.id;
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
    await store.setAutosave(gid, node.id, node.scene_id);
  } finally {
    release();
  }
  images.request(['scene', gid, sceneId], images.P_SCENE);
  emit({ type: 'final', node, scenes });
  return node;
}
