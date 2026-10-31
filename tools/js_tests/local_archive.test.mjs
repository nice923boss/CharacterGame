// Folder import checks (validStory in web/js/local/archive.js): a story the game could not open is skipped
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

// archive.js imports backend.js, which opens IndexedDB at once: an open request that never answers keeps it
// waiting, and the page hooks it adds go nowhere
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.indexedDB = { open: () => ({}) };
const { validStory } = await load('local/archive.js');

const game = () => ({ id: 'g1', characters: [{ id: 'c1', name: 'Mia' }], scenes: { opening: { name: 'x', image_prompt: 'y' } } });
const tree = () => ({
  root: 'n_0000', next: 2,
  nodes: { n_0000: { parent: null, children: ['n_0001'] }, n_0001: { parent: 'n_0000', children: [] } },
});

test('a story with the shape the server writes is accepted', () => {
  assert.equal(validStory(game(), tree(), 'g1'), true);
  assert.equal(validStory(game(), { root: null, next: 0, nodes: {} }, 'g1'), true);
});

test('game.json of the wrong shape is skipped', () => {
  assert.equal(validStory(game(), tree(), 'g2'), false);
  assert.equal(validStory({ ...game(), characters: {} }, tree(), 'g1'), false);
  assert.equal(validStory({ ...game(), characters: [null] }, tree(), 'g1'), false);
  assert.equal(validStory({ ...game(), scenes: undefined }, tree(), 'g1'), false);
  assert.equal(validStory({ ...game(), scenes: { opening: null } }, tree(), 'g1'), false);
});

test('tree.json that would break the story view is skipped', () => {
  const cases = [
    (t) => { t.root = 'n_9999'; },
    (t) => { t.nodes.n_0000.children.push('constructor'); },
    (t) => { t.nodes.n_0001.parent = 'toString'; },
    (t) => { t.nodes.n_0001.children = 'n_0000'; },
    (t) => { t.nodes.n_0000.parent = 'n_0001'; },
    (t) => { delete t.next; },
    (t) => { t.root = null; },
  ];
  for (const [i, damage] of cases.entries()) {
    const t = tree();
    damage(t);
    assert.equal(validStory(game(), t, 'g1'), false, `case ${i}`);
  }
});
