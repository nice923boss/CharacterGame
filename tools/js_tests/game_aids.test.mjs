// Pure helpers behind the game screen: surrogate-safe cuts (G19), log text and search (G37, G38), tree label
// fitting (G30), the stage's decoded-picture eviction (G23) and the remembered mute (G20)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './harness.mjs';

// ui.js wires window listeners and paints the offline badge when it loads
globalThis.window = { addEventListener() {} };
document.querySelector = () => ({});

const { safeEnd, logText, matchLog } = await load('playaids.js');
const { fitText } = await load('tree.js');
const { evictable } = await load('stage.js');
const { sound } = await load('sound.js');

const cut = (s, n) => s.slice(0, safeEnd(s, n));

test('safeEnd never ends a slice on the first half of a surrogate pair', () => {
  const s = '花😀開';   // 4 UTF-16 units: the emoji takes two
  assert.equal(cut(s, 1), '花');
  assert.equal(cut(s, 2), '花');   // would have kept half the emoji
  assert.equal(cut(s, 3), '花😀');
  assert.equal(cut(s, 4), s);
  assert.equal(safeEnd('😀a', 1), 2);   // nothing before the pair: the cut moves past it instead
  assert.equal(safeEnd(s, 0), 0);
  assert.equal(safeEnd(s, 9), 9);
});

const entries = [
  { kind: 'sep' },
  { kind: 'player', speaker: '小雨', text: '走吧' },
  { kind: 'narration', speaker: '', text: '雨停了。' },
  { kind: 'sep' },
  { kind: 'sep' },
  { kind: 'dialogue', speaker: 'Ada', text: 'Hello there' },
];

test('logText: one line each, the speaker before spoken lines, one blank line between turns', () => {
  assert.equal(logText(entries, '：'), '小雨：走吧\n雨停了。\n\nAda：Hello there');
  assert.equal(logText(entries.slice(-1), ': '), 'Ada: Hello there');
  assert.equal(logText([], '：'), '');
});

test('matchLog: speaker or text, any case; a blank query keeps everything', () => {
  assert.equal(matchLog(entries, '   '), entries);
  assert.deepEqual(matchLog(entries, 'HELLO'), [entries[5]]);
  assert.deepEqual(matchLog(entries, ' ada '), [entries[5]]);
  assert.deepEqual(matchLog(entries, '雨'), [entries[1], entries[2]]);   // a speaker name and a narration line
  assert.deepEqual(matchLog(entries, '沒有這句'), []);
});

const upTo = (k) => (s) => [...s].length <= k;

test('fitText keeps the longest prefix that fits, with an ellipsis', () => {
  assert.equal(fitText('雲深不知處', upTo(10)), '雲深不知處');
  assert.equal(fitText('雲深不知處', upTo(4)), '雲深不…');
  assert.equal(fitText('雲深不知處', upTo(0)), '雲…');   // never shorter than one character
  assert.equal(fitText('雲', () => false), '雲');
  assert.equal(fitText('', () => false), '');
});

test('fitText cuts between code points and measures only a few times', () => {
  assert.equal(fitText('😀😀😀😀', upTo(3)), '😀😀…');
  let measured = 0;
  const long = '長'.repeat(300);
  const out = fitText(long, (s) => { measured += 1; return [...s].length <= 41; });
  assert.equal(out, `${'長'.repeat(40)}…`);
  assert.ok(measured <= 11, `measured ${measured} times`);
});

const pic = (n) => ({ n });

test('evictable drops the least recently used decoded pictures down to max', () => {
  const cache = new Map([['a', pic(1)], ['b', 'loading'], ['c', pic(3)], ['d', pic(4)], ['e', pic(5)], ['f', 'error']]);
  assert.deepEqual(evictable(cache, new Set(), 2), ['a', 'c']);
  assert.deepEqual(evictable(cache, new Set(), 4), []);
  assert.deepEqual(evictable(cache, new Set(), 0), ['a', 'c', 'd', 'e']);   // downloads in flight and failures stay
});

test('evictable keeps what the stage shows, by url or by picture', () => {
  const cache = new Map([['a', pic(1)], ['c', pic(3)], ['d', pic(4)], ['e', pic(5)]]);
  assert.deepEqual(evictable(cache, new Set(['a']), 2), ['c', 'd']);
  assert.deepEqual(evictable(cache, new Set([cache.get('c')]), 2), ['a', 'd']);
  assert.deepEqual(evictable(cache, new Set(['a', 'c', 'd', 'e']), 0), []);
});

test('M mute is remembered in localStorage and cleared when turned off', () => {
  assert.equal(sound.muted, false);
  assert.equal(sound.toggleMute(), true);
  assert.equal(localStorage.getItem('chienzhi.muted'), '1');
  assert.equal(sound.toggleMute(), false);
  assert.equal(localStorage.getItem('chienzhi.muted'), null);
});
