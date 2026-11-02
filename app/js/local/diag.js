// Diagnostic log of the browser build (J01): retries, model switches, error codes and timings, kept in IndexedDB
// so a player can download them with a problem report. Events never carry the key or story text.
import { addDiag } from './store.js?v=a2430d6da8c1';

const clip = (v) => String(v ?? '').slice(0, 200);
const FIELD_CHARS = 500;   // longest string field kept in one event

// Anything that looks like an NVIDIA key, the current one or an old one, never reaches the log or the report
export const scrubKeys = (text) => String(text).replace(/nvapi-[A-Za-z0-9_-]+/g, 'nvapi-***');

// Top-level string fields are scrubbed and clipped before the event is stored
export const cleanEvent = (event) => Object.fromEntries(Object.entries(event).map(([k, v]) =>
  [k, typeof v === 'string' ? scrubKeys(v).slice(0, FIELD_CHARS) : v]));

export function diag(kind, data = {}) {
  if (typeof indexedDB === 'undefined') return;   // Node tests
  addDiag(cleanEvent({ t: new Date().toISOString(), kind, ...data })).catch((e) => console.warn('diagnostic log write failed', e));
}

// Errors nothing else caught: an uncaught exception or a promise nobody waited for
export function watchErrors() {
  window.addEventListener('error', (e) => diag('page_error', { message: clip(e.message), at: `${clip(e.filename)}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => {
    diag('unhandled', { message: clip(e.reason?.code || e.reason?.message || e.reason) });
  });
}
