// Shared DOM helpers: modals, confirm dialog, toast, progress overlay, settings persisted in localStorage.
import { t } from './i18n.js';

export const $ = (sel) => document.querySelector(sel);

export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function openModal(id) { $(id).hidden = false; }
export function closeModal(id) { $(id).hidden = true; }

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close]');
  if (btn) btn.closest('.modal').hidden = true;
});

export function confirmBox(text, okText = t('common.ok')) {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okText;
    $('#toast').hidden = true;   // an earlier notice would sit on the confirm panel
    openModal('#mdl-confirm');
    const done = (v) => {
      closeModal('#mdl-confirm');
      $('#confirm-ok').onclick = $('#confirm-cancel').onclick = null;
      resolve(v);
    };
    $('#confirm-ok').onclick = () => done(true);
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
  openModal('#mdl-progress');
  return {
    update(t, s) { if (t != null) $('#progress-text').textContent = t; if (s != null) $('#progress-sub').textContent = s; },
    close() { closeModal('#mdl-progress'); $('#progress-cancel').onclick = null; },
  };
}

// Player-facing text for an LLM status event from the server
export function statusText(ev) {
  const p = { ...ev, reason: t(`reason.${ev.reason}`) };
  for (const k of ['model', 'from', 'to']) if (ev[k]) p[k] = t(`model.${ev[k]}`);
  if (['retry', 'switch', 'rpm'].includes(ev.state)) return t(`status.${ev.state}`, p);
  return '';
}

const DEFAULTS = { speed: 45, bgm: 55, sfx: 70, weather: true };
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
