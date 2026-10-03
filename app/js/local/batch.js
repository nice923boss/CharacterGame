// Browser port of server/batch_service.py (the merge-back walker is left out): writes the whole option tree of a
// batch game while this page is open. Progress sits in IndexedDB (kv `batch:<gid>`) and the tree itself is the
// checkpoint, so a closed or reloaded page picks up at the first branch not written yet. Turns run up to
// BATCH_CONCURRENCY at a time, fewer while the model is busy; a failed branch waits outside its slot before each
// retry, and whatever still fails gets one more try after the whole pass.
import { DATA } from './data.js?v=35d64fef8e0b';
import * as store from './store.js?v=35d64fef8e0b';
import * as images from './images.js?v=35d64fef8e0b';
import * as turns from './turns.js?v=35d64fef8e0b';
import { diag } from './diag.js?v=35d64fef8e0b';

const { BATCH_CONCURRENCY, BATCH_TURN_RETRIES, BATCH_RETRY_WAITS_S, BATCH_TAIL_WAIT_S, BATCH_GROW_AFTER } = DATA.limits;
const IMAGE_POLL_MS = 5000;
const STOP_WAIT_MS = 10000;
export const ACTIVE = ['running', 'images'];
const PREFIX = 'batch:';
const BUSY = ['transient', 'timeout', 'upstream'];   // failure reasons that mean the model (or the relay) is overloaded
const ETA_WINDOW = 10;                               // finished turns the time estimate averages over

const tasks = new Map();   // gid -> { ctrl, done, stopAs } for batches this page started
const here = new Set();    // gids this page is writing right now (it holds their lock)
const doneAt = new Map();  // gid -> times of the last finished turns
let conn = () => ({ key: '', relay: '' });

// Seconds to wait before try number n + 1 of a branch (n >= 1)
const retryWait = (n) => BATCH_RETRY_WAITS_S[Math.min(n, BATCH_RETRY_WAITS_S.length) - 1];

// How many batch turns may talk to the model at once, shared by every batch of this page. A busy answer halves the
// limit, never below 1; BATCH_GROW_AFTER successes in a row give one slot back.
const limiter = {
  most: BATCH_CONCURRENCY, limit: BATCH_CONCURRENCY, active: 0, streak: 0, waiting: [],
  pump() {
    while (this.waiting.length && this.active < this.limit) { this.active += 1; this.waiting.shift()(); }
  },
  acquire() { return new Promise((resolve) => { this.waiting.push(resolve); this.pump(); }); },
  release() { this.active -= 1; this.pump(); },
  busy() { this.limit = Math.max(1, Math.floor(this.limit / 2)); this.streak = 0; diag('batch_slower', { limit: this.limit }); },
  ok() {
    this.streak += 1;
    if (this.streak >= BATCH_GROW_AFTER && this.limit < this.most) {
      this.limit += 1; this.streak = 0; this.pump();
      diag('batch_faster', { limit: this.limit });
    }
  },
};
const isBusy = (e) => e?.code === 'all_failed' && (e.params?.errors || []).some((x) => BUSY.includes(x.reason));

// For tools/js_tests
export const _test = { limiter, isBusy };

const load = (gid) => store.kvGet(PREFIX + gid);

// Progress writes of one game run one after another, so parallel branches never drop each other's fields.
// fields may be a function of the stored record, for changes that depend on it.
const saving = new Map();
function save(gid, fields) {
  const run = (saving.get(gid) || Promise.resolve()).then(async () => {
    try { await store.loadGame(gid); } catch { return; }   // never bring back the record of a deleted game
    const old = await load(gid) || {};
    await store.kvPut(PREFIX + gid, { ...old, ...(typeof fields === 'function' ? await fields(old) : fields) });
  });
  saving.set(gid, run.catch((e) => console.error(`batch progress save failed ${gid}`, e)));
  return run;
}

const branchKey = (parentId, option) => `${parentId}\n${String(option).replace(/\s+/g, '')}`;

// Recorded failures whose branch is still unwritten; the player or a later pass may have written it since
function openFailed(tree, failed) {
  return failed.filter((f) => {
    if (f.parent === null) return tree.root === null;
    const parent = tree.nodes[f.parent];
    return !!parent && !turns.existingChild(tree, parent, f.option);
  });
}

// (option text, existing child or null) for each distinct option of a node
function optionChildren(tree, node) {
  const seen = new Set();
  const out = [];
  for (const opt of node.result.options || []) {
    const key = opt.replace(/\s+/g, '');
    if (key && !seen.has(key)) { seen.add(key); out.push([opt, turns.existingChild(tree, node, opt)]); }
  }
  return out;
}

// [nodes written, nodes planned]. Planned is an upper bound that shrinks as early endings appear.
function textProgress(game, tree) {
  const { options: n, turns: last } = game.batch;
  if (tree.root === null) return [0, turns.treeSize(n, last)];
  let made = 0;
  let planned = 0;
  const stack = [[tree.root, 1]];
  while (stack.length) {
    const [nid, depth] = stack.pop();
    const node = tree.nodes[nid];
    made += 1;
    planned += 1;
    if (node.result.ending || depth >= last) continue;
    for (const [, child] of optionChildren(tree, node)) {
      if (child) stack.push([child.id, depth + 1]);
      else planned += turns.treeSize(n, last - depth);
    }
  }
  return [made, planned];
}

// "off": the image mode skips that image, so it counts neither as drawn nor as missing
const imageStates = (a) => [...Object.values(a.scenes).map((s) => s.state),
  ...Object.values(a.sprites).flatMap((sp) => Object.values(sp).map((s) => s.state))].filter((s) => s !== 'off');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(t); reject({ code: 'cancelled' }); };
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});

// The node the player is on (autosave) and every node written under it
async function focusOf(gid, tree) {
  const auto = await store.loadAutosave();
  const out = new Set();
  const nid = auto?.game_id === gid ? auto.node_id : null;
  if (!tree.nodes[nid]) return out;
  const stack = [nid];
  while (stack.length) {
    const n = stack.pop();
    out.add(n);
    stack.push(...(tree.nodes[n].children || []).filter((c) => tree.nodes[c]));
  }
  return out;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// One try at one branch inside a limiter slot: { node } or { error }. Cancelling the batch throws.
async function attempt(gid, parentId, input, signal) {
  await limiter.acquire();
  try {
    if (signal.aborted) throw { code: 'cancelled' };
    const node = await turns.runTurn(gid, parentId, input, () => {}, conn(), signal, true);
    limiter.ok();
    doneAt.set(gid, [...(doneAt.get(gid) || []), Date.now()].slice(-(ETA_WINDOW + 1)));
    return { node };
  } catch (e) {
    if (signal.aborted) throw { code: 'cancelled' };
    if (isBusy(e)) limiter.busy();
    if (!e?.code) console.error(`batch turn crashed ${gid}`, e);
    return { error: e?.code || 'internal' };
  } finally {
    limiter.release();
  }
}

// Records a branch that used up its tries; the same branch failing again replaces its old entry
function fail(gid, parentId, option, error) {
  console.warn(`batch branch skipped ${gid} parent=${parentId}: ${error}`);
  const key = branchKey(parentId, option);
  return save(gid, async (old) => ({
    failed: [...openFailed(await store.loadTree(gid), (old.failed || []).filter((f) => branchKey(f.parent, f.option) !== key)),
      { parent: parentId, option, error }],
  }));
}

// The opening with all its tries, each wait spent outside any slot
async function opening(gid, tries, signal) {
  let error = null;
  for (let n = 0; n < tries; n += 1) {
    if (n) await sleep(retryWait(n) * 1000, signal);
    const r = await attempt(gid, null, { kind: 'opening' }, signal);
    if (r.node) return r.node;
    error = r.error;
  }
  await fail(gid, null, '', error);
  return null;
}

// Writes every open option: the player's own branch first, then shallow turns before deep ones, so the player can
// start at the opening and rarely catches up with the writer. The order is worked out again after every finished
// turn, because the player moves while the batch runs. A failed branch gives its slot to the others while it waits
// for its next try; after `tries` failures it is recorded and skipped.
async function walkOptions(gid, last, tries, signal) {
  const tried = new Set();
  const later = new Map();     // branch -> { due, n }: when it may try again, tries so far
  const running = new Map();   // promise -> the branch it writes, with its tries before this one
  for (;;) {
    const tree = await store.loadTree(gid);
    const focus = await focusOf(gid, tree);
    const now = Date.now();
    const todo = [];
    const stillOpen = new Set();
    const stack = [[tree.root, 1]];
    while (stack.length) {
      const [nid, depth] = stack.pop();
      const node = tree.nodes[nid];
      if (node.result.ending || depth >= last) continue;
      for (const [opt, child] of optionChildren(tree, node)) {
        const key = branchKey(nid, opt);
        if (child) { stack.push([child.id, depth + 1]); continue; }
        stillOpen.add(key);
        const away = focus.has(nid) ? 0 : 1;
        if (!tried.has(key)) todo.push({ away, depth, nid, opt, key, n: 0 });
        else if (later.get(key)?.due <= now) todo.push({ away, depth, nid, opt, key, n: later.get(key).n });
      }
    }
    for (const key of later.keys()) if (!stillOpen.has(key)) later.delete(key);   // the player wrote it meanwhile
    todo.sort((a, b) => a.away - b.away || a.depth - b.depth || cmp(a.nid, b.nid) || cmp(a.opt, b.opt) || a.n - b.n);
    for (const item of todo.slice(0, Math.max(0, limiter.limit - running.size))) {
      tried.add(item.key);
      later.delete(item.key);
      const p = attempt(gid, item.nid, { kind: 'option', text: item.opt }, signal).then((r) => [p, r]);
      p.catch(() => {});   // a cancelled turn is reported once, through the race below
      running.set(p, item);
    }
    if (!running.size && !later.size) return;
    // Wake for a finished turn or for the next retry that comes due (one already due waits for room)
    const waits = [...running.keys()];
    const dues = [...later.values()].map((l) => l.due).filter((d) => d > now);
    if (dues.length) {
      const timer = sleep(Math.max(0, Math.min(...dues) - Date.now()), signal).then(() => null);
      timer.catch(() => {});
      waits.push(timer);
    }
    const done = await Promise.race(waits);
    if (!done) continue;
    const [p, r] = done;
    const { nid, opt, n } = running.get(p);
    running.delete(p);
    if (r.node) continue;
    if (n + 1 < tries) later.set(branchKey(nid, opt), { due: Date.now() + retryWait(n + 1) * 1000, n: n + 1 });
    else await fail(gid, nid, opt, r.error);
  }
}

async function walk(gid, signal) {
  const game = await store.loadGame(gid);
  const last = game.batch.turns;
  const rootless = async () => (await store.loadTree(gid)).root === null;
  // One pass over every open branch with `tries` tries each; false when the opening could not be written
  const pass = async (tries) => {
    if (await rootless() && !(await opening(gid, tries, signal)) && await rootless()) return false;   // unless the player opened it live meanwhile
    await walkOptions(gid, last, tries, signal);
    return true;
  };
  const stillFailed = async () => openFailed(await store.loadTree(gid), (await load(gid))?.failed || []);

  let ok = await pass(1 + BATCH_TURN_RETRIES);
  if ((await stillFailed()).length) {
    // The busy spell may be over by now: every branch that failed gets one more try
    console.info(`batch tail pass ${gid} in ${BATCH_TAIL_WAIT_S} s`);
    await sleep(BATCH_TAIL_WAIT_S * 1000, signal);
    ok = await pass(1);
  }
  const failed = await stillFailed();
  await save(gid, { failed });
  if (!ok) {
    const error = failed.find((f) => f.parent === null)?.error || 'internal';
    await save(gid, { state: 'error', error, finished_at: store.nowIso() });
    return;
  }
  console.info(`batch text done ${gid}: ${textProgress(game, await store.loadTree(gid))[0]} nodes, ${failed.length} branches skipped`);

  // Queue every scene and sprite and wait until each one is drawn or failed
  await save(gid, { state: 'images' });
  for (;;) {
    const g = await store.loadGame(gid);
    for (const sid of Object.keys(g.scenes)) images.request(['scene', gid, sid], images.P_EXPR, false);
    images.ensureGame(g, null, false);
    if (imageStates(images.status(g)).every((s) => s === 'done' || s === 'error')) break;
    await sleep(IMAGE_POLL_MS, signal);
  }
  await save(gid, { state: 'done', finished_at: store.nowIso() });
  console.info(`batch done ${gid}`);
}

async function run(gid, task) {
  try {
    await walk(gid, task.ctrl.signal);
  } catch (e) {
    if (task.ctrl.signal.aborted) {
      const state = task.stopAs || 'cancelled';
      await save(gid, { state, finished_at: store.nowIso() });
      console.info(`batch ${state} ${gid}`);
    } else {
      console.error(`batch crashed ${gid}`, e);
      await save(gid, { state: 'error', error: e?.code || 'internal', finished_at: store.nowIso() });
    }
  }
}

// While this page writes a batch the screen stays on, so the device does not sleep and freeze the tab. The browser
// drops the lock whenever the tab is hidden; it is asked for again when the tab shows.
let awake = null;
let asking = false;
async function holdAwake() {
  if (!navigator.wakeLock || asking) return;
  if (here.size && !awake && document.visibilityState === 'visible') {
    asking = true;
    try {
      awake = await navigator.wakeLock.request('screen');
      awake.addEventListener('release', () => { awake = null; });
    } catch (e) {
      console.warn('screen wake lock refused', e);
    } finally {
      asking = false;
    }
    if (!here.size) holdAwake();   // the batch ended while the browser was answering
  } else if (!here.size && awake) {
    const lock = awake;
    awake = null;
    lock.release().catch((e) => console.warn('screen wake lock release failed', e));
  }
}
document.addEventListener('visibilitychange', () => { holdAwake(); });

// Only one tab writes a given batch (Web Locks); a stop from any other tab reaches it through this channel
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cg-batch') : null;

async function stopHere(gid, as) {
  const task = tasks.get(gid);
  task.stopAs = as;
  task.ctrl.abort();
  await Promise.race([task.done, new Promise((resolve) => { setTimeout(resolve, STOP_WAIT_MS); })]);
}

channel?.addEventListener('message', async ({ data }) => {
  if (data?.type !== 'stop' || !here.has(data.gid)) return;
  await stopHere(data.gid, data.as);
  channel.postMessage({ type: 'stopped', gid: data.gid });
});

export function init(getConn) { conn = getConn; }

// Starts the batch in this page and resolves once it is marked running. With several tabs open only one of them
// runs a given game (Web Locks); the others just show its progress.
export async function start(gid) {
  if (tasks.has(gid)) return;
  const ctrl = new AbortController();
  const task = { ctrl, done: Promise.resolve(), stopAs: null };
  tasks.set(gid, task);
  doneAt.set(gid, []);
  const old = await load(gid) || {};
  // The failed list stays: a branch leaves it only once it is written
  await save(gid, { state: 'running', started_at: old.started_at || store.nowIso(), finished_at: null, error: null });
  const go = async () => {
    here.add(gid);
    holdAwake();
    try { await run(gid, task); } finally { here.delete(gid); holdAwake(); }
  };
  task.done = (navigator.locks
    ? navigator.locks.request(PREFIX + gid, { ifAvailable: true }, (lock) => (lock ? go() : null))
    : go()
  ).catch((e) => console.error(`batch start failed ${gid}`, e)).finally(() => tasks.delete(gid));
}

// Stops a batch and waits until it has let go of the game's records. as = 'paused' when the player means to go on
// later; either way the tree is the progress, so resuming continues from it. A batch another tab is writing is
// stopped through the channel; one no tab is writing (its tab was closed) only gets its new state.
export async function stop(gid, as = 'cancelled') {
  if (here.has(gid)) { await stopHere(gid, as); return true; }
  if (!ACTIVE.includes((await load(gid))?.state)) return false;
  const held = navigator.locks && (await navigator.locks.query()).held.some((l) => l.name === PREFIX + gid);
  if (!held) {
    await save(gid, { state: as, finished_at: store.nowIso() });
    return true;
  }
  if (!channel) return false;
  const answered = new Promise((resolve) => {
    const done = (ok) => { channel.removeEventListener('message', on); clearTimeout(timer); resolve(ok); };
    const on = ({ data }) => { if (data?.type === 'stopped' && data.gid === gid) done(true); };
    const timer = setTimeout(() => done(false), STOP_WAIT_MS);
    channel.addEventListener('message', on);
  });
  channel.postMessage({ type: 'stop', gid, as });
  return answered;
}

// Writes one branch now, outside the walker (the tree view's retry button). Errors go to the caller.
export async function rewrite(gid, parentId, option) {
  const parent = (await store.loadTree(gid)).nodes[parentId];
  const key = branchKey(parentId, option);
  if (!(parent?.result.options || []).some((o) => branchKey(parentId, o) === key)) throw { code: 'no_branch' };
  await limiter.acquire();
  try {
    return await turns.runTurn(gid, parentId, { kind: 'option', text: option }, () => {}, conn(), new AbortController().signal, true);
  } finally {
    limiter.release();
  }
}

// On page load: pick up every batch that was still working when the page was closed
export async function resumeAll() {
  for (const key of await store.kvKeys()) {
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue;
    const b = await store.kvGet(key);
    const gid = key.slice(PREFIX.length);
    if (ACTIVE.includes(b?.state)) {
      console.info(`batch resumed ${gid}`);
      await start(gid);
    }
  }
}

export async function status(gid) {
  const b = await load(gid);
  if (!b) return null;
  const game = await store.loadGame(gid);
  const tree = await store.loadTree(gid);
  const [made, planned] = textProgress(game, tree);
  const failed = openFailed(tree, b.failed || []);
  const states = imageStates(images.status(game));
  // Time left: the average gap between the last finished turns times the turns still planned (only the tab
  // writing the batch knows those times)
  const live = b.state === 'running' && here.has(gid);
  const times = doneAt.get(gid) || [];
  const eta = live && times.length >= 2
    ? Math.round(((times[times.length - 1] - times[0]) / (times.length - 1) / 1000) * Math.max(0, planned - made)) : null;
  return {
    id: gid, title: game.title, lang: game.lang || 'zh', state: b.state, nodes: made, planned,
    failed: failed.length, failed_list: failed, eta_s: eta, slow: live && limiter.limit < limiter.most,
    images: states.filter((s) => s === 'done').length, images_total: states.length,
    image_errors: states.filter((s) => s === 'error').length, started_at: b.started_at, finished_at: b.finished_at, error: b.error,
  };
}

export async function list() {
  const ids = (await store.kvKeys()).filter((k) => typeof k === 'string' && k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length)).filter((gid) => !store.isTrashed(gid)).sort().reverse();
  const out = [];
  for (const gid of ids) {
    try { out.push(await status(gid)); } catch (e) { console.warn(`batch status skipped ${gid}`, e); }
  }
  return out.filter(Boolean);
}
