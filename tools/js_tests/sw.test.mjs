// tools/sw_template.js (the Pages service worker), run against fake caches, fetch and worker scope (phase 10, P11-P12)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const TEMPLATE = readFileSync(new URL('../sw_template.js', import.meta.url), 'utf8');
const SCOPE = 'https://nice923boss.github.io/CharacterGame/app/';
const P5 = 'https://cdn.jsdelivr.net/npm/p5@1.11.3/lib/p5.min.js';
const RELAY = 'https://chienzhi-relay.cattravelworld.com/v1/chat/completions';

// Resolves relative URLs against the worker scope, like Request inside a service worker
class FakeRequest {
  constructor(url, init = {}) {
    this.url = new URL(url, SCOPE).href;
    this.method = init.method || 'GET';
    this.cache = init.cache || 'default';
  }
}

function boot({ shell = ['./', 'index.html', 'js/main.js'], cdn = [P5], files = {}, caches: seed = {} } = {}) {
  const listeners = {};
  const state = { skipped: false, claimed: false, fetched: [], warned: [] };
  const stores = new Map(Object.entries(seed).map(([name, urls]) => [name, new Map(urls.map((u) => [u, new Response(u)]))]));
  const key = (req) => (typeof req === 'string' ? new URL(req, SCOPE).href : req.url);
  const fetchFake = async (req) => {
    const url = key(req);
    state.fetched.push({ url, cache: req.cache });
    const body = files[url];
    if (body === undefined) return new Response('missing', { status: 404 });
    if (body instanceof Error) throw body;
    return new Response(body);
  };
  const open = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async match(req, opts = {}) {
        const want = new URL(key(req));
        for (const [url, res] of store) {
          const have = new URL(url);
          if (opts.ignoreSearch) { have.search = ''; want.search = ''; }
          if (have.href === want.href) return res.clone();
        }
        return undefined;
      },
      async put(req, res) { store.set(key(req), res); },
      async add(req) {
        const res = await fetchFake(typeof req === 'string' ? new FakeRequest(req) : req);
        if (!res.ok) throw new TypeError(`bad status ${res.status}`);
        store.set(key(req), res);
      },
      async addAll(reqs) {
        const got = await Promise.all(reqs.map((r) => fetchFake(r)));
        if (got.some((r) => !r.ok)) throw new TypeError('addAll failed');
        reqs.forEach((r, i) => store.set(key(r), got[i]));
      },
    };
  };
  const cachesFake = {
    open: async (name) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  const self = {
    location: new URL(`${SCOPE}sw.js`),
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: () => { state.skipped = true; },
    clients: { claim: async () => { state.claimed = true; } },
  };
  const consoleFake = { warn: (...args) => state.warned.push(args[1]) };
  const code = TEMPLATE.replace('__VERSION__', 'v2').replace('__SHELL__', JSON.stringify(shell))
    .replace('__CDN__', JSON.stringify(cdn));
  new Function('self', 'caches', 'fetch', 'Request', 'console', code)(self, cachesFake, fetchFake, FakeRequest, consoleFake);

  const dispatch = (type, extra = {}) => {
    const event = { waits: [], waitUntil(p) { this.waits.push(p); }, ...extra };
    listeners[type](event);
    return event;
  };
  const request = (url, method = 'GET') => {
    const event = dispatch('fetch', { request: new FakeRequest(url, { method }), respondWith(p) { this.response = p; } });
    return event;
  };
  return { state, stores, dispatch, request };
}

const shellFiles = { [SCOPE]: 'home', [`${SCOPE}index.html`]: 'page', [`${SCOPE}js/main.js`]: 'main' };

test('install precaches the shell past the HTTP cache, and a CDN failure does not block it', async () => {
  const sw = boot({ files: shellFiles });   // p5 is missing, so its precache fails
  const ev = sw.dispatch('install');
  await Promise.all(ev.waits);
  const cache = sw.stores.get('chienzhi-v2');
  assert.deepEqual([...cache.keys()].sort(), Object.keys(shellFiles).sort());
  assert.ok(sw.state.fetched.filter((f) => f.url.startsWith(SCOPE)).every((f) => f.cache === 'reload'));
  assert.deepEqual(sw.state.warned, [P5]);
});

test('install fails when a shell file cannot be fetched, so a broken version never activates', async () => {
  const sw = boot({ files: { [SCOPE]: 'home', [`${SCOPE}index.html`]: 'page' } });
  const ev = sw.dispatch('install');
  await assert.rejects(Promise.all(ev.waits));
});

test('activate removes old app caches only, then takes over open pages', async () => {
  const sw = boot({ caches: { 'chienzhi-v1': ['a'], 'chienzhi-v2': ['b'], 'someone-else': ['c'] } });
  const ev = sw.dispatch('activate');
  await Promise.all(ev.waits);
  assert.deepEqual([...sw.stores.keys()].sort(), ['chienzhi-v2', 'someone-else']);
  assert.equal(sw.state.claimed, true);
});

test('a module with another ?v= is served from the cache without the network', async () => {
  const sw = boot();
  sw.stores.set('chienzhi-v2', new Map([[`${SCOPE}js/main.js?v=old`, new Response('cached')]]));
  const ev = sw.request(`${SCOPE}js/main.js?v=new`);
  assert.equal(await (await ev.response).text(), 'cached');
  assert.equal(sw.state.fetched.length, 0);
});

test('a miss goes to the network and the copy is stored under waitUntil', async () => {
  const font = 'https://fonts.gstatic.com/s/noto/v1/a.woff2';
  const sw = boot({ files: { [font]: 'font' } });
  const ev = sw.request(font);
  assert.equal(await (await ev.response).text(), 'font');
  assert.equal(ev.waits.length, 1);   // P11: the worker stays alive until the copy is written
  await Promise.all(ev.waits);
  assert.ok(sw.stores.get('chienzhi-v2').has(font));
});

test('a failed response is passed through but not cached', async () => {
  const sw = boot();
  const ev = sw.request(`${SCOPE}js/gone.js`);
  assert.equal((await ev.response).status, 404);
  assert.equal(ev.waits.length, 0);
  assert.equal(sw.stores.get('chienzhi-v2').size, 0);
});

test('relay calls, other hosts and POST requests are left to the network', () => {
  const sw = boot();
  for (const ev of [sw.request(RELAY), sw.request('https://integrate.api.nvidia.com/v1/models'),
    sw.request(`${SCOPE}api/x`, 'POST')]) {
    assert.equal(ev.response, undefined);
  }
});

test('only the skip-waiting message activates a waiting version', () => {
  const sw = boot();
  sw.dispatch('message', { data: 'hello' });
  assert.equal(sw.state.skipped, false);
  sw.dispatch('message', { data: 'skip-waiting' });
  assert.equal(sw.state.skipped, true);
});
