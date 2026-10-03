// Browser port of server/conn_check.py: the smallest possible request on each NVIDIA path, through the relay
// (B01, B02, B05), plus a relay check that needs no key (B07).
// Spike 2026-10-03: NVIDIA checks the key before anything else, so a 503 (overloaded) on the text path and a 422
// (empty body) on the image path still prove the key works; nothing is generated.
import { DATA } from './data.js?v=35d64fef8e0b';

const TIMEOUT_S = 20;
const CACHE_S = 600;                   // the title line shows the last result this long (B05)
const KEY_SEEN = [200, 422, 429, 503]; // answers NVIDIA only gives after it accepted the key
const CHECK = 'cg-key-check';

function classify(status, text) {
  if (status === 403 && text.includes('origin_not_allowed')) return 'relay_origin';
  if (status === 429 && text.includes('relay_quota')) return 'relay_quota';
  if (status === 502 && text.includes('upstream_unreachable')) return 'upstream';
  if (status === 401 || status === 403) return 'key_rejected';
  if (status === 200 || status === 422) return 'ok';
  if (DATA.llm.TRANSIENT_STATUS.includes(status)) return 'busy';
  return 'error';
}

async function send(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_S * 1000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, method: 'POST', signal: ctrl.signal });
    return { status: res.status, text: await res.text().catch(() => ''), ms: Date.now() - t0 };
  } catch {
    // No answer at all; an origin the relay refuses also lands here, since its preflight fails
    return { status: null, failure: ctrl.signal.aborted ? 'timeout' : 'unreachable', ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// kind: 'text' or 'image'. Same result shape as the server: { kind, state, status, ms }
export async function probe(kind, { key, relay }) {
  const image = kind === 'image';
  const body = image ? {} : { model: DATA.llm.candidates[0].model, messages: [{ role: 'user', content: 'hi' }],
                              max_tokens: 1, stream: false };
  const r = await send(`${relay}${image ? DATA.art.FLUX_PATH : '/v1/chat/completions'}`, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return { kind, state: r.failure || classify(r.status, r.text), status: r.status, ms: r.ms };
}

// Is a relay there, and does it accept this site? A plain-text POST without headers needs no preflight, so the
// relay's origin_not_allowed answer is readable; an accepted request reaches NVIDIA keyless and gets 401
export async function relayState(relay) {
  const r = await send(`${relay}/v1/chat/completions`, { body: '{}' });
  if (r.failure) return 'unreachable';
  return r.status === 403 && r.text.includes('origin_not_allowed') ? 'relay_origin' : 'ok';
}

export function remember(results) {
  const verdict = results.some((r) => r.state === 'key_rejected') ? 'rejected'
    : results.some((r) => r.state !== 'relay_quota' && KEY_SEEN.includes(r.status)) ? 'valid' : null;
  try { localStorage.setItem(CHECK, JSON.stringify({ at: Date.now(), verdict })); } catch { /* shows "not tested" */ }
}

export function verdict() {
  try {
    const c = JSON.parse(localStorage.getItem(CHECK) || 'null');
    return c && Date.now() - c.at < CACHE_S * 1000 ? c.verdict : null;
  } catch { return null; }
}

// "nvapi-****AB12": enough to tell two keys apart, never enough to use one
export function hint(key) {
  if (!key) return '';
  return (key.startsWith('nvapi-') ? 'nvapi-' : '') + '****' + (key.length >= 12 ? key.slice(-4) : '');
}
