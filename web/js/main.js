// Entry point: screen switching, title menu, toolbar and settings wiring.
import { LOCAL, get, post } from './api.js';
import { applyStatic, setLang, t } from './i18n.js';
import { sound } from './sound.js';
import { createStage } from './stage.js';
import { $, bindSettings, confirmBox, openModal, toast } from './ui.js';
import { initSetup, isBatchMode, resetSetup, startGame } from './setup.js';
import { enterGame, initGame, leaveGame, openSlots, openTree } from './game.js';
import { openStories } from './stories.js';
import { initBatches, refreshBatches, requestNotifyPermission } from './batch.js';

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
  await refreshContinue();
}

async function refreshContinue() {
  const auto = await get('/api/autosave').catch(() => null);
  $('#scr-title [data-act="continue"]').disabled = !auto;
}

async function play(gid, nodeId) {
  leaveGame();
  showScreen('scr-game');
  if (!(await enterGame(stage, gid, nodeId, toTitle))) toTitle();
}

const actions = {
  async continue() {
    const auto = await get('/api/autosave').catch(() => null);
    if (auto) play(auto.game_id, auto.node_id);
  },
  new() { resetSetup(); showScreen('scr-setup'); },
  load() { openSlots('load', play); },
  stories() { openStories(refreshContinue, play); },
  settings() { openModal('#mdl-settings'); },
  back() { toTitle(); },
  save() { openSlots('save'); },
  tree() { openTree(); },
  async title() {
    if (await confirmBox(t('game.toTitle'), t('game.toTitleOk'))) toTitle();
  },
  importDir() { $('#import-dir').click(); },
  async exportZip() {
    const show = (pct) => toast(t('archive.exporting', { pct }), false, 60000);
    show(0);
    try {
      const r = await (await import('./local/archive.js')).exportProgress(show);
      toast(t('archive.exported', r));
    } catch (e) { console.error(e); toast(t('err.local_internal'), true); }
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
  // Batch: the server writes the whole tree in the background; batch.js announces it when done
  await toTitle();
  toast(t(LOCAL ? 'batch.startedLocal' : 'batch.started', { title: game.title }), false, 8000);
};

bindSettings((s) => {
  sound.setVolumes(s.bgm / 100, s.sfx / 100);
  stage.setWeatherOn(s.weather);
});

let health;   // undefined: not answered yet, false: server down
function paintHealth() {
  if (health === undefined) return;
  if (!health) { $('#health').classList.add('error'); $('#health').textContent = t('health.down'); return; }
  const ok = { nvidia: health.nvidia_image, comfy: health.comfy };
  const state = { nvidia: ok.nvidia ? 'health.key' : 'health.noKey', comfy: ok.comfy ? 'health.on' : 'health.off' };
  const usable = health.engines.some((e) => ok[e]);
  $('#health').classList.toggle('error', !usable);
  $('#health').textContent = t('health.images', {
    list: health.engines.map((e) => t('health.engine', { name: t(`engine.${e}`), state: t(state[e]) })).join(' → '),
  }) + (usable ? '' : t('health.noImage'));
  const list = health.models.map((m) => t(`model.${m}`)).join(' → ');
  $('#set-models').textContent = health.local
    ? t('health.localModels', { list, relay: t(health.relay_default ? 'health.relayDefault' : health.relay ? 'health.relay' : 'health.noRelay') }) : t('health.models', { list });
}

document.querySelectorAll('[data-lang]').forEach((b) => {
  b.onclick = () => { setLang(b.dataset.lang); paintHealth(); refreshBatches(); };
});

applyStatic();
initGame();
initSetup().catch((e) => toast(t('setup.presetFail', { msg: e.message }), true));
toTitle();
initBatches(async (gid) => {
  const games = await get('/api/games').catch(() => []);
  const g = games.find((x) => x.id === gid);
  if (g?.root) play(gid, g.root);
});

const refreshHealth = () => get('/api/health').then((h) => { health = h; }).catch(() => { health = false; })
  .finally(paintHealth);
refreshHealth();

// Image engines live on the server: background batches draw with them too
async function bindImageEngines() {
  const boxes = { image_nvidia: $('#set-img-nvidia'), image_comfy: $('#set-img-comfy') };
  let current;
  try { current = await get('/api/settings'); } catch {
    Object.values(boxes).forEach((el) => { el.disabled = true; });
    return;
  }
  const paint = () => Object.entries(boxes).forEach(([k, el]) => { el.checked = current[k]; });
  paint();
  for (const [k, el] of Object.entries(boxes)) {
    el.addEventListener('change', async () => {
      try {
        current = await post('/api/settings', { [k]: el.checked });
        refreshHealth();
      } catch (e) { toast(e.message, true); }
      paint();
    });
  }
}
bindImageEngines();

// Write-only key field: the server keeps the key and only reports "key set" through the health line
$('#set-key-save').addEventListener('click', async () => {
  try {
    await post('/api/settings/nvidia_key', { key: $('#set-key').value });
    $('#set-key').value = '';
    toast(t('settings.keySaved'));
    refreshHealth();
  } catch (e) { toast(e.message, true); }
});

// ---------- browser-only (GitHub Pages) build ----------

if (LOCAL) {
  get('/api/settings').then((s) => {
    $('#set-relay').value = s.relay || '';
    if (s.relay_default) $('#set-relay').placeholder = t('settings.relayBuiltin', { url: s.relay_default });
  }).catch(() => {});
  $('#set-relay-save').addEventListener('click', async () => {
    try {
      const r = await post('/api/settings/relay', { relay: $('#set-relay').value });
      $('#set-relay').value = r.relay;
      toast(t('settings.relaySaved'));
      refreshHealth();
    } catch (e) { toast(e.message, true); }
  });
  $('#set-demo').addEventListener('click', async () => {
    if (!(await confirmBox(t('settings.demoAsk'), t('common.ok')))) return;
    try {
      await (await import('./local/backend.js')).restoreDemo();
      toast(t('settings.demoDone'));
      refreshContinue();
    } catch (e) { console.error(e); toast(t('err.local_internal'), true); }
  });
  $('#import-dir').addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    toast(t('archive.importing'), false, 60000);
    try {
      const r = await (await import('./local/archive.js')).importFolder(files);
      toast(r.games ? t('archive.imported', r) : t('archive.none'), !r.games, 8000);
      refreshContinue();
    } catch (err) { console.error(err); toast(t('err.local_internal'), true); }
    e.target.value = '';
  });
  // Offline cache for the app shell and CDN libraries (sw.js is generated by tools/build_pages.py)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker not registered', e));
  }
}
