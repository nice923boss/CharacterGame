// Entry point: screen switching, title menu, toolbar and settings wiring.
import { get } from './api.js';
import { applyStatic, setLang, t } from './i18n.js';
import { sound } from './sound.js';
import { createStage } from './stage.js';
import { $, bindSettings, confirmBox, openModal, toast } from './ui.js';
import { initSetup, isBatchMode, resetSetup, startGame } from './setup.js';
import { enterGame, initGame, leaveGame, openSlots, openTree } from './game.js';
import { openStories } from './stories.js';
import { initBatches, refreshBatches, requestNotifyPermission } from './batch.js';

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
  toast(t('batch.started', { title: game.title }), false, 8000);
};

bindSettings((s) => {
  sound.setVolumes(s.bgm / 100, s.sfx / 100);
  stage.setWeatherOn(s.weather);
});

let health;   // undefined: not answered yet, false: server down
function paintHealth() {
  if (health === undefined) return;
  $('#health').classList.toggle('error', !health?.comfy);
  if (!health) { $('#health').textContent = t('health.down'); return; }
  $('#health').textContent = t('health.comfy', { state: t(health.comfy ? 'health.on' : 'health.off') });
  $('#set-models').textContent = t('health.models', { list: health.models.map((m) => t(`model.${m}`)).join(' → ') });
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

get('/api/health').then((h) => { health = h; }).catch(() => { health = false; }).finally(paintHealth);
