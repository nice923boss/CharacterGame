// Novel analysis (web/js/local/novel.js): the first part that fails stops the parts still being read
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calls, hang, http, load, serve, sse } from './harness.mjs';

const novel = await load('local/novel.js');
const { DATA } = await load('local/data.js');
const { NOVEL_PART_CHARS, NOVEL_PARALLEL } = DATA.limits;
const CONN = { key: 'nvapi-test-only', relay: 'https://relay.test' };

test('a refused part stops the other parts instead of letting them retry', async () => {
  const line = `${'夜'.repeat(99)}\n`;
  const text = line.repeat(Math.ceil((NOVEL_PART_CHARS * (NOVEL_PARALLEL + 0.5)) / line.length));
  const parts = novel.splitParts(text).length;
  assert.ok(parts > NOVEL_PARALLEL, `only ${parts} parts`);
  const spare = Array.from({ length: 20 }, () => sse('notes'));
  serve(http(401, '{"status":401}'), ...Array.from({ length: NOVEL_PARALLEL - 1 }, () => hang), ...spare);
  await assert.rejects(novel.analyzeNovel({ text, lang: 'zh' }, () => {}, CONN), (e) => e.code === 'key_rejected');
  // Let every timer run out: a part that was not stopped would time out and ask again
  await new Promise((resolve) => { setTimeout(resolve, 3_600_000); });
  assert.equal(calls.length, NOVEL_PARALLEL);
});
