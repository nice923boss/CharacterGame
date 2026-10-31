// Browser backend helpers that need no IndexedDB: key scrubbing in the diagnostic log, tree paths, the
// connection check without a relay, code-point truncation, and the new-story character checks
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calls, load, serve } from './harness.mjs';

const diag = await load('local/diag.js');
const store = await load('local/store.js');
const check = await load('local/check.js');
const story = await load('local/story.js');
const turns = await load('local/turns.js');
const { DATA } = await load('local/data.js');

test('every NVIDIA key in a diagnostic event is masked and long text is cut', () => {
  assert.equal(diag.scrubKeys('old nvapi-AAAA_1234-zz and new nvapi-BBBB'), 'old nvapi-*** and new nvapi-***');
  const event = diag.cleanEvent({ kind: 'x', message: `failed with nvapi-SECRET99 ${'y'.repeat(900)}`, status: 503 });
  assert.ok(!event.message.includes('SECRET99'));
  assert.equal(event.message.length, 500);
  assert.equal(event.status, 503);
});

test('a damaged tree gives node_not_found instead of hanging or crashing', () => {
  const ok = { nodes: { a: { parent: null }, b: { parent: 'a' } } };
  assert.deepEqual(store.pathTo(ok, 'b'), [ok.nodes.a, ok.nodes.b]);
  const loop = { nodes: { a: { parent: 'b' }, b: { parent: 'a' } } };
  assert.throws(() => store.pathTo(loop, 'a'), (e) => e.code === 'node_not_found');
  const missing = { nodes: { b: { parent: 'gone' } } };
  assert.throws(() => store.pathTo(missing, 'b'), (e) => e.code === 'node_not_found');
});

test('without a relay the connection check sends nothing to this site', async () => {
  serve();
  const r = await check.probe('text', { key: 'nvapi-test-only', relay: '' });
  assert.equal(r.state, 'unreachable');
  assert.equal(await check.relayState(''), 'unreachable');
  assert.equal(calls.length, 0);
});

test('clip counts an emoji as one character and never splits it', () => {
  assert.equal(story.clip('😀'.repeat(10), 5), '😀'.repeat(5));
  assert.equal(story.clip('a😀b', 3), 'a😀b');
  assert.equal(story.clip('hello world again', 8), 'hello');
});

test('a long option is cut by characters like the server, with no half emoji', () => {
  const limit = DATA.parser.MAX_OPTION_CHARS.en;
  const cast = new story.Cast([{ id: 'c1', name: 'Mia' }], 'Ren', 'en');
  const fits = '😀'.repeat(limit - 4);
  const long = `x${'😀'.repeat(limit + 5)}`;
  const [result] = story.repair({ options: [fits, long, 'Wait'] }, cast, {}, { scene_id: 'a', bgm_mood: 'calm' });
  assert.equal(result.options[0], fits);
  const cut = result.options[1];
  assert.equal([...cut].length, limit);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/[\uD800-\uDFFF]/.test(cut.replace(/\p{Extended_Pictographic}/gu, '')), 'no lone surrogate');
});

test('a new story with characters that are not a list of objects gets a readable error', async () => {
  const base = { lang: 'en', world: { era: 'now', place: 'Taipei' }, protagonist: { name: 'Ren' } };
  await assert.rejects(turns.createGame({ ...base, characters: { length: 1 } }, () => {}, {}),
    (e) => e.code === 'char_count');
  await assert.rejects(turns.createGame({ ...base, characters: [null] }, () => {}, {}),
    (e) => e.code === 'required' && e.params.field === 'char_name' && e.params.i === 1);
});
