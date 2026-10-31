// Browser FLUX client (draw in web/js/local/images.js): busy answers, timeouts and refused keys
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { calls, hang, http, load, serve } from './harness.mjs';

const images = await load('local/images.js');
const { DATA } = await load('local/data.js');
const { t } = await load('i18n.js');
const A = DATA.art;
const CONN = { key: 'nvapi-test-only', relay: 'https://relay.test' };
const PICTURE = JSON.stringify({ artifacts: [{ finishReason: 'SUCCESS', base64: Buffer.from('png-bytes').toString('base64') }] });
const gap = (i) => (calls[i + 1].at - calls[i].at) / 1000;

images._test.useConn(() => CONN);
beforeEach(() => { localStorage.clear(); });

test('a busy answer is retried after the first backoff step', async () => {
  serve(http(503), http(200, PICTURE));
  const img = await images._test.draw('a quiet street at night', 42);
  assert.deepEqual(img, { bitmap: 'png-bytes' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${CONN.relay}${A.FLUX_PATH}`);
  assert.equal(calls[0].body.seed, 42);
  assert.equal(gap(0), A.RETRY_BACKOFF_S[0]);
});

test('Retry-After replaces the backoff step', async () => {
  serve(http(429, '', { 'Retry-After': '5' }), http(200, PICTURE));
  await images._test.draw('a quiet street at night', 1);
  assert.equal(gap(0), 5);
});

test('an image that takes too long is aborted and tried again', async () => {
  serve(hang, http(200, PICTURE));
  await images._test.draw('a quiet street at night', 1);
  assert.equal(gap(0), A.TIMEOUT_S + A.RETRY_BACKOFF_S[0]);
});

test('a refused key is not retried', async () => {
  serve(http(401));
  await assert.rejects(images._test.draw('a quiet street at night', 1),
    (e) => e.retryable === false && e.message === t('img.keyRejected', { status: 401 }));
  assert.equal(calls.length, 1);
});

test('a relay out of its daily allowance is not retried', async () => {
  serve(http(429, '{"error":"relay_quota"}'));
  await assert.rejects(images._test.draw('a quiet street at night', 1),
    (e) => e.retryable === false && e.message === t('err.relay_quota'));
  assert.equal(calls.length, 1);
});

test('busy every time gives up after the backoff table, still retryable later', async () => {
  serve(...Array.from({ length: A.RETRY_BACKOFF_S.length + 1 }, () => http(503)));
  await assert.rejects(images._test.draw('a quiet street at night', 1), (e) => e.retryable === true);
  assert.equal(calls.length, A.RETRY_BACKOFF_S.length + 1);
});

// A cutout as ImageData: opaque pixels where solid(x, y) is true
function cutout(w, h, solid) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (solid(x, y)) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data };
}

test('the face box of an empty or hairline cutout is the top of the picture, never NaN', () => {
  const empty = images._test.faceBox(cutout(40, 60, () => false));
  assert.deepEqual(empty, [0, 0, 40, Math.min(60, Math.trunc(40 * A.TALL))]);
  const thin = images._test.faceBox(cutout(40, 60, (x) => x === 7));
  assert.ok(thin.every(Number.isFinite), `got ${thin}`);
  const body = images._test.faceBox(cutout(40, 60, (x, y) => x >= 10 && x < 30 && y >= 5));
  assert.ok(body.every(Number.isFinite) && body[2] > body[0] && body[3] > body[1], `got ${body}`);
});

test('a saved queue entry of the wrong shape is not accepted', () => {
  const { validKey } = images._test;
  assert.equal(validKey(['scene', 'g1', 'opening']), true);
  assert.equal(validKey(['sprite', 'g1', 'c1', DATA.parser.EXPRESSIONS[0]]), true);
  for (const bad of [null, 'scene|g1|opening', ['scene', 'g1'], ['scene', 'g1', 3], ['sprite', 'g1', 'c1', 'shouting'],
    ['sprite', 'g1', 'c1'], ['other', 'g1', 'x'], ['scene', '', 'opening']]) {
    assert.equal(validKey(bad), false, JSON.stringify(bad));
  }
});

test('the drawn bitmap is closed once it is cropped, also when cropping fails', async () => {
  let closed = 0;
  const bitmap = { width: 8, height: 8, close: () => { closed += 1; } };
  await images._test.fitDrawn(Promise.resolve(bitmap), 4, 6).catch(() => {});
  assert.equal(closed, 1);
});
