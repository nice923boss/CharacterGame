// Browser port of server/asset_service.py + cutout.py for NVIDIA FLUX.2 only: one sequential queue with the
// same priorities, scenes and sprites drawn through the player's relay, sprites cut out with the chroma key.
// Skipped against the server: ComfyUI, rembg, the iso residue pass and the .raw intermediates.
import { DATA } from './data.js';
import * as store from './store.js';

const A = DATA.art;
const EXPRESSIONS = DATA.parser.EXPRESSIONS;
export const P_SCENE = 0; export const P_SPEAKER = 1; export const P_CALM = 2; export const P_EXPR = 3;
const WEB_ONLY_NVIDIA = '此角色立繪不是由輝達產生，網頁版無法補表情';

const jobs = new Map();     // key string -> { key, priority, seq }
const errors = new Map();   // key string -> message
let running = null;
let seq = 0;
let wake = null;
let started = false;
let active = null;
let conn = () => ({ key: '', relay: '' });

const ks = (key) => key.join('|');

export function init(getConn) {
  conn = getConn;
  if (!started) { started = true; loop(); }
}

export const setActive = (gid) => { active = gid; };

function pathOf(key) {
  return key[0] === 'scene' ? store.scenePath(key[1], key[2]) : store.spritePath(key[1], key[2], key[3]);
}

export function request(key, priority) {
  const k = ks(key);
  if (store.hasFile(pathOf(key)) || k === running) return;
  errors.delete(k);
  const job = jobs.get(k);
  if (job) job.priority = Math.min(job.priority, priority);
  else jobs.set(k, { key, priority, seq: ++seq });
  if (wake) { wake(); wake = null; }
}

export const failed = (key) => errors.has(ks(key));

export function forget(gid) {
  for (const [k, j] of jobs) if (j.key[1] === gid) jobs.delete(k);
  for (const k of [...errors.keys()]) if (k.split('|')[1] === gid) errors.delete(k);
}

const order = (j) => [j.key[1] !== active ? 1 : 0, j.priority, j.seq];
const less = (a, b) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

export function ensureGame(game, sceneId = null, retry = true) {
  const gid = game.id;
  const wanted = sceneId ? [[['scene', gid, sceneId], P_SCENE]] : [];
  for (const c of game.characters) wanted.push([['sprite', gid, c.id, 'calm'], P_CALM]);
  for (const c of game.characters) for (const e of EXPRESSIONS.slice(1)) wanted.push([['sprite', gid, c.id, e], P_EXPR]);
  for (const [key, p] of wanted) if (retry || !errors.has(ks(key))) request(key, p);
}

// Same shape as the server's status, plus the url to show (blob or bundled demo file)
export function status(game) {
  const gid = game.id;
  const one = (key) => {
    const k = ks(key);
    const path = pathOf(key);
    if (store.hasFile(path)) return { state: 'done', v: store.fileVersion(path), url: store.fileUrl(path) };
    if (k === running) return { state: 'running' };
    if (errors.has(k)) return { state: 'error', error: errors.get(k) };
    if (jobs.has(k)) {
      const mine = order(jobs.get(k));
      const ahead = [...jobs.values()].filter((j) => less(order(j), mine)).length;
      return { state: 'queued', ahead: ahead + (running ? 1 : 0) };
    }
    return { state: 'missing' };
  };
  return {
    scenes: Object.fromEntries(Object.keys(game.scenes).map((sid) => [sid, one(['scene', gid, sid])])),
    sprites: Object.fromEntries(game.characters.map((c) =>
      [c.id, Object.fromEntries(EXPRESSIONS.map((e) => [e, one(['sprite', gid, c.id, e])]))])),
    queue: jobs.size + (running ? 1 : 0),
  };
}

async function loop() {
  for (;;) {
    if (!jobs.size) { await new Promise((resolve) => { wake = resolve; }); continue; }
    let job = null;
    for (const j of jobs.values()) if (!job || less(order(j), order(job))) job = j;
    const k = ks(job.key);
    jobs.delete(k);
    running = k;
    const t0 = performance.now();
    try {
      await run(job.key);
      console.info(`asset done ${k} ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {   // a failed image must not stop the queue; the player sees the error state
      const msg = String(e?.message || e).slice(0, 300);
      errors.set(k, msg);
      console.error(`asset failed ${k}: ${msg}`);
    } finally {
      running = null;
    }
  }
}

async function run(key) {
  if (store.hasFile(pathOf(key))) return;
  let game;
  try { game = await store.loadGame(key[1]); } catch { return; }   // deleted while queued
  if (key[0] === 'scene') await scene(game, key[2]);
  else if (key[3] === 'calm') await calm(game, key[2]);
  else await expression(game, key[2], key[3]);
}

// ---------- prompts ----------

const isoColor = (appearance) => (/\bblue\b/i.test(appearance) ? 'light green' : 'light blue');

const fluxSpritePrompt = (appearance, expr) => {
  const color = isoColor(appearance);
  return `solid ${color} background, ${A.STYLE}, ${appearance}, ${A.EXPR_PROMPT[expr]}, ${A.FRAMING}, ` +
    `plain flat ${color} backdrop behind the character`;
};

function fluxScenePrompt(style, prompt) {
  for (const [pattern, blank] of A.FLUX_BLANK) prompt = prompt.replace(new RegExp(pattern, 'gi'), blank);
  return `${A.BG_STYLE}, ${style}, ${prompt}, ${A.FLUX_BG_TAIL}`;
}

function soften(prompt) {
  for (const [pattern, standIn] of A.SOFTEN) prompt = prompt.replace(new RegExp(pattern, 'gi'), standIn);
  return prompt;
}

// ---------- NVIDIA FLUX through the relay ----------

const wait = (s) => new Promise((resolve) => { setTimeout(resolve, s * 1000); });

async function draw(prompt, seed) {
  const { key, relay } = conn();
  if (!key) throw new Error('尚未在設定填寫輝達 API 金鑰');
  if (!relay) throw new Error('尚未在設定填寫中繼站網址');
  const body = JSON.stringify({ prompt: soften(prompt), width: A.SIZE, height: A.SIZE, seed: seed % 2 ** 31, steps: A.STEPS });
  let res;
  for (const backoff of [...A.RETRY_BACKOFF_S, null]) {
    try {
      res = await fetch(`${relay}${A.FLUX_PATH}`, {
        method: 'POST', body,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      });
    } catch (e) {
      throw new Error('連不上中繼站，請檢查設定裡的中繼站網址');
    }
    if (res.status === 200) break;
    if (res.status === 401 || res.status === 403) throw new Error(`輝達金鑰被拒絕（HTTP ${res.status}）`);
    if (!A.RETRY_STATUS.includes(res.status) || backoff === null) throw new Error(`輝達生圖失敗：HTTP ${res.status}`);
    await wait(backoff);
  }
  const art = ((await res.json()).artifacts || [{}])[0] || {};
  if (art.finishReason !== 'SUCCESS' || !art.base64) {
    if (art.finishReason === 'CONTENT_FILTERED') throw new Error('輝達內容過濾擋下這段提示詞（CONTENT_FILTERED）');
    throw new Error(`輝達生圖沒有回傳圖片（${String(art.finishReason).replace(/ONT_[A-Za-z0-9_-]+/g, '***').slice(0, 60)}）`);
  }
  const bytes = Uint8Array.from(atob(art.base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes]));
}

// Center-crop the square to the target aspect ratio, then resize; returns ImageData
function fit(img, width, height) {
  let box;
  if (width / height < 1) {
    const w = Math.round(img.height * width / height);
    box = [Math.trunc((img.width - w) / 2), 0, w, img.height];
  } else {
    const h = Math.round(img.width * height / width);
    box = [0, Math.trunc((img.height - h) / 2), img.width, h];
  }
  const cv = new OffscreenCanvas(width, height);
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, ...box, 0, 0, width, height);
  return g.getImageData(0, 0, width, height);
}

async function toPng(imageData, crop = null) {
  const cv = new OffscreenCanvas(imageData.width, imageData.height);
  cv.getContext('2d').putImageData(imageData, 0, 0);
  if (!crop) return cv.convertToBlob({ type: 'image/png' });
  const [l, t, r, b] = crop;
  const out = new OffscreenCanvas(r - l, b - t);
  out.getContext('2d').drawImage(cv, l, t, r - l, b - t, 0, 0, r - l, b - t);
  return out.convertToBlob({ type: 'image/png' });
}

// ---------- cutout (cutout.key_cut + cutout_full + padded_bbox + face_box) ----------

function median(values) {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function borderIndices(w, h) {
  const idx = [];
  for (let x = 0; x < w; x += 1) idx.push(x);
  for (let x = 0; x < w; x += 1) idx.push((h - 1) * w + x);
  for (let y = 0; y < h; y += 1) idx.push(y * w);
  for (let y = 0; y < h; y += 1) idx.push(y * w + w - 1);
  return idx;
}

// 4-connected labels of a mask; returns [labels Int32Array (0 = off), sizes (index = label)]
function label(mask, w, h) {
  const labels = new Int32Array(w * h);
  const sizes = [0];
  const stack = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i += 1) {
    if (!mask[i] || labels[i]) continue;
    n += 1;
    let top = 0; let size = 0;
    stack[top++] = i;
    labels[i] = n;
    while (top) {
      const p = stack[--top];
      size += 1;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q >= 0 && q < w * h && mask[q] && !labels[q]) { labels[q] = n; stack[top++] = q; }
      }
    }
    sizes.push(size);
  }
  return [labels, sizes];
}

// Binary dilation with the 3x3 cross, `iterations` times
function dilate(mask, w, h, iterations) {
  let cur = mask;
  for (let it = 0; it < iterations; it += 1) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        out[i] = cur[i] || (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) ||
          (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]) ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

// Enclosed pockets only count as background when their median distance is under pocketMax: light shading on a
// white shirt next to a pale background sits around 37, true gaps between hair strands under 20
function keyCut(img, near = 40, soft = 12, far = 70, minPocket = 6, pocketMax = 25) {
  const { width: w, height: h, data } = img;
  const border = borderIndices(w, h);
  const bg = [0, 1, 2].map((c) => median(border.map((i) => data[i * 4 + c])));
  const dist = new Float32Array(w * h);
  const near_ = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) {
    const dr = data[i * 4] - bg[0]; const dg = data[i * 4 + 1] - bg[1]; const db = data[i * 4 + 2] - bg[2];
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
    near_[i] = dist[i] < near ? 1 : 0;
  }
  const [labels, sizes] = label(near_, w, h);
  const keep = new Uint8Array(sizes.length);
  for (const i of border) if (labels[i]) keep[labels[i]] = 1;
  const pocketDists = new Map();
  for (let i = 0; i < w * h; i += 1) {
    const l = labels[i];
    if (!l || keep[l] || sizes[l] < minPocket) continue;
    if (!pocketDists.has(l)) pocketDists.set(l, []);
    pocketDists.get(l).push(dist[i]);
  }
  for (const [l, ds] of pocketDists) if (median(ds) < pocketMax) keep[l] = 1;
  const core = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) core[i] = labels[i] && keep[labels[i]] ? 1 : 0;
  const grown = dilate(core, w, h, 2);
  const alpha = new Float32Array(w * h);
  const rgb = new Uint8ClampedArray(data);
  for (let i = 0; i < w * h; i += 1) {
    if (core[i]) { alpha[i] = 0; continue; }
    if (!grown[i]) { alpha[i] = 1; continue; }
    alpha[i] = Math.min(1, Math.max(0, (dist[i] - soft) / (far - soft)));
    // rim pixel: colour of the nearest pixel outside background and rim (usually the black lineart)
    const x = i % w; const y = (i - x) / w;
    let best = -1; let bestD = Infinity;
    for (let dy = -6; dy <= 6; dy += 1) {
      for (let dx = -6; dx <= 6; dx += 1) {
        const xx = x + dx; const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        const d = dx * dx + dy * dy;
        if (!grown[j] && d < bestD) { bestD = d; best = j; }
      }
    }
    if (best >= 0) for (let c = 0; c < 3; c += 1) rgb[i * 4 + c] = data[best * 4 + c];
  }
  return [rgb, alpha];
}

function gaussianBlur(src, w, h, sigma = 0.6) {
  const r = 2;
  const k = [];
  for (let i = -r; i <= r; i += 1) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const kn = k.map((v) => v / sum);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const clampX = (x) => Math.min(w - 1, Math.max(0, x));
  const clampY = (y) => Math.min(h - 1, Math.max(0, y));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += kn[i + r] * src[y * w + clampX(x + i)];
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let v = 0;
      for (let i = -r; i <= r; i += 1) v += kn[i + r] * tmp[clampY(y + i) * w + x];
      out[y * w + x] = v;
    }
  }
  return out;
}

// Chroma-key cutout, uncropped; returns ImageData with alpha
function cutoutFull(img) {
  const { width: w, height: h } = img;
  const [rgb, a] = keyCut(img);
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i += 1) solid[i] = a[i] > 0.3 ? 1 : 0;
  const [labels, sizes] = label(dilate(solid, w, h, 2), w, h);
  if (sizes.length > 2) {
    const max = Math.max(...sizes.slice(1));
    for (let i = 0; i < w * h; i += 1) if (!labels[i] || sizes[labels[i]] < 0.03 * max) a[i] = 0;
  }
  const a8 = new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) a8[i] = Math.trunc(a[i] * 255);
  const blurred = gaussianBlur(a8, w, h);
  for (let i = 0; i < w * h; i += 1) rgb[i * 4 + 3] = Math.round(blurred[i]);
  return new ImageData(rgb, w, h);
}

function paddedBbox(img, pad = 6) {
  const { width: w, height: h, data } = img;
  let l = w; let t = h; let r = -1; let b = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3]) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); }
    }
  }
  if (r < 0) throw new Error('去背後沒有留下角色');
  return [Math.max(0, l - pad), Math.max(0, t - pad), Math.min(w, r + 1 + pad), Math.min(h, b + 1 + pad)];
}

function faceBox(img) {
  const { width: w, height: h, data } = img;
  const on = (x, y) => data[(y * w + x) * 4 + 3] > 128;
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    let n = 0;
    for (let x = 0; x < w; x += 1) if (on(x, y)) n += 1;
    if (n > 3) rows.push(y);
  }
  const y0 = rows[0]; const y1 = rows[rows.length - 1];
  const probe = y0 + Math.trunc(0.10 * (y1 - y0));
  const cols = [];
  for (let x = 0; x < w; x += 1) if (on(x, probe)) cols.push(x);
  const cx = (cols[0] + cols[cols.length - 1]) >> 1;
  const size = Math.trunc(1.35 * (cols[cols.length - 1] - cols[0]));
  const top = Math.max(0, y0 - Math.floor(size / 10));
  const left = Math.min(Math.max(cx - Math.floor(size / 2), 0), w - size);
  return [left, top, left + size, Math.min(h, top + Math.trunc(size * A.TALL))];
}

// ---------- jobs ----------

const charOf = (game, cid) => game.characters.find((c) => c.id === cid);

async function scene(game, sid) {
  const seed = game.seed + [...sid].reduce((s, ch) => s + ch.codePointAt(0), 0);
  const img = fit(await draw(fluxScenePrompt(game.style_en || '', game.scenes[sid].image_prompt), seed), A.BG_W, A.BG_H);
  await store.putFile(store.scenePath(game.id, sid), await toPng(img));
}

async function calm(game, cid) {
  const c = charOf(game, cid);
  const full = cutoutFull(fit(await draw(fluxSpritePrompt(c.appearance_en, 'calm'), c.seed), A.SP_W, A.SP_H));
  const crop = paddedBbox(full);
  const meta = { crop, face: faceBox(full), engine: 'nvidia' };
  await store.putFile(store.metaPath(game.id, cid), new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  await store.putFile(store.spritePath(game.id, cid, 'calm'), await toPng(full, crop));
}

// No image input on the hosted endpoint: the whole sprite is redrawn with the calm seed, cropped like calm
async function expression(game, cid, expr) {
  if (!store.hasFile(store.spritePath(game.id, cid, 'calm'))) await calm(game, cid);
  const meta = await store.readJsonFile(store.metaPath(game.id, cid));
  if (!meta || meta.engine !== 'nvidia') throw new Error(WEB_ONLY_NVIDIA);
  const c = charOf(game, cid);
  const full = cutoutFull(fit(await draw(fluxSpritePrompt(c.appearance_en, expr), c.seed), A.SP_W, A.SP_H));
  await store.putFile(store.spritePath(game.id, cid, expr), await toPng(full, meta.crop));
}
