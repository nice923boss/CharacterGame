// Progress download and folder import for the browser build. The zip mirrors the server's saves/ folder
// (games/<id>/game.json, tree.json, assets/..., slots.json, autosave.json), so either side can read it.
import * as store from './store.js';
import * as images from './images.js';
import { ready } from './backend.js';

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

// Builds the zip and starts the browser download; resolves with { games, files }.
// onProgress(pct) runs after each file (by file count; demo images may still come over the network)
export async function exportProgress(onProgress = () => {}) {
  await ready;
  const entries = [];
  const games = await store.listGames();
  const pathsOf = new Map(games.map((g) => [g.id, store.filePaths().filter((p) => p.startsWith(`${g.id}/`)).sort()]));
  const total = games.reduce((n, g) => n + 2 + pathsOf.get(g.id).length, 2);
  const add = (name, bytes) => {
    entries.push({ name, bytes, crc: crc32(bytes) });
    onProgress(Math.min(99, Math.floor((entries.length * 100) / total)));
  };
  for (const g of games) {
    add(`saves/games/${g.id}/game.json`, jsonBytes(await store.loadGame(g.id)));
    add(`saves/games/${g.id}/tree.json`, jsonBytes(await store.loadTree(g.id)));
    for (const path of pathsOf.get(g.id)) {
      const blob = await store.fileBlob(path);
      add(`saves/games/${path}`, new Uint8Array(await blob.arrayBuffer()));
    }
  }
  add('saves/slots.json', jsonBytes(await store.loadSlots()));
  const auto = await store.loadAutosave();
  if (auto) add('saves/autosave.json', jsonBytes(auto));
  const stamp = store.nowIso().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip(entries));
  a.download = `chienzhi-saves-${stamp}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { games: games.length, files: entries.length };
}

// ---------- folder import ----------

// Only finished images and sprite metadata; .raw intermediates and anything else are left out
const KEEP = /^assets\/(scenes\/[^/.]+\.png|sprites\/[^/]+\/([^/.]+\.png|meta\.json))$/;

// files: the FileList of an <input webkitdirectory>. Resolves with { games, slots, autosave }.
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
    let game; let tree;
    try {
      game = JSON.parse(await byPath.get(path).text());
      tree = treeFile ? JSON.parse(await treeFile.text()) : null;
    } catch (e) {
      console.warn('skip unreadable story folder', base, e);
      continue;
    }
    if (game?.id !== gid || !tree?.nodes) { console.warn('skip story folder without a matching game/tree', base); continue; }
    images.forget(gid);
    for (const p of store.filePaths()) if (p.startsWith(`${gid}/`)) await store.deleteFile(p);
    for (const x of all) {
      const rel = x.path.startsWith(base) ? x.path.slice(base.length) : null;
      if (rel && KEEP.test(rel)) await store.putFile(`${gid}/${rel}`, x.f);
    }
    await store.saveTree(gid, tree);
    await store.saveGame(game);
    imported.push({ gid, root: m[1] });
  }
  // slots.json / autosave.json sit two levels above a story (saves/games/<id>/): take them when present
  const roots = new Set(imported.map((x) => x.root.replace(/games\/$/, '')));
  let slotCount = 0;
  let autosave = false;
  for (const root of roots) {
    const known = new Set((await store.listGames()).map((g) => g.id));
    const slotFile = byPath.get(`${root}slots.json`);
    if (slotFile) {
      try {
        const incoming = JSON.parse(await slotFile.text());
        const slots = await store.loadSlots();
        for (const s of Array.isArray(incoming) ? incoming : []) {
          if (s && known.has(s.game_id) && s.slot >= 0 && s.slot < store.SLOT_COUNT) { slots[s.slot] = s; slotCount += 1; }
        }
        await store.putSlots(slots);
      } catch (e) { console.warn('slots.json unreadable', e); }
    }
    const autoFile = byPath.get(`${root}autosave.json`);
    if (autoFile) {
      try {
        const a = JSON.parse(await autoFile.text());
        if (a && known.has(a.game_id)) {
          await store.setAutosave(a.game_id, a.node_id, a.scene_id);
          autosave = true;
        }
      } catch (e) { console.warn('autosave.json unreadable', e); }
    }
  }
  return { games: imported.length, slots: slotCount, autosave };
}
