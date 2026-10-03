// Browser build upkeep: storage persistence and usage in settings (F01, F02), the backup reminder on the title
// screen (F04), the notice when another tab upgrades the database (F05) and the new-version notice (F06).
import { t } from './i18n.js?v=35d64fef8e0b';
import { $, toast } from './ui.js?v=35d64fef8e0b';

const STORAGE_WARN = 0.8;    // share of the quota that triggers the "export or delete" hint
const BACKUP_DAYS = 7;       // remind when the last download is this old...
const BACKUP_TURNS = 30;     // ...or this many turns were written since
const UPDATE_RETRY_MS = 5000;

const size = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

// A notice that stays until closed, with one button
function notice(id, text, label, onClick) {
  const box = document.createElement('span');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn tiny';
  btn.textContent = label;
  btn.onclick = () => { btn.disabled = true; onClick(); };
  box.append(text, btn);
  toast(box, false, 0, { id });
}

let storageWarned = false;
export async function paintStorage() {
  const line = $('#set-storage');
  if (!navigator.storage?.estimate) { line.textContent = t('upkeep.noEstimate'); return; }
  let usage, quota, persisted;
  try {
    [{ usage = 0, quota = 0 }, persisted] = await Promise.all([navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : false]);
  } catch (e) { console.warn('storage estimate failed', e); line.textContent = t('upkeep.noEstimate'); return; }
  const pct = quota ? Math.round((usage / quota) * 100) : 0;
  const full = quota > 0 && usage / quota >= STORAGE_WARN;
  line.textContent = t('upkeep.storage', { used: size(usage), quota: size(quota), pct }) +
    t(persisted ? 'upkeep.persisted' : 'upkeep.notPersisted');
  $('#set-storage-warn').hidden = !full;
  $('#set-storage-warn').textContent = full ? t('upkeep.storageWarn', { pct }) : '';
  if (full && !storageWarned) {
    storageWarned = true;
    toast(t('upkeep.storageWarn', { pct }), false, 10000, { id: 'storage' });
  }
}

export async function paintBackup() {
  const line = $('#backup-line');
  let info;
  try { info = await (await import('./local/archive.js?v=35d64fef8e0b')).backupInfo(); } catch (e) {
    console.warn('backup info unavailable', e);
    line.hidden = true;
    return;
  }
  const exportBtn = $('#scr-title [data-act="exportZip"]');
  if (!info.games) { line.hidden = true; exportBtn.classList.remove('remind'); return; }   // only the demo: nothing to lose yet
  const b = info.backup;
  const days = b ? Math.floor((Date.now() - Date.parse(b.at)) / 864e5) : 0;
  const added = b ? Math.max(0, info.turns - b.turns) : 0;
  let text = !b ? t('upkeep.backupNever') : days ? t('upkeep.backupDays', { days }) : t('upkeep.backupToday');
  if (added) text += t('upkeep.backupNew', { n: added });
  // The reminder lights up the menu's own download button, which is the one-click export
  const remind = !b || days >= BACKUP_DAYS || added >= BACKUP_TURNS;
  line.textContent = text;
  line.classList.toggle('remind', remind);
  exportBtn.classList.toggle('remind', remind);
  line.hidden = false;
}

// store.js closes its connection when another tab opens a newer database version
export function watchStore() {
  window.addEventListener('cg-store', (e) => {
    const key = e.detail === 'blocked' ? 'upkeep.dbBlocked' : 'upkeep.dbClosed';
    notice('store', t(key), t('upkeep.reload'), () => location.reload());
  });
}

// A new service worker waits instead of taking over; the notice waits until no turn is being written (F06)
export function watchUpdate(reg, busy) {
  const sw = navigator.serviceWorker;
  let asked = false;
  const offer = (worker) => {
    if (busy()) { setTimeout(() => offer(worker), UPDATE_RETRY_MS); return; }
    notice('update', t('upkeep.update'), t('upkeep.reload'), () => {
      asked = true;
      // Another tab may have switched already: then a reload alone picks up the new version
      if (worker.state === 'installed') worker.postMessage('skip-waiting'); else location.reload();
    });
  };
  if (reg.waiting && sw.controller) offer(reg.waiting);
  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && sw.controller) offer(worker); });
  });
  // The first install also changes the controller (clients.claim); only a requested switch reloads
  sw.addEventListener('controllerchange', () => {
    if (asked) location.reload();
  });
  // A tab left open for days still hears about new versions when the player comes back to it
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reg.update().catch((e) => console.warn('service worker update check failed', e));
  });
}
