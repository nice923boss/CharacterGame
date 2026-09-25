// Thin client for the FastAPI backend. SSE jobs are POST streams read with fetch.
// Server errors arrive as codes; Error.message is the translated text and Error.code keeps the code.
import { errorText } from './i18n.js';

function fail(code, params = {}) {
  const e = new Error(errorText(code, params));
  e.code = code;
  return e;
}

async function jsonOrThrow(res) {
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.json()).detail; } catch { /* body was not JSON */ }
    throw typeof detail === 'string' ? fail(detail) : fail('http', { status: res.status });
  }
  return res.json();
}

export const get = (path) => fetch(path).then(jsonOrThrow);
export const post = (path, body) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(jsonOrThrow);
export const del = (path) => fetch(path, { method: 'DELETE' }).then(jsonOrThrow);

// Starts a server job; onEvent gets every event. Returns { done, cancel }.
// done resolves with the final event, or rejects with an Error (message is player-facing).
export function job(path, body, onEvent) {
  const ctrl = new AbortController();
  let taskId = null;
  let cancelled = false;
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
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = null;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!chunk.startsWith('data:')) continue;
          const ev = JSON.parse(chunk.slice(5));
          if (ev.type === 'task') { taskId = ev.id; continue; }
          if (ev.type === 'final') final = ev;
          if (ev.type === 'error') throw fail(ev.code, ev.params);
          if (ev.type === 'cancelled') throw fail('cancelled');
          onEvent(ev);
        }
      }
    } catch (e) {
      if (cancelled) throw fail('cancelled');
      throw e;
    }
    if (!final) throw fail(cancelled ? 'cancelled' : 'dropped');
    return final;
  })();
  const cancel = async () => {
    cancelled = true;
    if (taskId) { try { await post(`/api/tasks/${taskId}/cancel`, {}); } catch { /* stream abort below still stops it */ } }
    ctrl.abort();
  };
  return { done, cancel };
}
