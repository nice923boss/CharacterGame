// CORS relay for the GitHub Pages build of 千枝物語 (Cloudflare Worker).
// Browsers cannot call the NVIDIA API directly (no CORS headers), so the page sends its requests here.
// The player's key travels in the Authorization header of each request and is never stored or logged.
// Only two NVIDIA paths are forwarded, and only for the origins listed in ALLOWED_ORIGINS.
//
// Environment variable ALLOWED_ORIGINS: comma-separated, e.g. "https://nice923boss.github.io"

const ROUTES = [
  { prefix: '/v1/chat/completions', upstream: 'https://integrate.api.nvidia.com' },
  { prefix: '/v1/genai/', upstream: 'https://ai.api.nvidia.com' },
];

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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = corsHeaders(origin);
    // The error still carries CORS headers so the page can tell the player what is wrong
    if (!allowed.includes(origin)) return json(403, { error: 'origin_not_allowed' }, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

    const url = new URL(request.url);
    const route = ROUTES.find((r) => url.pathname === r.prefix || (r.prefix.endsWith('/') && url.pathname.startsWith(r.prefix)));
    if (!route) return json(404, { error: 'path_not_allowed' }, cors);

    const headers = { 'Content-Type': request.headers.get('Content-Type') || 'application/json' };
    for (const h of ['Authorization', 'Accept']) if (request.headers.get(h)) headers[h] = request.headers.get(h);
    // Request bodies are small JSON, so read them whole (streaming a request body needs duplex support)
    const upstream = await fetch(route.upstream + url.pathname, { method: 'POST', headers, body: await request.arrayBuffer() });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', ...cors },
    });
  },
};
