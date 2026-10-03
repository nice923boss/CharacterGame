// Diagnostic log of the browser build (J01): retries, model switches, error codes and timings, kept in IndexedDB
// so a player can download them with a problem report. Events never carry the key or story text.
import { addDiag } from './store.js?v=35d64fef8e0b';

const clip = (v) => String(v ?? '').slice(0, 200);

export function diag(kind, data = {}) {
  if (typeof indexedDB === 'undefined') return;   // Node tests
  addDiag({ t: new Date().toISOString(), kind, ...data }).catch((e) => console.warn('diagnostic log write failed', e));
}

// Errors nothing else caught: an uncaught exception or a promise nobody waited for
export function watchErrors() {
  window.addEventListener('error', (e) => diag('page_error', { message: clip(e.message), at: `${clip(e.filename)}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => {
    diag('unhandled', { message: clip(e.reason?.code || e.reason?.message || e.reason) });
  });
}
