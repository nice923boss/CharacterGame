// Browser-side stand-in for server/main.py on GitHub Pages: the same /api routes and job events, backed by
// IndexedDB and the player's own NVIDIA key and relay (both kept in this browser's localStorage only).
import { DATA } from './data.js';
import * as store from './store.js';
import * as images from './images.js';
import * as turns from './turns.js';
import * as batch from './batch.js';
import { loadOpenCC } from './story.js';

const KEY = 'cg-nvidia-key';
const RELAY = 'cg-relay';

function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } }
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch { throw { code: 'save_failed' }; }
}

// A relay saved in settings wins; otherwise the one built into the Pages site
export const conn = () => ({ key: lsGet(KEY), relay: lsGet(RELAY) || DATA.relay || '' });

// ---------- start-up and the bundled demo ----------

async function importDemo(force) {
  let index;
  try {
    index = await (await fetch('demo/index.json', { cache: 'no-cache' })).json();
  } catch (e) {
    console.error('demo index unavailable', e);
    return 0;
  }
  if (!force && await store.kvGet('demoVersion')) return 0;   // imported before: never overwrite player progress
  for (const gid of index.games) {
    const game = await (await fetch(`demo/${gid}/game.json`)).json();
    const tree = await (await fetch(`demo/${gid}/tree.json`)).json();
    for (const path of store.filePaths()) if (path.startsWith(`${gid}/`)) await store.deleteFile(path);
    for (const rel of index.files) {
      if (rel.startsWith(`${gid}/`) && rel !== `${gid}/game.json` && rel !== `${gid}/tree.json`) {
        await store.putHref(rel, `demo/${rel}`);
      }
    }
    await store.saveTree(gid, tree);
    await store.saveGame(game);
    images.forget(gid);
  }
  await store.kvPut('demoVersion', index.version);
  return index.games.length;
}

export const ready = (async () => {
  await store.openStore();
  await loadOpenCC();
  await importDemo(false);
  images.init(conn);
  batch.init(conn);
  batch.resumeAll().catch((e) => console.error('batch resume failed', e));
})();

export async function restoreDemo() {
  await ready;
  return importDemo(true);
}

// ---------- routes ----------

const withThumb = async (save) => save && { ...save, thumb: await store.thumb(save.game_id, save.scene_id) };
const slotsOut = async (slots) => Promise.all(slots.map(withThumb));

function validKey(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k || k.length > 200 || /\s/.test(k)) throw { code: 'bad_key' };
  return k;
}

function validRelay(url) {
  const u = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  if (!u) return '';
  let parsed;
  try { parsed = new URL(u); } catch { throw { code: 'bad_relay' }; }
  const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw { code: 'bad_relay' };
  return u;
}

const health = () => ({
  comfy: false, nvidia_image: !!conn().key, engines: ['nvidia'], local: true, relay: !!conn().relay,
  relay_default: !lsGet(RELAY) && !!DATA.relay,
  models: DATA.llm.candidates.map((c) => c.label),
});

export async function request(method, url, body) {
  await ready;
  const u = new URL(url, location.href);
  const parts = u.pathname.slice(u.pathname.indexOf('/api/') + 5).split('/');
  const scene = u.searchParams.get('scene');
  const [a, gid, sub, act] = parts;
  if (method === 'GET' && a === 'health') return health();
  if (a === 'settings' && !gid) return { image_nvidia: true, image_comfy: false, relay: lsGet(RELAY), relay_default: DATA.relay || '' };
  if (a === 'settings' && gid === 'nvidia_key') { lsSet(KEY, validKey(body?.key)); return { nvidia_key: true }; }
  if (a === 'settings' && gid === 'relay') { const r = validRelay(body?.relay); lsSet(RELAY, r); return { relay: r }; }
  if (a === 'batches') return batch.list();
  if (a === 'games' && sub === 'batch' && method === 'POST' && act === 'cancel') {
    await store.loadGame(gid);
    return { ok: await batch.stop(gid) };
  }
  if (a === 'games' && sub === 'batch' && method === 'POST' && act === 'resume') {
    if (!(await store.loadGame(gid)).batch) throw { code: 'not_batch' };
    await batch.start(gid);
    return batch.status(gid);
  }
  if (a === 'autosave') return withThumb(await store.loadAutosave());
  if (a === 'slots' && !gid) return slotsOut(await store.loadSlots());
  if (a === 'slots' && method === 'POST') {
    return slotsOut(await store.saveSlot(Number(gid), body?.game_id, body?.node_id, String(body?.label ?? '').slice(0, 80)));
  }
  if (a === 'slots' && method === 'DELETE') return slotsOut(await store.deleteSlot(Number(gid)));
  if (a === 'games' && !gid) return store.listGames();
  if (a === 'games' && method === 'DELETE') {
    await batch.stop(gid);
    images.forget(gid);
    try { await store.deleteGame(gid); } catch (e) {
      if (e?.code) throw e;
      console.error('delete game failed', e);
      throw { code: 'delete_failed' };
    }
    return { ok: true };
  }
  if (a === 'games' && (sub === undefined || sub === 'assets') && method === 'GET') {
    const game = await store.loadGame(gid);
    images.setActive(gid);
    images.ensureGame(game, scene && game.scenes[scene] ? scene : null, sub === undefined);
    const assets = images.status(game);
    return sub === 'assets' ? assets : { game, tree: await store.loadTree(gid), assets };
  }
  throw { code: 'http', params: { status: 404 } };
}

// Same contract as api.job: onEvent gets every event (final included); done resolves with the final event
export function job(url, body, onEvent) {
  const ctrl = new AbortController();
  const done = (async () => {
    await ready;
    let final = null;
    const emit = (ev) => {
      if (ctrl.signal.aborted) return;
      if (ev.type === 'final') final = ev;
      onEvent(ev);
    };
    const parts = new URL(url, location.href).pathname.split('/api/')[1].split('/');
    try {
      if (parts[0] === 'games' && parts.length === 1) {
        const game = await turns.createGame(body, emit, conn(), ctrl.signal);
        if (game.batch) await batch.start(game.id);
      }
      else if (parts[0] === 'games' && parts[2] === 'turn') {
        await store.loadGame(parts[1]);
        await turns.runTurn(parts[1], body.parent_id ?? null, body.input || {}, emit, conn(), ctrl.signal);
      } else throw { code: 'http', params: { status: 404 } };
    } catch (e) {
      if (ctrl.signal.aborted) throw { code: 'cancelled' };
      throw e;
    }
    if (!final) throw { code: 'dropped' };
    return final;
  })();
  return { done, cancel: async () => ctrl.abort() };
}
