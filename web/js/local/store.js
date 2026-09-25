// Browser port of server/story_store.py: games, trees, images, slots and autosave in IndexedDB.
// An image record is { blob, v } for pictures drawn here, or { href, v } for the bundled demo files,
// which stay on the static site until exported.

const DB_NAME = 'charactergame';
export const SLOT_COUNT = 10;

let dbPromise = null;
const files = new Map();      // path "gid/assets/..." -> { href?, blob?, v }; mirrors the files store
const urls = new Map();       // path -> object URL handed to the page (revoked when the file changes)

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const name of ['games', 'trees', 'files', 'kv']) req.result.createObjectStore(name);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
  });
}

const idbGet = (store, key) => tx(store, 'readonly', (s) => s.get(key));
const idbPut = (store, key, value) => tx(store, 'readwrite', (s) => s.put(value, key));
const idbDel = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));
const idbAll = (store) => tx(store, 'readonly', (s) => s.getAll());

export async function openStore() {
  const d = await db();
  await new Promise((resolve, reject) => {
    const req = d.transaction('files').objectStore('files').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { resolve(); return; }
      files.set(cur.key, cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export const kvGet = (key) => idbGet('kv', key);
export const kvPut = (key, value) => idbPut('kv', key, value);

export function nowIso() {
  const d = new Date();
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:` +
    `${p(d.getSeconds())}${off >= 0 ? '+' : '-'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

export const safeId = (gid) => typeof gid === 'string' && /^[A-Za-z0-9_]+$/.test(gid);

// ---------- games ----------

export async function newGameId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  let gid = `g_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  while (await idbGet('games', gid)) gid += 'x';
  return gid;
}

export const saveGame = (game) => idbPut('games', game.id, game);

export async function loadGame(gid) {
  const game = safeId(gid) ? await idbGet('games', gid) : null;
  if (!game) throw { code: 'game_not_found' };
  return game;
}

export async function loadTree(gid) {
  return (await idbGet('trees', gid)) || { root: null, next: 0, nodes: {} };
}

export const saveTree = (gid, tree) => idbPut('trees', gid, tree);

export async function listGames() {
  const games = (await idbAll('games')).sort((a, b) => (a.id < b.id ? 1 : -1));
  const out = [];
  for (const g of games) {
    const tree = await loadTree(g.id);
    const ids = Object.keys(tree.nodes).sort();
    out.push({
      id: g.id, title: g.title || '', created_at: g.created_at, nodes: ids.length,
      thumb: await thumb(g.id, g.first_scene), characters: (g.characters || []).map((c) => c.name),
      lang: g.lang || 'zh', latest: ids.length ? ids[ids.length - 1] : null, root: tree.root, batch: g.batch || null,
    });
  }
  return out;
}

export async function deleteGame(gid) {
  await loadGame(gid);
  const slots = (await loadSlots()).map((s) => (s && s.game_id === gid ? null : s));
  await idbPut('kv', 'slots', slots);
  const auto = await loadAutosave();
  if (auto && auto.game_id === gid) await idbDel('kv', 'autosave');
  for (const path of [...files.keys()]) if (path.startsWith(`${gid}/`)) await deleteFile(path);
  await idbDel('trees', gid);
  await idbDel('games', gid);
}

// ---------- tree ----------

export async function addNode(gid, node) {
  const tree = await loadTree(gid);
  const nid = `n_${String(tree.next).padStart(4, '0')}`;
  const full = { ...node, id: nid, children: [], created_at: nowIso() };
  if (full.parent == null) {
    if (tree.root !== null) throw new Error('tree already has a root');
    tree.root = nid;
  } else {
    tree.nodes[full.parent].children.push(nid);
  }
  tree.nodes[nid] = full;
  tree.next += 1;
  await saveTree(gid, tree);
  return full;
}

export function pathTo(tree, nodeId) {
  const path = [];
  while (nodeId) {
    const node = tree.nodes[nodeId];
    path.push(node);
    nodeId = node.parent;
  }
  return path.reverse();
}

// ---------- files ----------

export const hasFile = (path) => files.has(path);
export const fileVersion = (path) => files.get(path)?.v ?? 0;
export const filePaths = () => [...files.keys()];

export async function putFile(path, blob) {
  const rec = { blob, v: Date.now() };
  await idbPut('files', path, rec);
  dropUrl(path);
  files.set(path, rec);
}

// A file that stays on the static site (bundled demo); fetched only when exported
export async function putHref(path, href) {
  const rec = { href, v: 1 };
  await idbPut('files', path, rec);
  dropUrl(path);
  files.set(path, rec);
}

export async function deleteFile(path) {
  await idbDel('files', path);
  dropUrl(path);
  files.delete(path);
}

function dropUrl(path) {
  const u = urls.get(path);
  if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
  urls.delete(path);
}

export function fileUrl(path) {
  const rec = files.get(path);
  if (!rec) return null;
  if (!urls.has(path)) urls.set(path, rec.href || URL.createObjectURL(rec.blob));
  return urls.get(path);
}

export async function fileBlob(path) {
  const rec = files.get(path);
  if (!rec) return null;
  if (rec.blob) return rec.blob;
  const res = await fetch(rec.href);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${rec.href}`);
  return res.blob();
}

export async function readJsonFile(path) {
  const blob = await fileBlob(path);
  return blob ? JSON.parse(await blob.text()) : null;
}

export const scenePath = (gid, sid) => `${gid}/assets/scenes/${sid}.png`;
export const spritePath = (gid, cid, expr) => `${gid}/assets/sprites/${cid}/${expr}.png`;
export const metaPath = (gid, cid) => `${gid}/assets/sprites/${cid}/meta.json`;

export async function thumb(gid, sid) {
  return sid ? fileUrl(scenePath(gid, sid)) : null;
}

// ---------- slots ----------

export async function loadSlots() {
  const slots = (await idbGet('kv', 'slots')) || [];
  return [...slots, ...Array(SLOT_COUNT).fill(null)].slice(0, SLOT_COUNT);
}

export async function saveSlot(slot, gid, nodeId, label) {
  if (!(slot >= 0 && slot < SLOT_COUNT)) throw { code: 'save_failed' };
  const tree = await loadTree(gid);
  if (!tree.nodes[nodeId]) throw { code: 'save_failed' };
  const slots = await loadSlots();
  slots[slot] = { slot, game_id: gid, node_id: nodeId, label, scene_id: tree.nodes[nodeId].scene_id, saved_at: nowIso() };
  await idbPut('kv', 'slots', slots);
  return slots;
}

export async function deleteSlot(slot) {
  const slots = await loadSlots();
  slots[slot] = null;
  await idbPut('kv', 'slots', slots);
  return slots;
}

export const setAutosave = (gid, nodeId, sceneId) =>
  idbPut('kv', 'autosave', { game_id: gid, node_id: nodeId, scene_id: sceneId, saved_at: nowIso() });

export async function loadAutosave() {
  return (await idbGet('kv', 'autosave')) || null;
}

export const putSlots = (slots) => idbPut('kv', 'slots', slots);
