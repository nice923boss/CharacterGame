// presets.json against the rules server/turn_service.py create_game applies (M39): a preset that breaks one of
// them only fails when a player starts a story with it
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { load } from './harness.mjs';

const { LIMIT_SCALE } = await load('i18n.js');
const presets = JSON.parse(await readFile(new URL('../../web/presets.json', import.meta.url), 'utf-8'));

// create_game: world fields 200, protagonist name 12 and profile 200, character fields as below (x LIMIT_SCALE)
const WORLD = ['era', 'place', 'genre', 'tone', 'extra', 'goal'];
const CHAR = { name: 12, appearance: 300, personality: 200, speech: 200, relationship: 200 };
const NARRATOR = ['旁白', 'Narrator'];   // server/turn_parser.py NARRATOR: taken in every language
const chars = (s) => [...String(s ?? '').trim()].length;   // Python len() counts code points

test('presets.json holds the same shape in Chinese and English', () => {
  assert.deepEqual(Object.keys(presets).sort(), ['en', 'zh']);
  const { zh, en } = presets;
  assert.equal(zh.worlds.length, en.worlds.length);
  assert.equal(zh.characters.length, en.characters.length);
  assert.deepEqual(Object.keys(zh.protagonist).sort(), Object.keys(en.protagonist).sort());
  zh.worlds.forEach((w, i) => assert.deepEqual(Object.keys(w).sort(), Object.keys(en.worlds[i]).sort()));
});

for (const lang of ['zh', 'en']) {
  const p = presets[lang];
  const x = LIMIT_SCALE[lang];

  test(`${lang}: every world has a label, era and place within the length limits`, () => {
    assert.ok(p.worlds.length >= 1);
    for (const w of p.worlds) {
      assert.ok(chars(w.label) > 0, 'label');
      assert.ok(chars(w.era) > 0 && chars(w.place) > 0, `${w.label}: era and place are required`);
      for (const k of WORLD) assert.ok(chars(w[k]) <= 200 * x, `${w.label}.${k} is ${chars(w[k])} long`);
    }
  });

  test(`${lang}: protagonist and 1 to 4 characters are filled in within the limits`, () => {
    assert.ok(chars(p.protagonist.name) > 0 && chars(p.protagonist.name) <= 12 * x);
    assert.ok(chars(p.protagonist.profile) <= 200 * x);
    assert.ok(p.characters.length >= 1 && p.characters.length <= 4);
    for (const c of p.characters) {
      for (const [k, max] of Object.entries(CHAR)) {
        assert.ok(chars(c[k]) > 0, `${c.name}.${k} is required`);
        assert.ok(chars(c[k]) <= max * x, `${c.name}.${k} is ${chars(c[k])} long, limit ${max * x}`);
      }
    }
  });

  test(`${lang}: names are unique and none is the narrator`, () => {
    const names = [...p.characters.map((c) => c.name.trim()), p.protagonist.name.trim()];
    assert.equal(new Set(names).size, names.length, names.join(', '));
    for (const n of names) assert.ok(!NARRATOR.includes(n), n);
  });
}
