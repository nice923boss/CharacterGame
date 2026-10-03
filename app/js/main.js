// Entry point: screen switching, title menu, toolbar and settings wiring.
import { LOCAL, activeJobs, get, post } from './api.js?v=35d64fef8e0b';
import { applyStatic, setLang, t } from './i18n.js?v=35d64fef8e0b';
import { sound } from './sound.js?v=35d64fef8e0b';
import { createStage } from './stage.js?v=35d64fef8e0b';
import { $, bindSettings, confirmBox, openModal, progress, reloadSettings, toast, toastError } from './ui.js?v=35d64fef8e0b';
import { initSetup, isBatchMode, resetSetup, startGame } from './setup.js?v=35d64fef8e0b';
import { currentGameId, enterGame, initGame, leaveGame, openSlots, openTree } from './game.js?v=35d64fef8e0b';
import { openStories } from './stories.js?v=35d64fef8e0b';
import { openLog } from './playaids.js?v=35d64fef8e0b';
import { batchActive, initBatches, refreshBatches, requestNotifyPermission } from './batch.js?v=35d64fef8e0b';
import { demoGame, enable, initConnect, keyNowText, openOnboard } from './connect.js?v=35d64fef8e0b';
import { paintBackup, paintStorage, watchStore, watchUpdate } from './upkeep.js?v=35d64fef8e0b';

document.documentElement.classList.toggle('local', LOCAL);
const stage = createStage($('#canvas-host'));

function showScreen(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

async function toTitle() {
  leaveGame();
  stage.setCast([]);
  stage.setScene(null, { transition: true });
  stage.setPending(false);
  sound.setMood('mysterious');
  showScreen('scr-title');
  refreshBatches();
  refreshHealth();   // the key test result expires after 10 minutes (B05)
  await refreshContinue();
}

async function refreshContinue() {
  const auto = await get('/api/autosave').catch(() => null);
  $('#scr-title [data-act="continue"]').disabled = !auto;
  if (LOCAL) paintBackup();   // the backup line counts the same stories, so it changes whenever "continue" may
}

async function play(gid, nodeId) {
  leaveGame();
  showScreen('scr-game');
  if (!(await enterGame(stage, gid, nodeId, toTitle))) toTitle();
}

function newStory() { resetSetup(); showScreen('scr-setup'); }

const actions = {
  async continue() {
    const auto = await get('/api/autosave').catch(() => null);
    if (auto) play(auto.game_id, auto.node_id);
  },
  new() { if (needsKey()) openOnboard(); else newStory(); },
  demo() { if ($('#title-demo').dataset.gid) play($('#title-demo').dataset.gid, null); },
  load() { openSlots('load', play); },
  stories() { openStories(refreshContinue, play); },
  settings() {
    if (LOCAL) paintStorage();
    openModal('#mdl-settings');
  },
  back() { toTitle(); },
  save() { openSlots('save'); },
  tree() { openTree(); },
  log() { openLog(); },
  async title() {
    if (await confirmBox(t('game.toTitle'), t('game.toTitleOk'))) toTitle();
  },
  importDir() { $('#import-dir').click(); },
  async exportZip() {
    const show = (pct) => toast(t('archive.exporting', { pct }), false, 60000, { id: 'archive' });
    show(0);
    try {
      const r = await (await import('./local/archive.js?v=35d64fef8e0b')).exportProgress(show);
      toast(t('archive.exported', r), false, 4000, { id: 'archive' });
      paintBackup();
    } catch (e) { console.error(e); toast(t('err.local_internal'), true, 0, { id: 'archive' }); }
  },
};

document.addEventListener('click', (e) => {
  sound.unlock();
  const btn = e.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  sound.play('click');
  actions[btn.dataset.act]?.();
}, true);

$('#setup-start').onclick = async () => {
  if (isBatchMode()) requestNotifyPermission();
  $('#setup-start').disabled = true;
  const game = await startGame();
  $('#setup-start').disabled = false;
  if (!game) return;
  if (!game.batch) { play(game.id, null); return; }
  // Batch: the tree is written in the background, the player's branch first; play starts once the opening is written
  const root = await waitOpening(game.id);
  if (root) {
    play(game.id, root);
    toast(t(LOCAL ? 'batch.playingLocal' : 'batch.playing', { title: game.title }), false, 8000);
    return;
  }
  await toTitle();
  toast(t(LOCAL ? 'batch.startedLocal' : 'batch.started', { title: game.title }), false, 8000);
};

const OPENING_POLL_MS = 1500;

// Resolves with the opening node id, or null when the player stops waiting or the batch stopped before writing it
async function waitOpening(gid) {
  let waiting = true;
  const box = progress(t('batch.opening'), t('batch.openingSub'), () => { waiting = false; });
  try {
    while (waiting) {
      const g = (await get('/api/games').catch(() => [])).find((x) => x.id === gid);
      if (g?.root) return waiting ? g.root : null;
      const b = (await get('/api/batches').catch(() => [])).find((x) => x.id === gid);
      if (b && !['running', 'images'].includes(b.state)) return null;
      await new Promise((resolve) => { setTimeout(resolve, OPENING_POLL_MS); });
    }
    return null;
  } finally {
    box.close();
  }
}

// The relay's daily allowance is 80% used (J03): say so once per page load, it stays until closed
if (LOCAL) window.addEventListener('cg-relay-quota', () => toast(t('relay.quotaNear'), false, 0), { once: true });

// Reloading or closing now would cut off a turn; the browser build's batch would pause too (the server's goes on)
window.addEventListener('beforeunload', (e) => {
  if (activeJobs() > 0 || (LOCAL && batchActive())) { e.preventDefault(); e.returnValue = ''; }
});

bindSettings((s) => {
  sound.setVolumes(s.bgm / 100, s.sfx / 100);
  stage.setWeatherOn(s.weather);
  const root = document.documentElement;
  root.classList.toggle('font-s', s.font === 's');
  root.classList.toggle('font-l', s.font === 'l');
  root.classList.toggle('hc', s.contrast);
});

let health;   // undefined: not answered yet, false: server down
// The browser build has nothing to write with until a key is saved; the server build may have a local model
const needsKey = () => LOCAL && health && !health.key_hint;
const KEY_STATE = { valid: 'health.keyValid', rejected: 'health.keyRejected' };
function paintHealth() {
  if (health === undefined) return;
  if (!health) { $('#health').classList.add('error'); $('#health').textContent = t('health.down'); return; }
  $('#set-key-now').textContent = keyNowText(health);
  if (needsKey()) {
    // Nothing is wrong yet: the demo plays without a key, which is only asked for when writing (H06)
    $('#health').classList.remove('error');
    $('#health').textContent = t('health.firstRun');
  } else {
    // The key state comes from the last explicit test (save or test button), not from turns (B05)
    const ok = { nvidia: health.nvidia_image && health.key_check !== 'rejected', comfy: health.comfy };
    const key = health.key_hint ? KEY_STATE[health.key_check] || 'health.keyUntested' : 'health.noKey';
    const state = { nvidia: key, comfy: ok.comfy ? 'health.on' : 'health.off' };
    const usable = health.engines.some((e) => ok[e]);
    $('#health').classList.toggle('error', !usable);
    $('#health').textContent = t('health.images', {
      list: health.engines.map((e) => t('health.engine', { name: t(`engine.${e}`), state: t(state[e]) })).join(' → '),
    }) + (usable ? '' : t('health.noImage'));
  }
  const list = health.models.map((m) => t(`model.${m}`)).join(' → ');
  $('#set-models').textContent = health.local
    ? t('health.localModels', { list, relay: t(health.relay_default ? 'health.relayDefault' : health.relay ? 'health.relay' : 'health.noRelay') }) : t('health.models', { list });
}

function switchLang(code) { setLang(code); paintHealth(); paintBusy(); refreshBatches(); if (LOCAL) paintBackup(); }
document.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => switchLang(b.dataset.lang); });

applyStatic();
initGame();
initSetup().catch((e) => toast(t('setup.presetFail', { msg: e.message }), true));
toTitle();
initBatches(async (gid) => {
  const games = await get('/api/games').catch(() => []);
  const g = games.find((x) => x.id === gid);
  if (g?.root) play(gid, g.root);
}, currentGameId);

// Resolves with the new health (false: server down)
function refreshHealth() {
  return get('/api/health').then((h) => { health = h; }).catch(() => { health = false; })
    .then(() => { paintHealth(); paintDemo(); return health; });
}

// First run in the browser build: the demo button leads the title menu (H06)
async function paintDemo() {
  const gid = needsKey() ? await demoGame(health) : null;
  $('#title-demo').hidden = !gid;
  $('#title-demo').dataset.gid = gid || '';
}

initConnect({ refreshHealth, play: (gid) => play(gid, null), newStory });

// NVIDIA busy light from the last 5 minutes of requests: a line on the title screen, a dot in the game toolbar (A16)
const BUSY_POLL_MS = 15000;
let busy = null;
let busyWas = '';
function busyText() {
  const label = t(`busy.${busy.level}`);
  if (!busy.requests) return label;
  const avg = busy.avg_first_s != null ? t('busy.avg', { s: busy.avg_first_s }) : '';
  return label + t('busy.detail', { requests: busy.requests, busy: busy.busy, avg });
}
function paintBusy() {
  if (!busy) return;
  const text = busyText();
  $('#busy').hidden = false;
  $('#busy').dataset.level = busy.level;
  $('#busy span').textContent = text;
  $('#busy-dot').hidden = false;
  $('#busy-dot').dataset.level = busy.level;
  $('#busy-dot').title = text;
  $('#busy-dot').setAttribute('aria-label', text);
  if (busy.level === 'red' && busyWas !== 'red' && !$('#scr-game').hidden) toast(t('busy.redToast'), false, 8000, { id: 'busy' });
  busyWas = busy.level;
}
async function refreshBusy() {
  if (document.hidden) return;
  try { busy = (await get('/api/stats')).recent; } catch (e) { console.warn('busy stats unavailable', e); return; }
  paintBusy();
}
$('#busy-dot').addEventListener('click', () => { if (busy) toast(busyText(), false, 6000, { id: 'busy' }); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBusy(); });
setInterval(refreshBusy, BUSY_POLL_MS);
refreshBusy();

// Image engines and the image mode live on the server: background batches draw with them too
async function bindImageEngines() {
  const boxes = { image_nvidia: $('#set-img-nvidia'), image_comfy: $('#set-img-comfy') };
  const mode = $('#set-img-mode');
  let current;
  try { current = await get('/api/settings'); } catch {
    [...Object.values(boxes), mode].forEach((el) => { el.disabled = true; });
    return;
  }
  const paint = () => {
    Object.entries(boxes).forEach(([k, el]) => { el.checked = current[k]; });
    mode.value = current.image_mode || 'all';
  };
  paint();
  mode.addEventListener('change', async () => {
    try { current = await post('/api/settings', { image_mode: mode.value }); } catch (e) { toastError(e); }
    paint();
  });
  for (const [k, el] of Object.entries(boxes)) {
    el.addEventListener('change', async () => {
      try {
        current = await post('/api/settings', { [k]: el.checked });
        refreshHealth();
      } catch (e) { toastError(e); }
      paint();
    });
  }
}
bindImageEngines();

// ---------- browser-only (GitHub Pages) build ----------

if (LOCAL) {
  watchStore();
  paintStorage();
  get('/api/settings').then((s) => {
    $('#set-relay').value = s.relay || s.relay_default || '';
    if (s.relay_default) $('#set-relay').placeholder = t('settings.relayBuiltin', { url: s.relay_default });
  }).catch(() => {});
  // The relay is tried once before saving; one that does not answer or refuses this site is not saved (B07)
  $('#set-relay-save').addEventListener('click', async () => {
    $('#set-relay-save').disabled = true;
    toast(t('settings.relayTesting'), false, 30000, { id: 'relay' });
    try {
      const r = await post('/api/settings/relay', { relay: $('#set-relay').value });
      $('#set-relay').value = r.relay;
      toast(t('settings.relaySaved'), false, 4000, { id: 'relay' });
      refreshHealth();
    } catch (e) { toast(e.message + t('settings.notSaved'), true, 0, { id: 'relay', code: e.code }); }
    enable($('#set-relay-save'));
  });
  $('#set-demo').addEventListener('click', async () => {
    if (!(await confirmBox(t('settings.demoAsk'), t('common.ok')))) return;
    try {
      await (await import('./local/backend.js?v=35d64fef8e0b')).restoreDemo();
      toast(t('settings.demoDone'));
      refreshContinue();
    } catch (e) { console.error(e); toast(t('err.local_internal'), true); }
  });
  $('#set-diag').addEventListener('click', async () => {
    try {
      await (await import('./local/archive.js?v=35d64fef8e0b')).downloadDiag();
      toast(t('settings.diagDone'), false, 6000);
    } catch (e) { console.error(e); toast(t('err.local_internal'), true); }
  });
  $('#import-dir').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    toast(t('archive.importing'), false, 60000, { id: 'archive' });
    try {
      const r = await (await import('./local/archive.js?v=35d64fef8e0b')).importFolder(files);
      if (r.settings) {   // H07, first so the message below is in the restored language
        reloadSettings();
        if (r.settings.lang) switchLang(r.settings.lang);
        const s = await get('/api/settings');
        $('#set-relay').value = s.relay || s.relay_default || '';
        $('#set-img-mode').value = s.image_mode;
        refreshHealth();
      }
      const done = r.settings ? 'archive.importedAll' : 'archive.imported';
      toast(r.games ? t(done, r) : t('archive.none'), !r.games, 8000, { id: 'archive' });
      refreshContinue();
    } catch (err) { console.error(err); toast(t('err.local_internal'), true, 0, { id: 'archive' }); }
    e.target.value = '';
  });
  // Offline cache for the app shell and CDN libraries (sw.js is generated by tools/build_pages.py)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => watchUpdate(reg, () => activeJobs() > 0))
      .catch((e) => console.warn('service worker not registered', e));
  }
}
