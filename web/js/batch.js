// Batch progress on the title screen, and the "tree finished" notice: in-game popup, sound and a browser notification.
// The server keeps working with the page closed; the notice needs this page open (it is found by polling).
import { get } from './api.js';
import { errorText, t } from './i18n.js';
import { sound } from './sound.js';
import { $, confirmBox, esc, toast } from './ui.js';

const POLL_MS = 5000;
const ACK_KEY = 'chienzhi.batchAcked';
const ACTIVE = ['running', 'images'];

let onPlay = null;
let timer = null;
let seen = {};   // gid -> state at the previous poll, so failures are reported once per page

function acked() {
  try { return new Set(JSON.parse(localStorage.getItem(ACK_KEY) || '[]')); } catch { return new Set(); }
}

function ack(gid, on = true) {
  const all = acked();
  if (on) all.add(gid); else all.delete(gid);
  try { localStorage.setItem(ACK_KEY, JSON.stringify([...all])); } catch { /* storage blocked: popup may repeat after reload */ }
}

export const batchRow = (b) => t('batch.row', { nodes: b.nodes, planned: b.planned, images: b.images, total: b.images_total });

function paintPanel(list) {
  const active = list.filter((b) => ACTIVE.includes(b.state));
  const panel = $('#batch-panel');
  panel.hidden = !active.length;
  panel.innerHTML = active.length ? `<h4>${esc(t('batch.panel'))}</h4>` + active.map((b) => {
    const pct = b.state === 'running' ? b.nodes / Math.max(1, b.planned) : b.images / Math.max(1, b.images_total);
    return `<div><b>${esc(b.title)}</b>・${esc(t(`batch.state.${b.state}`))}<br>${esc(batchRow(b))}</div>` +
      `<div class="batch-bar"><i style="width:${Math.round(pct * 100)}%"></i></div>`;
  }).join('') : '';
}

function systemNotice(b) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(t('batch.doneTitle'), { body: t('batch.doneBody', { title: b.title, nodes: b.nodes }) });
    }
  } catch { /* some browsers only allow notifications from a service worker; the popup still shows */ }
}

let asking = false;
async function announce(b) {
  asking = true;
  ack(b.id);
  sound.play('select');
  systemNotice(b);
  const notes = (b.failed ? t('batch.failedNote', { n: b.failed }) : '') +
    (b.image_errors ? t('batch.imgNote', { n: b.image_errors }) : '');
  const go = await confirmBox(t('batch.doneAsk', { title: b.title, nodes: b.nodes, notes }), t('batch.play'));
  asking = false;
  if (go) onPlay(b.id);
}

async function poll() {
  let list;
  try { list = await get('/api/batches'); } catch { return; }   // server down: the title screen health line says so
  paintPanel(list);
  const done = acked();
  for (const b of list) {
    if (b.state === 'error' && seen[b.id] && seen[b.id] !== 'error') {
      toast(t('batch.failed', { title: b.title, msg: errorText(b.error || 'internal') }), true);
    }
    seen[b.id] = b.state;
  }
  const ready = list.find((b) => b.state === 'done' && !done.has(b.id));
  if (ready && !asking && $('#mdl-confirm').hidden) announce(ready);
}

// onPlayGame(gid) opens a finished batch story at its opening
export function initBatches(onPlayGame) {
  onPlay = onPlayGame;
  poll();
  timer = setInterval(poll, POLL_MS);
}

// A resumed batch should announce itself again when it finishes
export const rearm = (gid) => ack(gid, false);

// A batch just started or changed: repaint without waiting for the next tick
export function refreshBatches() {
  if (timer) poll();
}

// Must run inside the click that starts a batch: browsers only show the permission prompt for a user gesture
export function requestNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch { /* not supported: the in-game popup is enough */ }
}
