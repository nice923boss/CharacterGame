// Browser port of server/turn_parser.py and server/prompts.py. The prompt text and constants come from
// data.js, which tools/build_pages.py exports from the Python modules, so both versions send the same prompts.
import { DATA } from './data.js';

const P = DATA.parser;
const PR = DATA.prompts;
const EXPRESSIONS = P.EXPRESSIONS;

const LINE_RE = new RegExp(String.raw`^@\s*([^|:：]+?)\s*(?:\|\s*([A-Za-z]*)\s*[:：]|[:：]\s*(?:(` +
  EXPRESSIONS.join('|') + String.raw`)\s*[:：])?)\s*(.*)$`, 'i');
const STAGE_RE = /^\*{1,2}([^*]+?)\*{1,2}\s*(?=\S)/;
const EMPH_RE = /\*{1,2}([^*]+?)\*{1,2}/g;

// Simplified -> Taiwan traditional (opencc s2twp on the server). Without the CDN library text stays as written.
let convert = (s) => s;
export async function loadOpenCC() {
  try {
    const OpenCC = await import('https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/esm/cn2t.js');
    convert = OpenCC.Converter({ from: 'cn', to: 'twp' });
    return true;
  } catch (e) {
    console.warn('opencc-js unavailable, Chinese text is not converted to traditional', e);
    return false;
  }
}

export const gameLang = (game) => (P.LANGS.includes(game.lang) ? game.lang : 'zh');

export function toTrad(text, protect = []) {
  const slots = [];
  protect.filter(Boolean).forEach((name, i) => {
    const key = `\u0000${i}\u0000`;
    if (text.includes(name)) { slots.push([key, name]); text = text.split(name).join(key); }
  });
  text = convert(text);
  for (const [key, name] of slots) text = text.split(key).join(name);
  return text;
}

// Python str.format with {name} fields and {{ }} escapes
export const pyFormat = (tpl, params = {}) =>
  tpl.replace(/\{\{|\}\}|\{(\w+)\}/g, (m, k) => (m === '{{' ? '{' : m === '}}' ? '}' : String(params[k])));

// json.dumps(obj, ensure_ascii=False): ", " and ": " separators
export function pyDumps(v) {
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(', ')}}`;
  return JSON.stringify(v ?? null);
}

export class Cast {
  constructor(characters, protagonistName, lang = 'zh') {
    this.chars = Object.fromEntries(characters.map((c) => [c.name, c.id]));
    this.protagonist = protagonistName;
    this.names = [...Object.keys(this.chars), protagonistName];
    this.lang = lang;
    this.narrator = P.NARRATOR[lang];
  }

  conv(text) { return this.lang === 'zh' ? toTrad(text, this.names) : text; }

  partial(name, full) {
    if (this.lang === 'en') {
      return full.toLowerCase().split(/\s+/).includes(name.toLowerCase()) || name.toLowerCase().includes(full.toLowerCase());
    }
    return name.length >= 2 && (full.includes(name) || name.includes(full));
  }

  resolve(raw) {
    const name = raw.trim().replace(/^[「」"'*]+|[「」"'*]+$/g, '');
    if (Object.hasOwn(this.chars, name)) return ['character', name, this.chars[name]];
    for (const [full, cid] of Object.entries(this.chars)) if (this.partial(name, full)) return ['character', full, cid];
    if (P.PROTAGONIST_ALIASES[this.lang].includes(name.toLowerCase()) || name === this.protagonist) {
      return ['protagonist', this.protagonist, null];
    }
    return ['narration', this.narrator, null];
  }
}

export function parseLine(row, cast) {
  row = row.trim();
  if (!row || row.startsWith('```')) return null;
  const m = LINE_RE.exec(row);
  let who; let expr; let text;
  if (m) {
    [, who, , , text] = m;
    expr = (m[2] || m[3] || 'calm').toLowerCase();
  } else {
    [who, expr, text] = [cast.narrator, 'calm', row];
  }
  const [kind, name, cid] = cast.resolve(who);
  text = cast.conv(text.trim());
  if (kind !== 'narration') text = text.replace(STAGE_RE, cast.lang === 'zh' ? '（$1）' : '($1) ');
  text = text.replace(EMPH_RE, '$1');
  if (!text) return null;
  if (kind === 'character' && !EXPRESSIONS.includes(expr)) expr = 'calm';
  return { kind, speaker: name, char_id: cid, expr: kind === 'character' ? expr : 'calm', text };
}

export class LineStream {
  constructor(cast) { this.cast = cast; this.buf = ''; this.inJson = false; this.lines = []; }

  feed(text) {
    this.buf += text;
    const out = [];
    let cut;
    while (!this.inJson && (cut = this.buf.indexOf('\n')) >= 0) {
      const row = this.buf.slice(0, cut);
      this.buf = this.buf.slice(cut + 1);
      out.push(...this.row(row));
    }
    return out;
  }

  finish() {
    const out = this.inJson ? [] : this.row(this.buf);
    this.buf = '';
    return out;
  }

  row(row) {
    const s = row.trim();
    if (s.startsWith('```') || s.startsWith('{')) { this.inJson = true; return []; }
    const line = parseLine(row, this.cast);
    if (!line) return [];
    this.lines.push(line);
    return [line];
  }
}

export function lastJson(text) {
  const candidates = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]).reverse();
  if (text.includes('{')) candidates.push(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  for (let c of candidates) {
    c = c.replace(/\/\/[^\n"]*$/gm, '').replace(/,\s*([}\]])/g, '$1');
    try {
      const d = JSON.parse(c);
      if (d && typeof d === 'object' && !Array.isArray(d)) return d;
    } catch { /* try the next candidate */ }
  }
  return null;
}

export const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export function clip(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, limit);
  if (text[limit] !== ' ' && cut.includes(' ')) cut = cut.slice(0, cut.lastIndexOf(' '));
  return cut.replace(/[ ,:;-]+$/, '');
}

export function mostlyAscii(text) {
  if (!text) return false;
  let n = 0;
  for (const ch of text) if (ch.charCodeAt(0) < 128) n += 1;
  return n / [...text].length > 0.9;
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);

function toInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'boolean') return Number(v);
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

function ending(v, cast) {
  const labels = P.ENDING_TYPES[cast.lang];
  if (!v || typeof v !== 'object' || !Object.hasOwn(labels, v.type)) return null;
  const title = clip(cast.conv(String(v.title || '').trim()).replace(EMPH_RE, '$1'), P.MAX_ENDING_TITLE[cast.lang]);
  return { type: v.type, title: title || labels[v.type] };
}

// Same checks and fixes as turn_parser.repair; returns [result, notes]
export function repair(d, cast, knownScenes, current, { allowEnding = false, nOptions = null, allowNewScene = true } = {}) {
  const notes = [];
  if (!d || typeof d !== 'object' || Array.isArray(d)) { notes.push('no json'); d = {}; }
  const conv = (s) => cast.conv(s);
  const { lang } = cast;

  let sceneChange = [true, 'true', 'True', 1].includes(d.scene_change);
  const sc = d.scene && typeof d.scene === 'object' ? d.scene : {};
  let scene = null;
  if (sceneChange) {
    let sid = slug(sc.id ?? '');
    const name = conv(String(sc.name ?? '').trim());
    const prompt = String(sc.image_prompt ?? '').trim();
    const byName = Object.keys(knownScenes).find((k) => name && knownScenes[k].name === name);
    if (Object.hasOwn(knownScenes, sid) || byName) {
      sid = Object.hasOwn(knownScenes, sid) ? sid : byName;
      scene = { id: sid, ...knownScenes[sid] };
    } else if (!allowNewScene) {
      notes.push(`new scene '${sid}' dropped (scene budget used up)`);
    } else if (sid && mostlyAscii(prompt)) {
      scene = { id: sid, name: name || sid, image_prompt: prompt };
    } else {
      notes.push(`scene change dropped (id='${sid}', prompt ascii=${mostlyAscii(prompt)})`);
    }
    if (scene && scene.id === current.scene_id) scene = null;
  }
  if (scene === null) sceneChange = false;

  let mood = d.bgm_mood;
  if (!P.MOODS.includes(mood)) {
    if (mood != null) notes.push(`bgm_mood ${JSON.stringify(mood)}`);
    mood = current.bgm_mood || 'calm';
  }
  let { weather } = d;
  if (!P.WEATHERS.includes(weather)) weather = sceneChange ? 'none' : (current.weather || 'none');

  const end = allowEnding ? ending(d.ending, cast) : null;
  let opts = [];
  const limit = P.MAX_OPTION_CHARS[lang];
  for (let o of end ? [] : strList(d.options)) {
    o = conv(o.replace(/^\s*(\d+[.、)]|[-*•])\s*/, '')).replace(EMPH_RE, '$1');
    if (o.length > limit) o = `${o.slice(0, limit - 1)}…`;
    if (!opts.includes(o)) opts.push(o);
  }
  const [lo, hi] = nOptions ? [nOptions, nOptions] : [3, 4];
  if (!end && !(opts.length >= lo && opts.length <= hi)) notes.push(`options count ${opts.length}`);
  opts = opts.slice(0, hi);
  for (const f of end ? [] : P.FALLBACK_OPTIONS[lang]) {
    if (opts.length >= lo) break;
    if (!opts.includes(f)) opts.push(f);
  }

  const st = d.state_changes && typeof d.state_changes === 'object' ? d.state_changes : {};
  const aff = {};
  if (st.affection && typeof st.affection === 'object' && !Array.isArray(st.affection)) {
    for (const [k, v] of Object.entries(st.affection)) {
      const [kind, name] = cast.resolve(String(k));
      const raw = toInt(v);
      if (raw === null) continue;
      const n = Math.max(-3, Math.min(3, raw));
      if (kind === 'character' && n) aff[name] = n;
    }
  }
  const changes = {
    affection: aff, flags_add: strList(st.flags_add).map(conv), items_add: strList(st.items_add).map(conv),
    items_remove: strList(st.items_remove).map(conv),
  };
  const summary = conv(String(d.summary_update || '').trim());
  if (!summary) notes.push('no summary_update');
  return [{ scene_change: sceneChange, scene, bgm_mood: mood, weather, options: opts, state_changes: changes,
    summary_update: summary, ending: end }, notes];
}

export function applyState(state, changes) {
  const aff = { ...(state.affection || {}) };
  for (const [name, n] of Object.entries(changes.affection)) aff[name] = (aff[name] || 0) + n;
  const flags = [...new Set([...(state.flags || []), ...changes.flags_add])];
  const items = [...new Set([...(state.items || []).filter((i) => !changes.items_remove.includes(i)), ...changes.items_add])];
  return { affection: aff, flags, items };
}

// ---------- prompts ----------

const T = (lang) => PR.TEXT[lang];

function worldText(world, lang) {
  return ['era', 'place', 'genre', 'tone', 'extra', 'goal'].filter((k) => world[k])
    .map((k) => `- ${T(lang)[k]}${T(lang).colon}${world[k]}`).join('\n');
}

function charactersText(game, lang) {
  const t = T(lang);
  return game.characters.map((c) => `### ${c.name}\n` + [['appearance', 'look'], ['personality', 'personality'],
    ['speech', 'speech'], ['relationship', 'relationship']].map(([k, label]) => `- ${t[label]}${t.colon}${c[k]}`).join('\n'))
    .join('\n');
}

const protagonistText = (game, lang) =>
  pyFormat(T(lang).hero, { name: game.protagonist.name, profile: game.protagonist.profile || '' });

function turnSystem(game) {
  const lang = gameLang(game);
  const t = T(lang);
  const names = game.characters.map((c) => c.name);
  const n = game.batch?.options;
  let endingRule = (game.world.goal ? PR.ENDING_RULE : PR.NO_ENDING_RULE)[lang];
  if (n) endingRule = endingRule.split(t.opt_rule).join(pyFormat(t.opt_rule_n, { n }));
  return pyFormat(PR.TURN_SYSTEM[lang], {
    speakers: [P.NARRATOR[lang], ...names, game.protagonist.name].join(t.sep),
    expressions: EXPRESSIONS.join(t.sep), moods: P.MOODS.join('|'), weathers: P.WEATHERS.join('|'),
    protagonist: game.protagonist.name, affection: names.map((x) => `"${x}": 0`).join(', '),
    opt_count: n ? pyFormat(t.opt_n, { n }) : t.opt_any, ending_rule: endingRule,
  });
}

function batchTurnText(game, turn) {
  const t = T(gameLang(game));
  const last = game.batch.turns;
  const max = DATA.limits.BATCH_MAX_SCENES;
  const rows = [pyFormat(t.turn_k, { k: turn, d: last })];
  if (turn >= last) rows.push(t.turn_last);
  else if (turn === last - 1) rows.push(t.turn_near);
  const n = Object.keys(game.scenes).length;
  rows.push(n >= max ? t.scene_full : pyFormat(t.scene_budget, { max, n }));
  return `${t.h_turn}\n${rows.join('\n')}`;
}

function nodeTranscript(node, protagonist, lang) {
  const rows = [];
  const pi = node.player_input || {};
  if (pi.kind === 'option' || pi.kind === 'free') rows.push(pyFormat(T(lang).action, { name: protagonist, text: pi.text }));
  for (const ln of node.lines || []) rows.push(`@${ln.speaker}: ${ln.text}`);
  return rows;
}

export function turnMessages(game, path, playerInput, scene) {
  const lang = gameLang(game);
  const t = T(lang);
  const protagonist = game.protagonist.name;
  const parent = path.length ? path[path.length - 1] : null;
  const state = parent ? parent.state : { affection: {}, flags: [], items: [] };
  const summary = parent ? parent.summary : [];
  const known = Object.entries(game.scenes).map(([sid, s]) => `- ${sid}${t.colon}${s.name}`).join('\n') || t.none;
  const recent = path.slice(-PR.RECENT_NODES).flatMap((n) => nodeTranscript(n, protagonist, lang));
  const parts = [
    `${t.h_world}\n${worldText(game.world, lang)}\n${protagonistText(game, lang)}`,
    `${t.h_chars}\n${charactersText(game, lang)}`,
    `${t.h_known}\n${known}`,
    `${t.h_scene}\n${scene.id}${t.colon}${scene.name}`,
    `${t.h_state}\n${pyDumps(state)}`,
  ];
  if (summary.length) {
    parts.push(`${t.h_summary}\n` + summary.slice(-PR.SUMMARY_ITEMS).map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }
  if (recent.length) parts.push(`${t.h_recent}\n${recent.join('\n')}`);
  if (game.batch) parts.push(batchTurnText(game, path.length + 1));
  parts.push(playerInput.kind === 'opening' ? pyFormat(t.opening, { name: protagonist })
    : pyFormat(t.player, { text: playerInput.text }));
  parts.push(t.go);
  return [{ role: 'system', content: turnSystem(game) }, { role: 'user', content: parts.join('\n\n') }];
}

export function setupMessages(world, characters, lang) {
  const chars = characters.map((c) => `- ${c.name}${T(lang).colon}${c.appearance}`).join('\n');
  return [{ role: 'system', content: PR.SETUP_SYSTEM[lang] },
    { role: 'user', content: pyFormat(PR.SETUP_USER[lang], { world: worldText(world, lang), characters: chars }) }];
}

export const repairMessages = (turnMsgs, replyText, lang, key = 'repair') =>
  [...turnMsgs, { role: 'assistant', content: replyText }, { role: 'user', content: T(lang)[key] }];
