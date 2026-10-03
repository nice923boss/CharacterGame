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

// Open modals, newest last: focus moves in, Tab stays inside, closing hands focus back (I04)
const modalStack = [];
const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.getClientRects().length);

export function openModal(id) {
  const el = $(id);
  if (!el.hidden) return;
  el.hidden = false;
  modalStack.push({ el, back: document.activeElement });
  const first = focusables(el)[0];
  if (first) first.focus();
  else { el.tabIndex = -1; el.focus(); }   // nothing to press yet (progress without cancel)
}

export function closeModal(id) {
  const el = typeof id === 'string' ? $(id) : id;
  el.hidden = true;
  const i = modalStack.findIndex((m) => m.el === el);
  if (i < 0) return;
  const [{ back }] = modalStack.splice(i, 1);
  if (i === modalStack.length && back?.isConnected) back.focus();
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn.closest('.modal'));
});

document.addEventListener('keydown', (e) => {
  while (modalStack.length && modalStack.at(-1).el.hidden) modalStack.pop();   // hidden without closeModal
  const top = modalStack.at(-1);
  if (!top || e.key !== 'Tab') return;
  const list = focusables(top.el);
  const first = list[0];
  const last = list.at(-1);
  const at = document.activeElement;
  if (!list.length) e.preventDefault();
  else if (!top.el.contains(at)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
});

// checkLabel: also show a checkbox (ticked); OK then resolves { checked } instead of true
export function confirmBox(text, okText = t('common.ok'), checkLabel = '') {
  return new Promise((resolve) => {
    $('#confirm-text').textContent = text;
    $('#confirm-ok').textContent = okText;
    $('#confirm-check').hidden = !checkLabel;
    $('#confirm-check span').textContent = checkLabel;
    $('#confirm-check input').checked = true;
    for (const el of document.querySelectorAll('#toast .toast:not(.error)')) el.remove();   // notices would sit on the panel
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

// Error codes the player can fix: [help.html anchor, settings field that fixes it] (C10, H05)
const HELP = {
  no_key: ['key', '#set-key'], key_rejected: ['key', '#set-key'], bad_key: ['key', '#set-key'],
  no_relay: ['relay', '#set-relay'], relay_unreachable: ['relay', '#set-relay'],
  relay_origin: ['relay', '#set-relay'], bad_relay: ['relay', '#set-relay'],
  all_failed: ['busy', '#set-patience'], offline: ['network'], dropped: ['network'], storage_full: ['storage'],
};
// A settings field this build does not show (the relay in the server build)
const shown = (el) => !el.closest('html:not(.local) .local-only, html.local .server-only');

export function openSettings(field) {
  openModal('#mdl-settings');
  const el = $(field);
  el.scrollIntoView({ block: 'center' });
  el.focus();
}

// "What to do" after an error message: one line, a button to the field that fixes it, a link to help.html
export function helpNode(code) {
  const [anchor, field] = HELP[code] || [];
  if (!anchor) return null;
  const box = document.createElement('span');
  box.className = 'err-help';
  box.append(t(`help.${anchor}`));
  if (field && shown($(field))) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tiny';
    btn.textContent = t('help.openSettings');
    btn.onclick = () => openSettings(field);
    box.append(btn);
  }
  const a = document.createElement('a');
  a.href = `help.html#${anchor}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = t('help.more');
  box.append(a);
  return box;
}

// Notices stack, newest at the bottom, at most TOAST_MAX; errors stay until closed (C09).
// id: replaces the earlier notice with the same id (progress updates); code: error code that gets help (C10)
const TOAST_MAX = 4;
export function toast(msg, error = false, ms = 4000, { id = '', code = '' } = {}) {
  const host = $('#toast');
  let el = id && host.querySelector(`.toast[data-id="${id}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    if (id) el.dataset.id = id;
  }
  clearTimeout(el.timer);
  el.classList.toggle('error', error);
  if (error) el.setAttribute('role', 'alert'); else el.removeAttribute('role');
  el.replaceChildren(msg);
  if (error) {
    const help = helpNode(code);
    if (help) el.append(help);
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'toast-x';
    x.textContent = '×';
    x.setAttribute('aria-label', t('common.close'));
    x.onclick = () => el.remove();
    el.append(x);
  } else {
    el.timer = setTimeout(() => el.remove(), ms);
  }
  host.append(el);
  while (host.children.length > TOAST_MAX) host.firstElementChild.remove();
}

export const toastError = (e) => toast(e.message, true, 0, { code: e.code });

// Modal progress overlay; onCancel null hides the cancel button
export function progress(text, sub = '', onCancel = null) {
  $('#progress-text').textContent = text;
  $('#progress-sub').textContent = sub;
  $('#progress-cancel').hidden = !onCancel;
  $('#progress-cancel').onclick = onCancel;
  $('#progress-now').hidden = true;
  paintWait($('#mdl-progress'), null);
  openModal('#mdl-progress');
  return {
    update(t, s) { if (t != null) $('#progress-text').textContent = t; if (s != null) $('#progress-sub').textContent = s; },
    // An LLM status event: plain text, countdown bar, and "retry now" while a retry countdown runs
    status(ev, onNow) {
      $('#progress-now').hidden = ev.state !== 'retry';
      $('#progress-now').onclick = onNow;
      if (ev.state !== 'waiting') $('#progress-sub').textContent = statusText(ev);
      paintWait($('#mdl-progress'), ev);
    },
    close() {
      closeModal('#mdl-progress');
      paintWait($('#mdl-progress'), null);
      $('#progress-cancel').onclick = $('#progress-now').onclick = null;
    },
  };
}

// Player-facing text for an LLM status event from the server: plain words; model and codes go to statusDetail
export function statusText(ev) {
  const p = { ...ev, reason: t(`reason.${ev.reason}`), plain: t(`plain.${ev.reason}`) };
  for (const k of ['model', 'from', 'to']) if (ev[k]) p[k] = t(`model.${ev[k]}`);
  if (ev.state === 'retry' && ev.max == null) return t('status.queue', p);   // past the backoff table, queueing
  if (['retry', 'switch', 'rpm', 'reconnect'].includes(ev.state)) return t(`status.${ev.state}`, p);
  return '';
}

// The technical line under "details": model, reason code with HTTP status, attempt count (A14)
export function statusDetail(ev) {
  const parts = [];
  const model = ev.model || ev.from;
  if (model) parts.push(t('detail.model', { model: t(`model.${model}`) }));
  if (ev.reason) parts.push(t('detail.reason', { code: ev.status ? `${ev.reason} HTTP ${ev.status}` : ev.reason }));
  if (ev.attempt) parts.push(t(ev.max == null ? 'detail.attemptQ' : 'detail.attempt', ev));
  return parts.join(t('detail.sep'));
}

// Countdown bar and collapsed details under a status line (#retry, #mdl-progress); ev null hides them.
// Screen readers hear each state or attempt once, not every countdown second (I05)
let said = '';
export function paintWait(root, ev) {
  const box = root.querySelector('.wait');
  const text = ev && ev.state !== 'waiting' ? statusText(ev) : '';
  box.hidden = !text;
  if (!text) { said = ''; return; }
  const bar = box.querySelector('.batch-bar');
  bar.hidden = !ev.total;
  if (ev.total) {
    const fill = bar.firstElementChild;
    if (ev.remaining >= ev.total) { fill.style.transition = 'none'; fill.style.width = '0%'; void fill.offsetWidth; }
    fill.style.transition = 'width 1s linear';
    fill.style.width = `${Math.min(100, ((ev.total - ev.remaining + 1) / ev.total) * 100)}%`;
  }
  box.querySelector('.wait-detail').textContent = statusDetail(ev);
  const key = `${ev.state}:${ev.attempt ?? ''}:${ev.model ?? ev.from ?? ''}`;
  if (key !== said) { said = key; $('#sr-live').textContent = text; }
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
  // H02, H03: sent with every job (api.js)
  $('#set-patience').value = String(settings.patience);
  $('#set-patience').addEventListener('change', () => { settings.patience = Number($('#set-patience').value); save(); });
  $('#set-prefer').value = settings.prefer;
  $('#set-prefer').addEventListener('change', () => { settings.prefer = $('#set-prefer').value; save(); });
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode: keep in memory */ }
    paint();
    onChange(settings);
  }
  paint();
  onChange(settings);
}
