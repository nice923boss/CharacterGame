// Browser story-text client (web/js/local/llm.js): retries, Retry-After, model switch, watchdogs, relay errors
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { calls, hang, http, load, offline, serve, sse, unused } from './harness.mjs';

const llm = await load('local/llm.js');
const { DATA } = await load('local/data.js');
const L = DATA.llm;
const [ULTRA, LIGHTNING] = L.candidates.map((c) => c.model);
const CONN = { key: 'nvapi-test-only', relay: 'https://relay.test' };
const TEXT = '夜市的燈一盞盞亮起，她回頭看了你一眼。\n';
const MESSAGES = [{ role: 'user', content: 'start' }];

// Seconds a jittered wait of `base` can take (waitFor in llm.js)
const jitterRange = (base) => [Math.max(1, Math.round(base * L.JITTER[0])), Math.round(base * L.JITTER[1])];
const gap = (i) => (calls[i + 1].at - calls[i].at) / 1000;

async function run(waits) {
  const events = [];
  const res = await llm.stream(MESSAGES, (e) => events.push(e), 0.8, { ...CONN, waits });
  return { res, events };
}

beforeEach(() => { localStorage.clear(); });

test('a busy answer is retried on the same model after a jittered wait', async () => {
  serve(http(503), sse(TEXT));
  const { res, events } = await run();
  assert.equal(res.content, TEXT);
  assert.equal(res.candidate.model, ULTRA);
  assert.deepEqual(calls.map((c) => c.body.model), [ULTRA, ULTRA]);
  assert.equal(calls[0].url, `${CONN.relay}/v1/chat/completions`);
  assert.equal(calls[0].auth, `Bearer ${CONN.key}`);
  const retry = events.find((e) => e.state === 'retry');
  assert.equal(retry.reason, 'transient');
  assert.equal(retry.status, 503);
  assert.equal(retry.attempt, 1);
  assert.equal(retry.max, L.PRIMARY_RETRY_S.length);
  const [lo, hi] = jitterRange(L.PRIMARY_RETRY_S[0]);
  assert.ok(gap(0) >= lo && gap(0) <= hi, `waited ${gap(0)} s`);
  assert.ok(events.some((e) => e.type === 'delta'));
});

test('Retry-After replaces the backoff step and is capped', async () => {
  serve(http(429, '', { 'Retry-After': '7' }), sse(TEXT));
  const first = await run();
  assert.equal(gap(0), 7);
  assert.equal(first.events.find((e) => e.state === 'retry').total, 7);

  localStorage.clear();
  serve(http(503, '', { 'Retry-After': '600' }), sse(TEXT));
  await run();
  assert.equal(gap(0), L.RETRY_AFTER_MAX_S);
});

test('a retired model switches to the next one and cools down', async () => {
  serve(http(404, '{"error":{"message":"model_not_found"}}'), sse(TEXT));
  const { res, events } = await run();
  assert.equal(res.candidate.model, LIGHTNING);
  assert.deepEqual(calls.map((c) => c.body.model), [ULTRA, LIGHTNING]);
  const sw = events.find((e) => e.state === 'switch');
  assert.deepEqual([sw.from, sw.to, sw.reason, sw.status], ['ultra', 'lightning', 'gone', 404]);

  // The next turn skips the cooling model and says so
  serve(sse(TEXT));
  const next = await run();
  assert.deepEqual(calls.map((c) => c.body.model), [LIGHTNING]);
  const cooling = next.events.find((e) => e.state === 'cooling');
  assert.equal(cooling.model, 'ultra');
  assert.ok(cooling.remaining > 0 && cooling.remaining <= L.COOLDOWN_STEPS_S[0]);
});

test('prefer speed switches after the first busy answer', async () => {
  serve(http(503), sse(TEXT));
  const { res } = await run({ prefer: 'speed' });
  assert.equal(res.candidate.model, LIGHTNING);
  assert.deepEqual(calls.map((c) => c.body.model), [ULTRA, LIGHTNING]);
});

test('no response headers in time counts as a timeout and is retried', async () => {
  serve(hang, sse(TEXT));
  const { res, events } = await run();
  assert.equal(res.content, TEXT);
  assert.equal(events.find((e) => e.state === 'retry').reason, 'timeout');
  const [lo, hi] = jitterRange(L.PRIMARY_RETRY_S[0]);
  const waited = gap(0) - L.FIRST_DATA_TIMEOUT_S;
  assert.ok(waited >= lo && waited <= hi, `waited ${gap(0)} s in all`);
});

test('headers without any data time out after FIRST_DATA_TIMEOUT_S', async () => {
  const silent = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
  serve(silent, sse(TEXT));
  const { events } = await run();
  assert.equal(events.find((e) => e.state === 'retry').reason, 'timeout');
  assert.ok(gap(0) >= L.FIRST_DATA_TIMEOUT_S);
});

test('a relay that cannot reach NVIDIA is retried', async () => {
  serve(http(502, '{"error":"upstream_unreachable"}'), sse(TEXT));
  const { res, events } = await run();
  assert.equal(res.content, TEXT);
  const retry = events.find((e) => e.state === 'retry');
  assert.deepEqual([retry.reason, retry.status], ['upstream', 502]);
});

test('relay and key refusals stop at once', async () => {
  serve(http(403, '{"error":"origin_not_allowed"}'));
  await assert.rejects(run(), (e) => e.code === 'relay_origin');
  assert.equal(calls.length, 1);

  serve(http(401, '{"status":401,"title":"Unauthorized"}'));
  await assert.rejects(run(), (e) => e.code === 'key_rejected');
  assert.equal(calls.length, 1);
});

test('a relay out of its daily allowance stops at once, and near the limit it says so', async () => {
  serve(http(429, '{"error":"relay_quota"}'));
  await assert.rejects(run(), (e) => e.code === 'relay_quota');
  assert.equal(calls.length, 1);

  const seen = [];
  globalThis.dispatchEvent = (e) => { seen.push(e.type); };
  try {
    serve(http(503, '', { 'x-relay-quota': 'near' }), (url, opts) => {
      const res = sse(TEXT)(url, opts);
      res.headers.set('x-relay-quota', 'near');
      return res;
    });
    const { res } = await run();
    assert.equal(res.content, TEXT);
  } finally {
    delete globalThis.dispatchEvent;
  }
  assert.deepEqual(seen, ['cg-relay-quota', 'cg-relay-quota']);
});

test('an unreachable relay is tried again, then reported without switching models', async () => {
  serve(offline, offline, offline, offline);
  const events = [];
  await assert.rejects(llm.stream(MESSAGES, (e) => events.push(e), 0.8, CONN), (e) => e.code === 'relay_unreachable');
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.body.model), [ULTRA, ULTRA, ULTRA, ULTRA]);
  const attempts = [...new Set(events.filter((e) => e.state === 'retry').map((e) => `${e.reason} ${e.attempt}/${e.max}`))];
  assert.deepEqual(attempts, ['network 1/3', 'network 2/3', 'network 3/3']);
});

test('every model busy ends in all_failed with the last reasons', async () => {
  const tries = 1 + L.PRIMARY_RETRY_S.length + 1 + L.TRANSIENT_BACKOFF_S.length;
  serve(...Array.from({ length: tries }, () => http(500)));
  await assert.rejects(run(), (e) => {
    assert.equal(e.code, 'all_failed');
    assert.deepEqual(e.params.errors, [
      { model: 'lightning', reason: 'transient' }, { model: 'lightning', reason: 'transient' },
      { model: 'lightning', reason: 'transient' }]);
    return true;
  });
  assert.equal(calls.length, tries);
  assert.equal(unused(), 0);
  assert.equal(calls.filter((c) => c.body.model === ULTRA).length, 1 + L.PRIMARY_RETRY_S.length);
});

test('patience keeps the last model trying after the backoff table', async () => {
  const quick = 1 + 1 + L.TRANSIENT_BACKOFF_S.length;   // prefer speed: one try on ultra
  serve(...Array.from({ length: quick + 3 }, () => http(503)), sse(TEXT));
  const { res } = await run({ prefer: 'speed', patience: 600 });
  assert.equal(res.content, TEXT);
  assert.equal(calls.length, quick + 4);
  const [lo, hi] = jitterRange(L.PATIENCE_STEP_S);
  assert.ok(gap(quick + 2) >= lo && gap(quick + 2) <= hi, `waited ${gap(quick + 2)} s`);
});
