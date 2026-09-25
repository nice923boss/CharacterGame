// Browser port of server/batch_service.py (the merge-back walker is left out): writes the whole option tree of a
// batch game while this page is open. Progress sits in IndexedDB (kv `batch:<gid>`) and the tree itself is the
// checkpoint, so a closed or reloaded page picks up at the first branch not written yet.
import { DATA } from './data.js';
import * as store from './store.js';
import * as images from './images.js';
import * as turns from './turns.js';

const { BATCH_CONCURRENCY, BATCH_TURN_RETRIES } = DATA.limits;
const IMAGE_POLL_MS = 5000;
const ACTIVE = ['running', 'images'];
const PREFIX = 'batch:';

const tasks = new Map();   // gid -> { ctrl, done } for batches this page is running
let conn = () => ({ key: '', relay: '' });

// One limit for all batches together, like the server's semaphore
let free = BATCH_CONCURRENCY;
const waiting = [];
const acquire = () => (free > 0 ? (free -= 1, Promise.resolve()) : new Promise((resolve) => { waiting.push(resolve); }));
const release = () => { const next = waiting.shift(); if (next) next(); else free += 1; };

const load = (gid) => store.kvGet(PREFIX + gid);

// Progress writes of one game run one after another, so parallel branches never drop each other's fields
const saving = new Map();
function save(gid, fields) {
  const run = (saving.get(gid) || Promise.resolve()).then(async () => {
    try { await store.loadGame(gid); } catch { return; }   // never bring back the record of a deleted game
    await store.kvPut(PREFIX + gid, { ...(await load(gid) || {}), ...fields });
  });
  saving.set(gid, run.catch((e) => console.error(`batch progress save failed ${gid}`, e)));
  return run;
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

const imageStates = (a) => [...Object.values(a.scenes).map((s) => s.state),
  ...Object.values(a.sprites).flatMap((sp) => Object.values(sp).map((s) => s.state))];

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject({ code: 'cancelled' }); }, { once: true });
});

async function walk(gid, signal) {
  const failed = [];
  const game = await store.loadGame(gid);
  const last = game.batch.turns;

  const turn = async (parentId, input) => {
    let error = null;
    for (let i = 0; i <= BATCH_TURN_RETRIES; i += 1) {
      await acquire();
      try {
        if (signal.aborted) throw { code: 'cancelled' };
        return await turns.runTurn(gid, parentId, input, () => {}, conn(), signal, true);
      } catch (e) {
        if (signal.aborted) throw { code: 'cancelled' };
        if (!e?.code) console.error(`batch turn crashed ${gid}`, e);
        error = e?.code || 'internal';
      } finally {
        release();
      }
    }
    failed.push({ parent: parentId, option: input.text || '', error });
    console.warn(`batch branch skipped ${gid} parent=${parentId}: ${error}`);
    await save(gid, { failed });
    return null;
  };

  const expand = async (node, depth) => {
    if (node.result.ending || depth >= last) return;
    const tree = await store.loadTree(gid);
    await Promise.all(optionChildren(tree, tree.nodes[node.id]).map(([opt, child]) => branch(node.id, opt, child, depth + 1)));
  };
  const branch = async (parentId, opt, child, depth) => {
    const written = child || await turn(parentId, { kind: 'option', text: opt });
    if (written) await expand(written, depth);
  };

  let tree = await store.loadTree(gid);
  let root = tree.root ? tree.nodes[tree.root] : await turn(null, { kind: 'opening' });
  if (!root) {   // the player may have opened it live meanwhile
    tree = await store.loadTree(gid);
    if (tree.root) root = tree.nodes[tree.root];
  }
  if (!root) {
    await save(gid, { state: 'error', error: failed[failed.length - 1].error, finished_at: store.nowIso() });
    return;
  }
  await expand(root, 1);
  console.info(`batch text done ${gid}: ${textProgress(game, await store.loadTree(gid))[0]} nodes, ${failed.length} branches skipped`);

  // Queue every scene and sprite and wait until each one is drawn or failed
  await save(gid, { state: 'images' });
  for (;;) {
    const g = await store.loadGame(gid);
    for (const sid of Object.keys(g.scenes)) {
      if (!images.failed(['scene', gid, sid])) images.request(['scene', gid, sid], images.P_EXPR);
    }
    images.ensureGame(g, null, false);
    if (imageStates(images.status(g)).every((s) => s === 'done' || s === 'error')) break;
    await sleep(IMAGE_POLL_MS, signal);
  }
  await save(gid, { state: 'done', finished_at: store.nowIso() });
  console.info(`batch done ${gid}`);
}

async function run(gid, ctrl) {
  try {
    await walk(gid, ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) {
      await save(gid, { state: 'cancelled', finished_at: store.nowIso() });
      console.info(`batch cancelled ${gid}`);
    } else {
      console.error(`batch crashed ${gid}`, e);
      await save(gid, { state: 'error', error: e?.code || 'internal', finished_at: store.nowIso() });
    }
  }
}

export function init(getConn) { conn = getConn; }

// Starts the batch in this page and resolves once it is marked running. With several tabs open only one of them
// runs a given game (Web Locks); the others just show its progress.
export async function start(gid) {
  if (tasks.has(gid)) return;
  const ctrl = new AbortController();
  const task = { ctrl, done: Promise.resolve() };
  tasks.set(gid, task);
  const old = await load(gid) || {};
  await save(gid, { state: 'running', started_at: old.started_at || store.nowIso(), finished_at: null, failed: [], error: null });
  const go = () => run(gid, ctrl);
  task.done = (navigator.locks
    ? navigator.locks.request(PREFIX + gid, { ifAvailable: true }, (lock) => (lock ? go() : null))
    : go()
  ).catch((e) => console.error(`batch start failed ${gid}`, e)).finally(() => tasks.delete(gid));
}

// Cancels a batch running in this page and waits until it has let go of the game's records
export async function stop(gid) {
  const task = tasks.get(gid);
  if (!task) return false;
  task.ctrl.abort();
  await Promise.race([task.done, new Promise((resolve) => { setTimeout(resolve, 10000); })]);
  return true;
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
  const [made, planned] = textProgress(game, await store.loadTree(gid));
  const states = imageStates(images.status(game));
  return {
    id: gid, title: game.title, lang: game.lang || 'zh', state: b.state, nodes: made, planned,
    failed: (b.failed || []).length, images: states.filter((s) => s === 'done').length, images_total: states.length,
    image_errors: states.filter((s) => s === 'error').length, started_at: b.started_at, finished_at: b.finished_at, error: b.error,
  };
}

export async function list() {
  const ids = (await store.kvKeys()).filter((k) => typeof k === 'string' && k.startsWith(PREFIX))
    .map((k) => k.slice(PREFIX.length)).sort().reverse();
  const out = [];
  for (const gid of ids) {
    try { out.push(await status(gid)); } catch (e) { console.warn(`batch status skipped ${gid}`, e); }
  }
  return out.filter(Boolean);
}
