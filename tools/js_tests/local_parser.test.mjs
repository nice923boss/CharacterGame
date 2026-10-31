// Browser turn parser (web/js/local/story.js) against the server parser fixes S15..S18 (server/turn_parser.py,
// server/tests/test_p10_server_turns.py): the same reply must give the same turn on GitHub Pages
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

const story = await load('local/story.js');
const CAST = new story.Cast([{ id: 'c1', name: '林映月' }], '阿澈');
const CURRENT = { scene_id: 'archive', bgm_mood: 'calm', weather: 'none' };
const OPTS = ['走', '留', '問'];

test('an upper-case fence and braces in the dialogue still find the JSON block', () => {
  assert.deepEqual(story.lastJson('x\n```JSON\n{"a": 1}\n```'), { a: 1 });
  // a fenced block comes before a bare object, whatever the case of the fence label
  assert.deepEqual(story.lastJson('```JSON\n{"a": 1}\n```\n{"b": 2}'), { a: 1 });
  assert.deepEqual(story.lastJson('@林映月|calm: 他寫了 {秘密} 兩個字。\n{"options": ["走", "留", "問"]}'), { options: OPTS });
  // the last object that reads wins; a broken one after it is passed over
  assert.deepEqual(story.lastJson('{"a": 1} 然後 {"b": 2} {壞的'), { b: 2 });
  // braces inside a JSON string do not end the object
  const quoted = '他說 {嗯}\n{"summary_update": "寫下 {x} 與 }", "options": ["a"]}';
  assert.deepEqual(story.lastJson(quoted), { summary_update: '寫下 {x} 與 }', options: ['a'] });
  assert.equal(story.lastJson('沒有 {JSON} 的回覆'), null);
});

test('many braces in the dialogue are passed over quickly', () => {
  const text = `${'@林映月|calm: {嗯\n'.repeat(20000)}{"options": ["走"]}`;
  const started = performance.now();
  assert.deepEqual(story.lastJson(text), { options: ['走'] });
  assert.ok(performance.now() - started < 2000);
});

test('null options are dropped and object options give their text', () => {
  const [r] = story.repair({ options: [null, { text: '走' }, { label: '留' }, '問', null] }, CAST, {}, CURRENT);
  assert.deepEqual(r.options, OPTS);
  const [r2] = story.repair({ options: [{ option: '走' }, { text: null, label: '留' }, ['問'], '等'],
    state_changes: { flags_add: [null, '鑰匙', {}] } }, CAST, {}, CURRENT);
  assert.deepEqual(r2.options, ['走', '留', '等']);
  assert.deepEqual(r2.state_changes.flags_add, ['鑰匙']);
});

test('null scene fields drop the scene change instead of making a "null" scene', () => {
  const [r, notes] = story.repair({ scene_change: true, scene: { id: null, name: null, image_prompt: null } },
    CAST, {}, CURRENT);
  assert.equal(r.scene_change, false);
  assert.equal(r.scene, null);
  assert.ok(notes.length);
  // false would read as the English prompt "false"
  const [r2] = story.repair({ scene_change: true, scene: { id: 'pier', name: false, image_prompt: false } },
    CAST, {}, CURRENT);
  assert.equal(r2.scene, null);
});

test('an ending whose type is not text is ignored', () => {
  const [r] = story.repair({ ending: { type: ['good'], title: 'x' }, options: OPTS }, CAST, {}, CURRENT,
    { allowEnding: true });
  assert.equal(r.ending, null);
  assert.deepEqual(r.options, OPTS);
  const [r2] = story.repair({ ending: { type: 'good' } }, CAST, {}, CURRENT, { allowEnding: true });
  assert.equal(r2.ending.type, 'good');
  assert.deepEqual(r2.options, []);
});

test('Infinity or NaN in the reply is skipped and the rest of the turn is kept', () => {
  const d = story.lastJson('```json\n{"state_changes": {"affection": {"林映月": Infinity}}, "options": ["走", "留", "問"]}\n```');
  const [r] = story.repair(d, CAST, {}, CURRENT);
  assert.deepEqual(r.state_changes.affection, {});
  assert.deepEqual(r.options, OPTS);
  assert.deepEqual(story.lastJson('{"a": NaN, "b": -Infinity, "c": "NaN 與 Infinity"}'),
    { a: null, b: null, c: 'NaN 與 Infinity' });
  const [r2] = story.repair({ state_changes: { affection: { 林映月: Infinity, 阿澈: 2 } } }, CAST, {}, CURRENT);
  assert.deepEqual(r2.state_changes.affection, {});
});
