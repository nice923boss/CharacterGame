// CORS relay for the GitHub Pages build of 千枝物語 (Cloudflare Worker).
// Browsers cannot call the NVIDIA API directly (no CORS headers), so the page sends its requests here.
// The player's key travels in the Authorization header of each request and is never stored or logged.
// Only two NVIDIA paths are forwarded, and only for the origins listed in ALLOWED_ORIGINS.
//
// Environment variable ALLOWED_ORIGINS: comma-separated, e.g. "https://nice923boss.github.io"
// Environment variable DAILY_LIMIT (optional): the account's daily Worker requests, 100000 on the free plan.
// Durable Object binding USAGE (optional, class Usage below): counts this relay's requests per UTC day. Near the
// limit the answers carry "x-relay-quota: near", and close to it the relay answers 429 relay_quota itself, because
// past the limit Cloudflare answers with an error page without CORS headers and the page only sees "cannot connect".
// Without the binding (e.g. pasted into the dashboard) nothing is counted and nothing is refused.

const ROUTES = [
  { prefix: '/v1/chat/completions', upstream: 'https://integrate.api.nvidia.com' },
  { prefix: '/v1/genai/', upstream: 'https://ai.api.nvidia.com' },
];
const WARN_AT = 0.8;
const STOP_AT = 0.95;
const FLUSH_MS = 30000;   // each isolate reports its count at most this often
const KEEP_DAYS = 7;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (status, body, headers) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

// One instance (named "relay") keeps the request count of each UTC day
export class Usage {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const days = async () => this.storage.list({ prefix: 'day:' });
    if (request.method === 'POST') {
      const { day, n } = await request.json();
      const total = ((await this.storage.get(`day:${day}`)) || 0) + n;
      await this.storage.put(`day:${day}`, total);
      const old = [...(await days()).keys()].sort().slice(0, -KEEP_DAYS);
      if (old.length) await this.storage.delete(old);
      return json(200, { total });
    }
    return json(200, { days: Object.fromEntries([...(await days())].map(([k, v]) => [k.slice(4), v])) });
  }
}

// Requests this isolate has not reported yet, and the day total from its last report
const tally = { day: '', known: 0, pending: 0, flushedAt: 0, flushing: false };
const usage = (env) => env.USAGE.get(env.USAGE.idFromName('relay'));

// Counts this request and returns the day's count so far as this isolate knows it
function count(env, ctx) {
  const day = new Date().toISOString().slice(0, 10);
  if (tally.day !== day) Object.assign(tally, { day, known: 0, pending: 0, flushedAt: 0 });
  tally.pending += 1;
  const used = tally.known + tally.pending;
  if (!tally.flushing && Date.now() - tally.flushedAt >= FLUSH_MS) {
    const n = tally.pending;
    tally.pending = 0;
    tally.flushing = true;
    ctx.waitUntil(usage(env).fetch('https://usage/add', { method: 'POST', body: JSON.stringify({ day, n }) })
      .then((r) => r.json())
      .then(({ total }) => { if (tally.day === day) tally.known = total; })
      .catch((e) => {
        console.error('usage count failed', String(e));
        if (tally.day === day) tally.pending += n;
      })
      .finally(() => { tally.flushing = false; tally.flushedAt = Date.now(); }));
  }
  return used;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const used = env.USAGE ? count(env, ctx) : 0;
    const limit = Number(env.DAILY_LIMIT) || 100000;
    // Request counts only, nothing about players or keys
    if (url.pathname === '/usage' && request.method === 'GET') {
      const days = env.USAGE ? (await (await usage(env).fetch('https://usage/')).json()).days : null;
      return json(200, { limit, days });
    }

    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin);
    // The error still carries CORS headers so the page can tell the player what is wrong
    if (!allowed.includes(origin)) return json(403, { error: 'origin_not_allowed' }, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

    const route = ROUTES.find((r) => url.pathname === r.prefix || (r.prefix.endsWith('/') && url.pathname.startsWith(r.prefix)));
    if (!route) return json(404, { error: 'path_not_allowed' }, cors);
    if (used >= limit * STOP_AT) return json(429, { error: 'relay_quota' }, cors);

    const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' };
    for (const h of ['Authorization', 'Accept']) if (request.headers.get(h)) headers[h] = request.headers.get(h);
    // Request bodies are small JSON, so read them whole (streaming a request body needs duplex support)
    const body = await request.arrayBuffer();
    let upstream;
    try {
      upstream = await fetch(route.upstream + url.pathname, { method: 'POST', headers, body });
    } catch (e) {
      // The page tells "relay down" (no answer at all) from "NVIDIA unreachable" (this answer) and retries
      return json(502, { error: 'upstream_unreachable' }, cors);
    }
    const out = { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...cors };
    // The page waits as long as NVIDIA asks (Retry-After) instead of guessing
    const passed = [...upstream.headers.keys()].filter((h) => h === 'retry-after' || h.startsWith('x-ratelimit-'));
    for (const h of passed) out[h] = upstream.headers.get(h);
    if (used >= limit * WARN_AT) {
      out['x-relay-quota'] = 'near';
      passed.push('x-relay-quota');
    }
    if (passed.length) out['Access-Control-Expose-Headers'] = passed.join(', ');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
