// Thin client for the FastAPI backend. SSE jobs are POST streams read with fetch.
// Server errors arrive as codes; Error.message is the translated text and Error.code keeps the code.
import { errorText } from './i18n.js?v=35d64fef8e0b';
import { settings } from './ui.js?v=35d64fef8e0b';

function fail(code, params = {}) {
  const e = new Error(errorText(code, params));
  e.code = code;
  e.params = params;
  return e;
}

async function jsonOrThrow(res) {
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.json()).detail; } catch { /* body was not JSON */ }
    throw typeof detail === 'string' ? fail(detail)
      : detail?.code ? fail(detail.code, detail.params) : fail('http', { status: res.status });
  }
  return res.json();
}

// GitHub Pages build: /api/* runs in this browser (js/local/backend.js) instead of on a server
export const LOCAL = !!document.querySelector('meta[name="cg-local"]');
const backend = LOCAL ? import('./local/backend.js?v=35d64fef8e0b') : null;
const isApi = (path) => path.startsWith('/api/');
// Local modules throw { code, params } like the server's error events; anything else is a bug
function asError(e) {
  if (e?.name === 'QuotaExceededError') return fail('storage_full');
  if (e instanceof Error && e.code) return e;
  if (e?.code && !(e instanceof Error)) return fail(e.code, e.params);
  console.error(e);
  return fail('local_internal');
}

async function local(method, path, body) {
  try { return await (await backend).request(method, path, body); } catch (e) { throw asError(e); }
}

export const get = (path) => (LOCAL && isApi(path) ? local('GET', path) : fetch(path).then(jsonOrThrow));
export const post = (path, body) => (LOCAL && isApi(path) ? local('POST', path, body) : fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(jsonOrThrow));
export const del = (path) => (LOCAL && isApi(path) ? local('DELETE', path) : fetch(path, { method: 'DELETE' }).then(jsonOrThrow));

function localJob(path, body, onEvent) {
  let inner = null;
  let cancelled = false;
  const done = (async () => {
    const b = await backend;
    if (cancelled) throw fail('cancelled');
    inner = b.job(path, body, onEvent);
    try { return await inner.done; } catch (e) { throw asError(e); }
  })();
  return {
    done,
    cancel: async () => { cancelled = true; if (inner) await inner.cancel(); },
    retryNow: async () => { if (inner) await inner.retryNow(); },
  };
}

const RECONNECT_S = [1, 2, 4, 8, 15, 30];   // the job goes on at the server while we follow it again
let active = 0;
// Jobs still running in this page: leaving now loses the local ones and leaves the server ones unwatched
export const activeJobs = () => active;

const pause = (s, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, s * 1000);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

function serverJob(path, body, onEvent) {
  const ctrl = new AbortController();
  let taskId = null;
  let cancelled = false;
  let seen = 0;   // job events received so far (the task id not counted): a reconnect picks up after them

  // Reads one event stream: the final event, or null when the stream ended or broke without one
  async function read(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { return null; }
      if (chunk.done) return null;
      buf += dec.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (!block.startsWith('data:')) continue;   // ": ping" only keeps a quiet stream open
        const ev = JSON.parse(block.slice(5));
        if (ev.type === 'task') { taskId = ev.id; continue; }
        seen += 1;
        if (ev.type === 'error') throw fail(ev.code, ev.params);
        if (ev.type === 'cancelled') throw fail('cancelled');
        onEvent(ev);
        if (ev.type === 'final') { reader.cancel().catch(() => {}); return ev; }
      }
    }
  }

  const done = (async () => {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw fail(cancelled ? 'cancelled' : 'offline');
    }
    if (!res.ok) await jsonOrThrow(res);
    let tries = 0;
    for (;;) {
      const before = seen;
      const final = await read(res);
      if (final) return final;
      if (seen > before) tries = 0;
      res = null;
      while (!res) {
        if (cancelled) throw fail('cancelled');
        if (!taskId || tries >= RECONNECT_S.length) throw fail('dropped');
        onEvent({ type: 'status', state: 'reconnect', attempt: tries + 1, max: RECONNECT_S.length });
        await pause(RECONNECT_S[tries], ctrl.signal);
        tries += 1;
        if (cancelled) throw fail('cancelled');
        let r = null;
        try { r = await fetch(`/api/tasks/${taskId}/events?after=${seen}`, { signal: ctrl.signal }); } catch { /* still cut off */ }
        if (r?.status === 404) throw fail('dropped');   // the server restarted or forgot the job
        if (r?.ok) res = r;
      }
      onEvent({ type: 'status', state: 'reconnected' });   // clears the reconnect notice
    }
  })();
  const cancel = async () => {
    cancelled = true;
    if (taskId) { try { await post(`/api/tasks/${taskId}/cancel`, {}); } catch { /* stream abort below still stops it */ } }
    ctrl.abort();
  };
  // Cuts the current retry countdown short
  const retryNow = async () => {
    if (taskId) { try { await post(`/api/tasks/${taskId}/retry_now`, {}); } catch (e) { console.warn('retry now failed', e); } }
  };
  return { done, cancel, retryNow };
}

// Starts a job; onEvent gets every event. Returns { done, cancel, retryNow }.
// done resolves with the final event, or rejects with an Error (message is player-facing).
// Every job carries how long the player agreed to queue for a busy model (settings page).
export function job(path, body, onEvent) {
  body = { ...body, waits: { patience: settings.patience, prefer: settings.prefer } };
  const j = LOCAL ? localJob(path, body, onEvent) : serverJob(path, body, onEvent);
  active += 1;
  j.done.then(() => { active -= 1; }, () => { active -= 1; });
  return j;
}
