// CORS relay (relay/worker.js): daily request count, "near" header at 80%, relay_quota at 95% (J03)
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

const ORIGIN = 'https://nice923boss.github.io';
const DAY = () => new Date().toISOString().slice(0, 10);
let fresh = 0;
let now = 0;
Date.now = () => now;

// The worker keeps its count in module state, so every test gets its own copy of the module
const loadWorker = async () => import(`../../relay/worker.js?t=${(fresh += 1)}`);

// Durable Object namespace backed by a real Usage instance and a Map for storage
function namespace(Usage, seed = {}) {
  const data = new Map(Object.entries(seed));
  const storage = {
    get: async (k) => data.get(k),
    put: async (k, v) => { data.set(k, v); },
    list: async ({ prefix }) => new Map([...data].filter(([k]) => k.startsWith(prefix)).sort()),
    delete: async (keys) => { for (const k of keys) data.delete(k); },
  };
  const obj = new Usage({ storage });
  const ns = { data, adds: 0, broken: false, idFromName: (name) => name };
  ns.get = () => ({
    fetch: async (url, init) => {
      if (init?.method === 'POST') { ns.adds += 1; if (ns.broken) throw new Error('storage down'); }
      return obj.fetch(new Request(url, init));
    },
  });
  return ns;
}

let upstream = 0;
globalThis.fetch = async () => {
  upstream += 1;
  return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json', 'retry-after': '3' } });
};

const today = (n) => ({ [`day:${DAY()}`]: n });

async function setup(seed = {}, limit = '100') {
  const worker = await loadWorker();
  const ns = namespace(worker.Usage, seed);
  const env = { ALLOWED_ORIGINS: ORIGIN, DAILY_LIMIT: limit, USAGE: ns };
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const send = async (method = 'POST', path = '/v1/chat/completions') => {
    const res = await worker.default.fetch(new Request(`https://relay.test${path}`, {
      method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined,
    }), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { worker, ns, env, ctx, send };
}

beforeEach(() => { now = 1_000_000; upstream = 0; });

test('below 80% the answer is passed on untouched', async () => {
  const { send, ns } = await setup(today(10));
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-relay-quota'), null);
  assert.equal(res.headers.get('access-control-expose-headers'), 'retry-after');
  assert.equal(ns.data.get(`day:${DAY()}`), 11);
});

test('from 80% the answers say the relay is near its daily limit', async () => {
  const { send } = await setup(today(79));
  // The isolate learns the day total from its first report, so the first request still looks low
  assert.equal((await send()).headers.get('x-relay-quota'), null);
  const res = await send();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-relay-quota'), 'near');
  assert.equal(res.headers.get('access-control-expose-headers'), 'retry-after, x-relay-quota');
});

test('from 95% the relay refuses with relay_quota and CORS headers, preflights still pass', async () => {
  const { send } = await setup(today(95));
  assert.equal((await send()).status, 200);
  const res = await send();
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: 'relay_quota' });
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(upstream, 1);
  assert.equal((await send('OPTIONS')).status, 204);
});

test('requests between reports are added up and reported every FLUSH_MS', async () => {
  const { send, ns } = await setup();
  for (let i = 0; i < 5; i += 1) await send();
  assert.equal(ns.adds, 1);
  assert.equal(ns.data.get(`day:${DAY()}`), 1);
  now += 30_000;
  await send();
  assert.equal(ns.adds, 2);
  assert.equal(ns.data.get(`day:${DAY()}`), 6);
});

test('a failed report keeps its count for the next one', async () => {
  const { send, ns } = await setup();
  ns.broken = true;
  const errors = console.error;
  console.error = () => {};
  try { await send(); } finally { console.error = errors; }
  assert.equal(ns.data.get(`day:${DAY()}`), undefined);
  ns.broken = false;
  now += 30_000;
  await send();
  assert.equal(ns.data.get(`day:${DAY()}`), 2);
});

test('GET /usage lists the kept days, and a report keeps only the last 7', async () => {
  const old = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`day:2026-01-0${i + 1}`, i]));
  const { send } = await setup(old, '100000');
  await send();
  const res = await send('GET', '/usage');
  assert.equal(res.status, 200);
  const { limit, days } = await res.json();
  assert.equal(limit, 100000);
  assert.deepEqual(Object.keys(days), ['2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07',
    '2026-01-08', DAY()]);
  assert.equal(days[DAY()], 1);
});

test('without the USAGE binding nothing is counted or refused', async () => {
  const worker = await loadWorker();
  const env = { ALLOWED_ORIGINS: ORIGIN, DAILY_LIMIT: '1' };
  for (let i = 0; i < 3; i += 1) {
    const res = await worker.default.fetch(new Request('https://relay.test/v1/chat/completions', {
      method: 'POST', headers: { Origin: ORIGIN }, body: '{}' }), env, { waitUntil: () => {} });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-relay-quota'), null);
  }
  const usage = await (await worker.default.fetch(new Request('https://relay.test/usage'), env, {})).json();
  assert.deepEqual(usage, { limit: 1, days: null });
});
