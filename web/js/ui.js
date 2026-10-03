// Shared DOM helpers: modals, confirm dialog, toast, progress overlay, settings persisted in localStorage.
import { t } from './i18n.js';

export const $ = (sel) => document.querySelector(sel);

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Thumbnails show a loading label until the whole image has arrived, instead of a picture drawn strip by strip
export const thumbAttr = (url) => (url ? ` data-thumb="${esc(url)}" data-loading="${esc(t('load.thumb'))}"` : '');

export function loadThumbs(root) {
  for (const el of root.querySelectorAll('[data-thumb]')) {
    const url = el.dataset.thumb;
    const img = new Image();
    img.onload = () => { el.style.backgroundImage = `url('${url}')`; delete el.dataset.thumb; };
    img.onerror = () => { console.warn('thumbnail failed', url); delete el.dataset.thumb; };
    img.src = url;
  }
}

export function openModal(id) { $(id).hidden = false; }
export function closeModal(id) { $(id).hidden = true; }

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close]');
  if (btn) btn.closest('.modal').hidden = true;
});

// checkLabel: also show a checkbox (ticked); OK then resolves { checked } instead of true
export function confirmBox(text, okText = t('common.ok'), checkLabel = '') {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okText;
    $('#confirm-check').hidden = !checkLabel;
    $('#confirm-check span').textContent = checkLabel;
    $('#confirm-check input').checked = true;
    $('#toast').hidden = true;   // an earlier notice would sit on the confirm panel
    openModal('#mdl-confirm');
    const done = (v) => {
      closeModal('#mdl-confirm');
      $('#confirm-ok').onclick = $('#confirm-cancel').onclick = null;
      resolve(v);
    };
    $('#confirm-ok').onclick = () => done(checkLabel ? { checked: $('#confirm-check input').checked } : true);
    $('#confirm-cancel').onclick = () => done(false);
  });
}

let toastTimer = null;
export function toast(msg, error = false, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? ms * 1.6 : ms);
}

// Modal progress overlay; onCancel null hides the cancel button
export function progress(text, sub = '', onCancel = null) {
  $('#progress-text').textContent = text;
  $('#progress-sub').textContent = sub;
  $('#progress-cancel').hidden = !onCancel;
  $('#progress-cancel').onclick = onCancel;
  $('#progress-now').hidden = true;
  openModal('#mdl-progress');
  return {
    update(t, s) { if (t != null) $('#progress-text').textContent = t; if (s != null) $('#progress-sub').textContent = s; },
    // Shows "retry now" while a retry countdown runs
    retry(ev, onNow) { $('#progress-now').hidden = ev.state !== 'retry'; $('#progress-now').onclick = onNow; },
    close() { closeModal('#mdl-progress'); $('#progress-cancel').onclick = $('#progress-now').onclick = null; },
  };
}

// Player-facing text for an LLM status event from the server
export function statusText(ev) {
  const p = { ...ev, reason: t(`reason.${ev.reason}`) };
  for (const k of ['model', 'from', 'to']) if (ev[k]) p[k] = t(`model.${ev[k]}`);
  if (ev.state === 'retry' && ev.max == null) return t('status.queue', p);   // past the backoff table, queueing
  if (['retry', 'switch', 'rpm', 'reconnect'].includes(ev.state)) return t(`status.${ev.state}`, p);
  return '';
}

// Banner while the browser has no network; turns sent meanwhile wait for it to come back (game.js)
function paintOffline() { $('#offline').hidden = navigator.onLine; }
window.addEventListener('online', paintOffline);
window.addEventListener('offline', paintOffline);
paintOffline();

// patience: seconds to keep queueing when every model is busy; prefer: quality (retry the first model) or speed
const DEFAULTS = { speed: 45, bgm: 55, sfx: 70, weather: true, patience: 300, prefer: 'quality' };
const KEY = 'chienzhi.settings';

function readSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export const settings = readSettings();

export function bindSettings(onChange) {
  const map = { speed: '#set-speed', bgm: '#set-bgm', sfx: '#set-sfx' };
  const paint = () => {
    $('#out-speed').textContent = settings.speed;
    $('#out-bgm').textContent = settings.bgm;
    $('#out-sfx').textContent = settings.sfx;
  };
  for (const [k, sel] of Object.entries(map)) {
    $(sel).value = settings[k];
    $(sel).addEventListener('input', () => {
      settings[k] = Number($(sel).value);
      save();
    });
  }
  $('#set-weather').checked = settings.weather;
  $('#set-weather').addEventListener('change', () => { settings.weather = $('#set-weather').checked; save(); });
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode: keep in memory */ }
    paint();
    onChange(settings);
  }
  paint();
  onChange(settings);
}
