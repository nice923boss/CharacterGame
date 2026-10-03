// Batch slot limiter (web/js/local/batch.js): slows down on busy answers, speeds up after successes
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { load } from './harness.mjs';

const batch = await load('local/batch.js');
const { DATA } = await load('local/data.js');
const { BATCH_CONCURRENCY, BATCH_GROW_AFTER } = DATA.limits;
const { limiter, isBusy } = batch._test;

beforeEach(() => { Object.assign(limiter, { limit: limiter.most, streak: 0, active: 0, waiting: [] }); });

test('busy answers halve the limit, never below 1', () => {
  assert.equal(limiter.limit, BATCH_CONCURRENCY);
  const expected = [];
  for (let n = BATCH_CONCURRENCY, i = 0; i < 5; i += 1) { n = Math.max(1, Math.floor(n / 2)); expected.push(n); }
  const seen = [];
  for (let i = 0; i < 5; i += 1) { limiter.busy(); seen.push(limiter.limit); }
  assert.deepEqual(seen, expected);
  assert.equal(seen.at(-1), 1);
});

test('BATCH_GROW_AFTER successes in a row give one slot back, up to the start value', () => {
  limiter.busy();
  const low = limiter.limit;
  for (let i = 0; i < BATCH_GROW_AFTER - 1; i += 1) limiter.ok();
  assert.equal(limiter.limit, low);
  limiter.ok();
  assert.equal(limiter.limit, low + 1);
  for (let i = 0; i < BATCH_GROW_AFTER * 20; i += 1) limiter.ok();
  assert.equal(limiter.limit, limiter.most);
});

test('a busy answer starts the success count again', () => {
  limiter.busy();
  const low = limiter.limit;
  for (let i = 0; i < BATCH_GROW_AFTER - 1; i += 1) limiter.ok();
  limiter.busy();
  const lower = limiter.limit;
  for (let i = 0; i < BATCH_GROW_AFTER - 1; i += 1) limiter.ok();
  assert.ok(lower <= low);
  assert.equal(limiter.limit, lower);
});

test('a turn waits for a free slot', async () => {
  limiter.limit = 1;
  await limiter.acquire();
  let second = false;
  const waiting = limiter.acquire().then(() => { second = true; });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(second, false);
  limiter.release();
  await waiting;
  assert.equal(second, true);
  limiter.release();
  assert.equal(limiter.active, 0);
});

test('only busy failures slow the batch down', () => {
  const failed = (...reasons) => ({ code: 'all_failed', params: { errors: reasons.map((reason) => ({ model: 'ultra', reason })) } });
  assert.equal(isBusy(failed('gone', 'transient')), true);
  assert.equal(isBusy(failed('timeout')), true);
  assert.equal(isBusy(failed('upstream')), true);
  assert.equal(isBusy(failed('gone', 'fatal', 'empty')), false);
  assert.equal(isBusy({ code: 'all_failed' }), false);
  assert.equal(isBusy({ code: 'key_rejected' }), false);
  assert.equal(isBusy(undefined), false);
});
