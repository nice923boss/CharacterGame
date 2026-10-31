// Progress download and folder import for the browser build. The zip mirrors the server's saves/ folder
// (games/<id>/game.json, tree.json, assets/..., slots.json, autosaves.json), so either side can read it.
import * as store from './store.js';
import * as images from './images.js';
import { applyBrowserSettings, browserSettings, diagReport, ready } from './backend.js';
import { turnBusy } from './turns.js';
import { writingHere } from './batch.js';
import { DATA } from './data.js';

// Turns in the player's own stories (the bundled demo left out), for the backup reminder on the title screen
const ownTurns = (games) => games.filter((g) => g.id !== DATA.demo).reduce((n, g) => n + g.nodes, 0);
const ownGames = (games) => games.filter((g) => g.id !== DATA.demo).length;

// { games, turns, backup: { at, turns } | null }: the last download and how many turns there were then
export async function backupInfo() {
  await ready;
  const games = await store.listGames();
  return { games: ownGames(games), turns: ownTurns(games), backup: (await store.kvGet('backup')) || null };
}

// ---------- zip (stored, no compression: the files are already PNG) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// entries: [{ name, bytes: Uint8Array, crc }] -> Blob
function zip(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes, crc } of entries) {
    const nameBytes = enc.encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);   // UTF-8 names
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, bytes);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

const jsonBytes = (obj) => new TextEncoder().encode(JSON.stringify(obj, null, 1));

// Local date and time for file names, e.g. 20261004-0130
const fileStamp = () => store.nowIso().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

function saveFile(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// The file a player sends along with a problem report (J01)
export async function downloadDiag() {
  saveFile(new Blob([await diagReport()], { type: 'application/json' }), `chienzhi-diag-${fileStamp()}.json`);
}

// Builds the zip and starts the browser download; resolves with { games, files, skipped } (skipped: files that
// could not be read, such as a demo picture while offline).
// onProgress(pct) runs after each file (by file count; demo images may still come over the network)
export async function exportProgress(onProgress = () => {}) {
  await ready;
  const entries = [];
  const games = await store.listGames();
  const pathsOf = new Map(games.map((g) => [g.id, store.filePaths().filter((p) => p.startsWith(`${g.id}/`)).sort()]));
  const total = games.reduce((n, g) => n + 2 + pathsOf.get(g.id).length, 3);
  const add = (name, bytes) => {
    entries.push({ name, bytes, crc: crc32(bytes) });
    onProgress(Math.min(99, Math.floor((entries.length * 100) / total)));
  };
  let skipped = 0;
  for (const g of games) {
    add(`saves/games/${g.id}/game.json`, jsonBytes(await store.loadGame(g.id)));
    add(`saves/games/${g.id}/tree.json`, jsonBytes(await store.loadTree(g.id)));
    for (const path of pathsOf.get(g.id)) {
      // A bundled demo picture the network cannot bring (offline) is left out instead of failing the download;
      // a story missing a picture draws it again after import
      let blob;
      try { blob = await store.fileBlob(path); } catch (e) {
        console.warn('export: file left out', path, e);
        skipped += 1;
        continue;
      }
      add(`saves/games/${path}`, new Uint8Array(await blob.arrayBuffer()));
    }
  }
  add('saves/slots.json', jsonBytes(await store.loadSlots()));
  const autos = await store.loadAutosaves();
  if (autos.length) add('saves/autosaves.json', jsonBytes(autos));
  // Volume, speed, language, relay URL and image mode (H07); never the key
  add('saves/browser-settings.json', jsonBytes(browserSettings()));
  saveFile(zip(entries), `chienzhi-saves-${fileStamp()}.zip`);
  await store.kvPut('backup', { at: new Date().toISOString(), turns: ownTurns(games) });
  return { games: games.length, files: entries.length, skipped };
}

// ---------- folder import ----------

// Only finished images and sprite metadata; .raw intermediates and anything else are left out
const KEEP = /^assets\/(scenes\/[^/.]+\.png|sprites\/[^/]+\/([^/.]+\.png|meta\.json))$/;
const JSON_MAX_BYTES = 32 * 1024 * 1024;   // a game.json or tree.json larger than this is not read
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// game.json and tree.json with the shape the game reads: anything else would break the story when it is opened
export function validStory(game, tree, gid) {
  if (!isObj(game) || game.id !== gid) return false;
  if (!Array.isArray(game.characters) || !game.characters.every(isObj)) return false;
  if (!isObj(game.scenes) || !Object.values(game.scenes).every(isObj)) return false;
  if (!isObj(tree) || !isObj(tree.nodes) || !Number.isInteger(tree.next)) return false;
  const ids = Object.keys(tree.nodes);
  // Own keys only: "constructor" or "toString" must not pass as a node id
  const has = (id) => typeof id === 'string' && Object.hasOwn(tree.nodes, id);
  if (tree.root === null || tree.root === undefined) return ids.length === 0;
  if (!has(tree.root)) return false;
  return ids.every((id) => {
    const n = tree.nodes[id];
    if (!isObj(n) || !Array.isArray(n.children) || !n.children.every(has)) return false;
    return id === tree.root ? n.parent == null : has(n.parent);
  });
}

async function isPng(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return PNG_SIGNATURE.every((b, i) => head[i] === b);
}

// files: the FileList of an <input webkitdirectory>. Resolves with { games, slots, autosave, settings }
// (settings: what browser-settings.json changed, or null).
export async function importFolder(files) {
  await ready;
  const all = [...files].map((f) => ({ f, path: f.webkitRelativePath || f.name }));
  const byPath = new Map(all.map((x) => [x.path, x.f]));
  const imported = [];
  for (const { path } of all) {
    const m = path.match(/^(.*?)([A-Za-z0-9_]+)\/game\.json$/);
    if (!m || !store.safeId(m[2])) continue;
    const base = `${m[1]}${m[2]}/`;
    const gid = m[2];
    const treeFile = byPath.get(`${base}tree.json`);
    // A story this page is writing right now would be overwritten again by the turn in progress
    if (turnBusy(gid) || writingHere(gid)) { console.warn('skip story folder being written now', base); continue; }
    if (byPath.get(path).size > JSON_MAX_BYTES || treeFile?.size > JSON_MAX_BYTES) {
      console.warn('skip story folder with an oversized file', base);
      continue;
    }
    let game; let tree;
    try {
      game = JSON.parse(await byPath.get(path).text());
      tree = treeFile ? JSON.parse(await treeFile.text()) : null;
    } catch (e) {
      console.warn('skip unreadable story folder', base, e);
      continue;
    }
    if (!validStory(game, tree, gid)) { console.warn('skip story folder without a matching game/tree', base); continue; }
    images.forget(gid);
    for (const p of store.filePaths()) if (p.startsWith(`${gid}/`)) await store.deleteFile(p);
    for (const x of all) {
      const rel = x.path.startsWith(base) ? x.path.slice(base.length) : null;
      if (!rel || !KEEP.test(rel)) continue;
      // Pictures must really be PNG: anything else would only fail later, on screen
      if (rel.endsWith('.png') && !(await isPng(x.f))) { console.warn('skip file that is not a PNG', x.path); continue; }
      await store.putFile(`${gid}/${rel}`, x.f);
    }
    await store.saveTree(gid, tree);
    await store.saveGame(game);
    await store.untrash(gid);
    imported.push({ gid, root: m[1] });
  }
  // slots.json / autosaves.json (autosave.json before 2026-10) sit two levels above a story (saves/games/<id>/)
  const roots = new Set(imported.map((x) => x.root.replace(/games\/$/, '')));
  let slotCount = 0;
  let autosave = false;
  let settings = null;
  for (const root of roots) {
    const known = new Set((await store.listGames()).map((g) => g.id));
    // A slot or autosave must point at a node that exists in its story, or loading it fails later
    const trees = new Map();
    const hasNode = async (gid, nid) => {
      if (!known.has(gid) || typeof nid !== 'string') return false;
      if (!trees.has(gid)) trees.set(gid, await store.loadTree(gid));
      return Object.hasOwn(trees.get(gid).nodes, nid);
    };
    const slotFile = byPath.get(`${root}slots.json`);
    if (slotFile) {
      try {
        const incoming = JSON.parse(await slotFile.text());
        const slots = await store.loadSlots();
        for (const s of Array.isArray(incoming) ? incoming : []) {
          if (s && Number.isInteger(s.slot) && s.slot >= 0 && s.slot < store.SLOT_COUNT && await hasNode(s.game_id, s.node_id)) {
            slots[s.slot] = s;
            slotCount += 1;
          }
        }
        await store.putSlots(slots);
      } catch (e) { console.warn('slots.json unreadable', e); }
    }
    const autoFile = byPath.get(`${root}autosaves.json`) || byPath.get(`${root}autosave.json`);
    if (autoFile) {
      try {
        const data = JSON.parse(await autoFile.text());
        // Oldest first, so the newest ends up on top of the list
        for (const a of (Array.isArray(data) ? data : [data]).reverse()) {
          if (a && await hasNode(a.game_id, a.node_id)) {
            await store.setAutosave(a.game_id, a.node_id, a.scene_id);
            autosave = true;
          }
        }
      } catch (e) { console.warn(`${autoFile.name} unreadable`, e); }
    }
    const setFile = byPath.get(`${root}browser-settings.json`);
    if (setFile) {
      try { settings = applyBrowserSettings(JSON.parse(await setFile.text())) || settings; } catch (e) {
        console.warn('browser-settings.json unreadable', e);
      }
    }
  }
  return { games: imported.length, slots: slotCount, autosave, settings };
}
