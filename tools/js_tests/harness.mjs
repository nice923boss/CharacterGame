// Browser stand-ins for the modules under web/js, run by server/tests/test_browser_js.py with CG_JS_DIR pointing
// at a copy of web/js that has the generated data.js.
// The clock is virtual: a timer fires once nothing else is pending, and Date.now jumps to its time, so minutes
// of retry waits take milliseconds and every wait can be checked exactly.
import { pathToFileURL } from 'node:url';

const realImmediate = setImmediate;

const items = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k) => (items.has(k) ? items.get(k) : null),
    setItem: (k, v) => { items.set(k, String(v)); },
    removeItem: (k) => { items.delete(k); },
    clear: () => { items.clear(); },
  },
});
globalThis.document = { hidden: false, visibilityState: 'visible', hasFocus: () => true, addEventListener() {} };
globalThis.BroadcastChannel = undefined;
globalThis.createImageBitmap = async (blob) => ({ bitmap: await blob.text() });

// ---------- virtual clock ----------

let now = Date.parse('2026-10-04T00:00:00Z');
let lastId = 0;
const timers = new Map();   // id -> { at, id, fn, args }
let driving = false;

Date.now = () => now;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  lastId += 1;
  timers.set(lastId, { at: now + Math.max(0, Number(ms) || 0), id: lastId, fn, args });
  drive();
  return lastId;
};
globalThis.clearTimeout = (id) => { timers.delete(id); };

async function drive() {
  if (driving) return;
  driving = true;
  while (timers.size) {
    // Let promises and stream reads settle before time moves on
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => { realImmediate(resolve); });
    if (!timers.size) break;
    const next = [...timers.values()].reduce((a, b) => (b.at < a.at || (b.at === a.at && b.id < a.id) ? b : a));
    timers.delete(next.id);
    now = Math.max(now, next.at);
    next.fn(...next.args);
  }
  driving = false;
}

export const clock = () => now;

// ---------- fake fetch ----------

// Each call takes the next step: (url, options) => Response or a promise of one
export const calls = [];
let steps = [];
export function serve(...list) {
  steps = list;
  calls.length = 0;
}
export const unused = () => steps.length;

globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, at: now, auth: opts.headers?.Authorization });
  const step = steps.shift();
  if (!step) throw new Error(`no step left for ${url}`);
  return step(String(url), opts);
};

export function sse(text, finish = 'stop') {
  const rows = [`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}`, 'data: [DONE]'];
  return () => new Response(`${rows.join('\n\n')}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
export const http = (status, body = '', headers = {}) => () => new Response(body, { status, headers });
// Never answers until the caller aborts
export const hang = (url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
export const offline = () => Promise.reject(new TypeError('Failed to fetch'));

// ---------- modules under test ----------

const base = pathToFileURL(`${process.env.CG_JS_DIR}/`);
export const load = (path) => import(new URL(path, base).href);
