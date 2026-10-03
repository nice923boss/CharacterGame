// Browser-side stand-in for server/main.py on GitHub Pages: the same /api routes and job events, backed by
// IndexedDB and the player's own NVIDIA key and relay (both kept in this browser's localStorage only).
import { DATA } from './data.js';
import * as store from './store.js';
import * as images from './images.js';
import * as turns from './turns.js';
import * as batch from './batch.js';
import * as llm from './llm.js';
import { hint, probe, relayState, remember, verdict } from './check.js';
import { analyzeNovel } from './novel.js';
import { loadOpenCC } from './story.js';

const KEY = 'cg-nvidia-key';
const RELAY = 'cg-relay';
const MODE = 'cg-image-mode';
const KEY_AT = 'cg-nvidia-key-at';

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
  images.init(conn, lsGet(MODE) || 'all');
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

// What the page may know about the saved key: a masked hint, the saved date and the last test result
const keyInfo = () => {
  const key = lsGet(KEY);
  return { key_hint: hint(key), key_saved_at: lsGet(KEY_AT) || null, key_check: key ? verdict() : null };
};

const health = () => ({
  comfy: false, nvidia_image: !!conn().key, engines: ['nvidia'], local: true, relay: !!conn().relay,
  relay_default: !lsGet(RELAY) && !!DATA.relay,
  models: DATA.llm.candidates.map((c) => c.label), demo: DATA.demo, ...keyInfo(),
});

export async function request(method, url, body) {
  await ready;
  const u = new URL(url, location.href);
  const parts = u.pathname.slice(u.pathname.indexOf('/api/') + 5).split('/');
  const scene = u.searchParams.get('scene');
  const [a, gid, sub, act] = parts;
  if (method === 'GET' && a === 'health') return health();
  if (method === 'GET' && a === 'stats') return llm.stats();
  if (a === 'settings' && !gid) {
    if (method === 'POST' && DATA.art.IMAGE_MODES.includes(body?.image_mode)) {
      lsSet(MODE, body.image_mode);
      images.setMode(body.image_mode);
    }
    return { image_nvidia: true, image_comfy: false, image_mode: lsGet(MODE) || 'all', relay: lsGet(RELAY),
             relay_default: DATA.relay || '' };
  }
  if (a === 'settings' && gid === 'nvidia_key') {
    // One tiny request first (B01): a key NVIDIA rejects is not saved; busy or unreachable still saves
    const key = validKey(body?.key);
    const check = await probe('text', { ...conn(), key });
    if (check.state === 'key_rejected') throw { code: 'key_rejected' };
    lsSet(KEY, key);
    lsSet(KEY_AT, new Date().toISOString());
    remember([check]);
    return { nvidia_key: true, check, ...keyInfo() };
  }
  if (a === 'settings' && gid === 'check') {
    const c = conn();
    if (!c.key) throw { code: 'no_key' };
    const [text, image] = await Promise.all([probe('text', c), probe('image', c)]);
    remember([text, image]);
    return { text, image, ...keyInfo() };
  }
  if (a === 'settings' && gid === 'relay') {
    // Saving the built-in address (or an empty field) keeps following the built-in relay, always allowed.
    // A relay of the player's own that does not answer, or refuses this site, is not saved (B07)
    const r = validRelay(body?.relay);
    const relay = r || DATA.relay || '';
    if (r && r !== DATA.relay) {
      const state = await relayState(r);
      if (state !== 'ok') throw { code: state === 'relay_origin' ? 'relay_origin' : 'relay_unreachable' };
    }
    lsSet(RELAY, r === DATA.relay ? '' : r);
    return { relay };
  }
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
    // Polling only moves this game's images first while the player looks at this tab (focus=1)
    if (sub === undefined || u.searchParams.get('focus')) images.setActive(gid);
    images.ensureGame(game, scene && game.scenes[scene] ? scene : null, sub === undefined);
    const assets = images.status(game);
    return sub === 'assets' ? assets : { game, tree: await store.loadTree(gid), assets };
  }
  if (a === 'games' && sub === 'assets' && method === 'POST' && act === 'retry') {
    const game = await store.loadGame(gid);
    images.setActive(gid);
    images.ensureGame(game, scene && game.scenes[scene] ? scene : null, true);
    return images.status(game);
  }
  if (a === 'games' && sub === 'assets' && method === 'POST' && act === 'redraw') {
    const game = await store.loadGame(gid);
    const { kind, target } = body || {};
    if (!((kind === 'scene' && game.scenes[target]) || (kind === 'sprite' && game.characters.some((c) => c.id === target)))) {
      throw { code: 'bad_target' };
    }
    if ((lsGet(MODE) || 'all') === 'off') throw { code: 'images_off' };
    images.setActive(gid);
    if (!(await images.redraw(game, kind, target, body.new_seed !== false))) throw { code: 'drawing' };
    return images.status(game);
  }
  throw { code: 'http', params: { status: 404 } };
}

// Same contract as api.job: onEvent gets every event (final included); done resolves with the final event
export function job(url, body, onEvent) {
  const ctrl = new AbortController();
  const skip = { on: false };   // "retry now": ends the current countdown
  const jobConn = () => ({ ...conn(), waits: { ...(body.waits || {}), skip } });
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
        // While a turn is written only the background on screen is drawn, so the text gets the requests
        const game = await images.textTurn(() => turns.createGame(body, emit, jobConn(), ctrl.signal));
        if (game.batch) await batch.start(game.id);
      }
      else if (parts[0] === 'games' && parts[2] === 'turn') {
        await store.loadGame(parts[1]);
        await images.textTurn(() => turns.runTurn(parts[1], body.parent_id ?? null, body.input || {}, emit, jobConn(), ctrl.signal));
      }
      else if (parts[0] === 'novel' && parts[1] === 'analyze') await analyzeNovel(body, emit, jobConn(), ctrl.signal);
      else throw { code: 'http', params: { status: 404 } };
    } catch (e) {
      if (ctrl.signal.aborted) throw { code: 'cancelled' };
      throw e;
    }
    if (!final) throw { code: 'dropped' };
    return final;
  })();
  return { done, cancel: async () => ctrl.abort(), retryNow: async () => { skip.on = true; } };
}
