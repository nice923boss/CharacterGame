// Browser port of server/asset_service.py + cutout.py for NVIDIA FLUX.2 only: one sequential queue with the
// same priorities, automatic re-queues, image modes and redraws, scenes and sprites drawn through the player's
// relay, sprites cut out with the chroma key. The queue is kept in IndexedDB, so a reload carries on with it.
// Skipped against the server: ComfyUI, rembg, the iso residue pass and the .raw intermediates.
import { DATA } from './data.js';
import * as store from './store.js';
import * as llm from './llm.js';
import { diag } from './diag.js';
import { t } from '../i18n.js';

const A = DATA.art;
const EXPRESSIONS = DATA.parser.EXPRESSIONS;
export const P_SCENE = 0; export const P_SPEAKER = 1; export const P_CALM = 2; export const P_EXPR = 3;
const QUEUE = 'imageQueue';         // kv record holding the queue between page loads
const FRONT_FRESH_MS = 10000;       // a front tab that stopped announcing itself this long ago no longer counts

// retryable: false when trying the same prompt again later cannot help (filtered prompt, refused key)
class ImageFailed extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

const jobs = new Map();     // key string -> { key, priority, seq }
const errors = new Map();   // key string -> message
const later = new Map();    // key string -> { key, due (epoch ms), priority, error }: failed, queued again at due
const rounds = new Map();   // key string -> automatic re-queues so far
let current = null;         // the job being drawn
let seq = 0;
let wake = null;
let started = false;
let active = null;
let turns = 0;              // story turns being written right now
let mode = 'all';
let conn = () => ({ key: '', relay: '' });

const ks = (key) => key.join('|');
const running = () => (current ? ks(current.key) : null);

export function init(getConn, imageMode = 'all') {
  conn = getConn;
  mode = A.IMAGE_MODES.includes(imageMode) ? imageMode : 'all';
  if (started) return;
  started = true;
  restore().catch((e) => console.error('image queue restore failed', e)).then(loop);
}

export const setActive = (gid) => { active = gid; };

function wakeUp() { if (wake) wake(); }

function pathOf(key) {
  return key[0] === 'scene' ? store.scenePath(key[1], key[2]) : store.spritePath(key[1], key[2], key[3]);
}

const wanted = (key) => mode !== 'off' && (mode !== 'basic' || key[0] === 'scene' || key[3] === 'calm');

// Images the new mode does not draw leave the queue; the next poll queues what it adds back
export function setMode(value) {
  if (!A.IMAGE_MODES.includes(value)) return;
  mode = value;
  for (const [k, j] of jobs) if (!wanted(j.key)) jobs.delete(k);
  for (const [k, l] of later) if (!wanted(l.key)) later.delete(k);
  persist();
  wakeUp();
}

// retry=false leaves a failed image (or one waiting for its automatic retry) alone
export function request(key, priority, retry = true) {
  const k = ks(key);
  if (store.hasFile(pathOf(key)) || k === running() || !wanted(key)) return;
  if (errors.has(k) || later.has(k)) {
    if (!retry) return;
    errors.delete(k);
    later.delete(k);
    rounds.delete(k);
  }
  const job = jobs.get(k);
  if (job) job.priority = Math.min(job.priority, priority);
  else jobs.set(k, { key, priority, seq: ++seq });
  persist();
  wakeUp();
}

export function forget(gid) {
  for (const map of [jobs, later]) for (const [k, j] of map) if (j.key[1] === gid) map.delete(k);
  for (const map of [errors, rounds]) for (const k of [...map.keys()]) if (k.split('|')[1] === gid) map.delete(k);
  persist();
}

const order = (j) => [j.key[1] !== active ? 1 : 0, j.priority, j.seq];
const less = (a, b) => { for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// Wrap the writing of a story turn: meanwhile only the background on screen is drawn
export async function textTurn(fn) {
  turns += 1;
  try {
    return await fn();
  } finally {
    turns -= 1;
    wakeUp();
  }
}

const runnable = (j) => !turns || (j.priority === P_SCENE && j.key[1] === active);

export function ensureGame(game, sceneId = null, retry = true) {
  const gid = game.id;
  const list = sceneId ? [[['scene', gid, sceneId], P_SCENE]] : [];
  for (const c of game.characters) list.push([['sprite', gid, c.id, 'calm'], P_CALM]);
  for (const c of game.characters) for (const e of EXPRESSIONS.slice(1)) list.push([['sprite', gid, c.id, e], P_EXPR]);
  for (const [key, p] of list) request(key, p, retry);
}

// Same shape as the server's status, plus the url to show (blob or bundled demo file)
export function status(game) {
  const gid = game.id;
  const now = Date.now();
  const busy = current ? 1 : 0;
  const one = (key) => {
    const k = ks(key);
    const path = pathOf(key);
    if (store.hasFile(path)) return { state: 'done', v: store.fileVersion(path), url: store.fileUrl(path) };
    if (!wanted(key)) return { state: 'off' };
    if (k === running()) return { state: 'running' };
    if (errors.has(k)) return { state: 'error', error: errors.get(k) };
    if (later.has(k)) {
      const l = later.get(k);
      return { state: 'queued', retry_in: Math.max(0, Math.round((l.due - now) / 1000)), error: l.error, ahead: jobs.size + busy };
    }
    if (jobs.has(k)) {
      const mine = order(jobs.get(k));
      const ahead = [...jobs.values()].filter((j) => less(order(j), mine)).length;
      return { state: 'queued', ahead: ahead + busy };
    }
    return { state: 'missing' };
  };
  return {
    scenes: Object.fromEntries(Object.keys(game.scenes).map((sid) => [sid, one(['scene', gid, sid])])),
    sprites: Object.fromEntries(game.characters.map((c) =>
      [c.id, Object.fromEntries(EXPRESSIONS.map((e) => [e, one(['sprite', gid, c.id, e])]))])),
    queue: jobs.size + later.size + busy,
    paused: turns > 0,
  };
}

// ---------- the queue between page loads ----------

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const all = [...jobs.values(), ...(current ? [current] : [])];
    store.kvPut(QUEUE, { jobs: all.map((j) => [j.key, j.priority]), later: [...later.values()], rounds: [...rounds] })
      .catch((e) => console.error('image queue save failed', e));
  }, 500);
}

async function restore() {
  const saved = await store.kvGet(QUEUE);
  if (!saved) return;
  for (const [key, priority] of saved.jobs || []) request(key, priority);
  for (const l of saved.later || []) if (wanted(l.key) && !store.hasFile(pathOf(l.key))) later.set(ks(l.key), l);
  for (const [k, n] of saved.rounds || []) rounds.set(k, n);
}

// ---------- tabs: the one the player used last draws first ----------
// Every tab runs its own queue. The tab in front announces itself; a tab behind it waits while the front tab
// still has images to draw, so two tabs do not split the request limit or draw the same picture twice.

const TAB = Math.random().toString(36).slice(2);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cg-images') : null;
let front = null;   // { tab, busy, at } from the tab in front

const inFront = () => document.visibilityState === 'visible' && document.hasFocus();

function announce() {
  if (channel && inFront()) channel.postMessage({ tab: TAB, busy: jobs.size > 0 || !!current, at: Date.now() });
}

if (channel) {
  channel.onmessage = (ev) => {
    front = ev.data;
    if (!front.busy) wakeUp();
  };
  window.addEventListener('focus', announce);
  document.addEventListener('visibilitychange', announce);
  setInterval(announce, 3000);
}

const behind = () => !inFront() && !!front && front.tab !== TAB && front.busy && Date.now() - front.at < FRONT_FRESH_MS;

// ---------- loop ----------

// Resolves after ms (null: only when woken)
function idle(ms) {
  return new Promise((resolve) => {
    const timer = ms === null ? null : setTimeout(done, ms);
    function done() { clearTimeout(timer); wake = null; resolve(); }
    wake = done;
  });
}

// Failed images whose wait is over go back into the queue
function promote() {
  const now = Date.now();
  for (const [k, l] of later) {
    if (l.due > now) continue;
    later.delete(k);
    if (!wanted(l.key) || store.hasFile(pathOf(l.key))) continue;
    if (!jobs.has(k)) jobs.set(k, { key: l.key, priority: l.priority, seq: ++seq });
  }
}

function failed(job, e) {
  const k = ks(job.key);
  const msg = String(e?.message || e).slice(0, 300);
  const n = rounds.get(k) || 0;
  if (e?.retryable !== false && n < A.AUTO_RETRY_ROUNDS) {
    rounds.set(k, n + 1);
    later.set(k, { key: job.key, due: Date.now() + A.AUTO_RETRY_S * 1000, priority: job.priority, error: msg });
    console.warn(`asset failed ${k} (automatic retry ${n + 1} in ${A.AUTO_RETRY_S}s): ${msg}`);
    diag('image_requeue', { asset: k, round: n + 1, error: msg });
    return;
  }
  rounds.delete(k);
  errors.set(k, msg);
  console.error(`asset failed ${k}: ${msg}`);
  diag('image_failed', { asset: k, error: msg });
}

async function loop() {
  for (;;) {
    promote();
    const ready = behind() ? [] : [...jobs.values()].filter(runnable);
    if (!ready.length) {
      const dues = [...later.values()].map((l) => Math.max(0, l.due - Date.now()));
      let ms = dues.length ? Math.min(...dues) : null;
      if (jobs.size && behind()) ms = Math.min(ms ?? 3000, 3000);
      await idle(ms);
      continue;
    }
    let job = ready[0];
    for (const j of ready) if (less(order(j), order(job))) job = j;
    const k = ks(job.key);
    jobs.delete(k);
    current = job;
    const t0 = performance.now();
    try {
      await run(job.key);
      rounds.delete(k);
      const s = Math.round((performance.now() - t0) / 100) / 10;
      console.info(`asset done ${k} ${s}s`);
      diag('image_done', { asset: k, s });
    } catch (e) {   // a failed image must not stop the queue; the player sees the error state
      failed(job, e);
    } finally {
      current = null;
      persist();
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

// ---------- redraw ----------

const seedsPath = (gid) => `${gid}/assets/seeds.json`;

// A redrawn image keeps its new seed in assets/seeds.json; otherwise the seed comes from the game
async function seedOf(game, kind, target) {
  const saved = (await store.readJsonFile(seedsPath(game.id))) || {};
  if (`${kind}:${target}` in saved) return saved[`${kind}:${target}`];
  if (kind === 'scene') return game.seed + [...target].reduce((s, ch) => s + ch.codePointAt(0), 0);
  return charOf(game, target).seed;
}

// Draw one background, or one character's whole sprite set, again (newSeed: with a new random seed; the same
// seed repeats the picture on FLUX). False when that image is being drawn right now.
export async function redraw(game, kind, target, newSeed = true) {
  const gid = game.id;
  const keys = kind === 'scene' ? [['scene', gid, target]] : EXPRESSIONS.map((e) => ['sprite', gid, target, e]);
  if (keys.some((key) => ks(key) === running())) return false;
  for (const key of keys) for (const map of [jobs, later, errors, rounds]) map.delete(ks(key));
  if (newSeed) {
    const saved = (await store.readJsonFile(seedsPath(gid))) || {};
    const next = { ...saved, [`${kind}:${target}`]: Math.floor(Math.random() * 2 ** 31) };
    await store.putFile(seedsPath(gid), new Blob([JSON.stringify(next)], { type: 'application/json' }));
  }
  const files = kind === 'scene' ? [store.scenePath(gid, target)]
    : store.filePaths().filter((p) => p.startsWith(`${gid}/assets/sprites/${target}/`));
  for (const p of files) await store.deleteFile(p);
  for (const key of keys) request(key, key[0] === 'scene' ? P_SCENE : key[3] === 'calm' ? P_SPEAKER : P_EXPR);
  return true;
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

// Busy answers, network errors and timeouts retry with the backoff table (a Retry-After header replaces the
// table step); every attempt first takes a slot in the request window shared with the story text
async function draw(prompt, seed) {
  const { key, relay } = conn();
  if (!key) throw new ImageFailed(t('img.noKey'), false);
  if (!relay) throw new ImageFailed(t('img.noRelay'), false);
  const body = JSON.stringify({ prompt: soften(prompt), width: A.SIZE, height: A.SIZE, seed: seed % 2 ** 31, steps: A.STEPS });
  let data;
  for (const backoff of [...A.RETRY_BACKOFF_S, null]) {
    await llm.imageSlot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), A.TIMEOUT_S * 1000);
    let res;
    try {
      res = await fetch(`${relay}${A.FLUX_PATH}`, {
        method: 'POST', body, signal: ctrl.signal,
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      });
      llm.relayNotice(res);
      if (res.status === 200) data = await res.json();
    } catch (e) {
      if (backoff === null) throw new ImageFailed(ctrl.signal.aborted ? t('img.timeout', { s: A.TIMEOUT_S }) : t('img.network'));
      diag('image_retry', { reason: ctrl.signal.aborted ? 'timeout' : 'network', wait: backoff });
      await wait(backoff);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (data) break;
    if (res.status === 429 && (await res.text().catch(() => '')).includes('relay_quota')) {
      throw new ImageFailed(t('err.relay_quota'), false);
    }
    if (res.status === 401 || res.status === 403) throw new ImageFailed(t('img.keyRejected', { status: res.status }), false);
    if (!A.RETRY_STATUS.includes(res.status) || backoff === null) {
      // NVIDIA also answers 404 while a function is briefly unavailable, so a later round may still work
      throw new ImageFailed(t('img.http', { status: res.status }), A.RETRY_STATUS.includes(res.status) || res.status === 404);
    }
    const hint = llm.retryAfter(res.headers.get('retry-after'));
    const pause = hint === null ? backoff : Math.min(hint, DATA.llm.RETRY_AFTER_MAX_S);
    diag('image_retry', { status: res.status, wait: pause });
    await wait(pause);
  }
  const art = (data.artifacts || [{}])[0] || {};
  if (art.finishReason !== 'SUCCESS' || !art.base64) {
    if (art.finishReason === 'CONTENT_FILTERED') throw new ImageFailed(t('img.filtered'), false);
    throw new ImageFailed(t('img.noImage', { reason: String(art.finishReason).replace(/ONT_[A-Za-z0-9_-]+/g, '***').slice(0, 60) }));
  }
  const bytes = Uint8Array.from(atob(art.base64), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes]));
}

// For tools/js_tests: draw one image with a given connection, without starting the queue (it needs IndexedDB)
export const _test = { draw, useConn: (getConn) => { conn = getConn; } };

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
  let l = w; let top = h; let r = -1; let b = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4 + 3]) { l = Math.min(l, x); r = Math.max(r, x); top = Math.min(top, y); b = Math.max(b, y); }
    }
  }
  if (r < 0) throw new Error(t('img.emptyCutout'));
  return [Math.max(0, l - pad), Math.max(0, top - pad), Math.min(w, r + 1 + pad), Math.min(h, b + 1 + pad)];
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
  const seed = await seedOf(game, 'scene', sid);
  const img = fit(await draw(fluxScenePrompt(game.style_en || '', game.scenes[sid].image_prompt), seed), A.BG_W, A.BG_H);
  await store.putFile(store.scenePath(game.id, sid), await toPng(img));
}

async function calm(game, cid) {
  const c = charOf(game, cid);
  const seed = await seedOf(game, 'sprite', cid);
  const full = cutoutFull(fit(await draw(fluxSpritePrompt(c.appearance_en, 'calm'), seed), A.SP_W, A.SP_H));
  const crop = paddedBbox(full);
  const meta = { crop, face: faceBox(full), engine: 'nvidia' };
  await store.putFile(store.metaPath(game.id, cid), new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  await store.putFile(store.spritePath(game.id, cid, 'calm'), await toPng(full, crop));
}

// No image input on the hosted endpoint: the whole sprite is redrawn with the calm seed, cropped like calm
async function expression(game, cid, expr) {
  if (!store.hasFile(store.spritePath(game.id, cid, 'calm'))) await calm(game, cid);
  const meta = await store.readJsonFile(store.metaPath(game.id, cid));
  if (!meta || meta.engine !== 'nvidia') throw new ImageFailed(t('img.webOnlyNvidia'), false);
  const c = charOf(game, cid);
  const seed = await seedOf(game, 'sprite', cid);
  const full = cutoutFull(fit(await draw(fluxSpritePrompt(c.appearance_en, expr), seed), A.SP_W, A.SP_H));
  await store.putFile(store.spritePath(game.id, cid, expr), await toPng(full, meta.crop));
}
