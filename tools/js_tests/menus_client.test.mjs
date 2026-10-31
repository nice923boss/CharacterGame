// The server-build request wrapper (M01-M04), settings clean-up (M12), pasted keys (M28), the help line for a
// browser without storage (M17) and the menu strings added in phase 10 (both languages)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, hang, http, load, offline, serve, unused } from './harness.mjs';

// Server build (no cg-local meta); ui.js paints the offline badge and wires window listeners when it loads
const node = () => {
  const el = { children: [], hidden: false, append(...xs) { el.children.push(...xs); } };
  return el;
};
document.querySelector = (sel) => (sel === 'meta[name="cg-local"]' ? null : node());
document.createElement = () => node();
globalThis.window = { addEventListener() {} };

const { get, post, job } = await load('api.js');
const { DICT, errorText } = await load('i18n.js');
const { sanitizeSettings, helpNode } = await load('ui.js');
const { cleanKey } = await load('connect.js');

const fails = async (promise, code) => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    assert.equal(e.message, errorText(code, e.params));
    return true;
  });
};

test('M01: a request the network cannot send is err.offline, not a raw TypeError', async () => {
  serve(offline);
  await fails(get('/api/health'), 'offline');
});

test('M02: an empty 204 answer is null and an HTML page is an HTTP error with its status', async () => {
  serve(() => new Response(null, { status: 204 }), http(200, '<html>proxy</html>', { 'Content-Type': 'text/html' }));
  assert.equal(await post('/api/slots/1', {}), null);
  await assert.rejects(get('/api/games'), (e) => e.code === 'http' && e.params.status === 200);
  serve(http(400, JSON.stringify({ detail: { code: 'char_count', params: { max: 4 } } })));
  await fails(post('/api/games', {}), 'char_count');
  assert.equal(unused(), 0);
});

test('M03: a server that never answers gives request_timeout after 60 s', async () => {
  serve(hang);
  const start = clock();
  await fails(get('/api/health'), 'request_timeout');
  assert.equal(clock() - start, 60000);
});

test('M04: CRLF event streams are read and one broken event block is skipped', async () => {
  const body = 'data: {"type":"task","id":"t1"}\r\n\r\n: ping\r\n\r\ndata: {"type":"progress","n":1}\r\n\r\n'
    + 'data: {broken\r\n\r\ndata: {"type":"final","ok":true}\r\n\r\n';
  serve(http(200, body, { 'Content-Type': 'text/event-stream' }));
  const seen = [];
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const final = await job('/api/games', {}, (ev) => seen.push(ev.type)).done;
    assert.deepEqual(final, { type: 'final', ok: true });
  } finally { console.warn = warn; }
  assert.deepEqual(seen, ['progress', 'final']);
  assert.equal(warned.length, 1);
});

test('M12: settings are clamped, checked against the menu choices and stripped of unknown keys', () => {
  const s = sanitizeSettings({ speed: 0, bgm: 250, sfx: Number.NaN, weather: 'yes', patience: 42, prefer: 'speed',
    auto: 5, font: 'xl', contrast: true, extra: 1 });
  assert.deepEqual(s, { speed: 10, bgm: 100, sfx: 70, weather: true, patience: 300, prefer: 'speed', auto: 5,
    font: 'm', contrast: true });
  assert.deepEqual(sanitizeSettings(null), sanitizeSettings({}));
  assert.equal(sanitizeSettings('[]').speed, 45);
});

test('M28: zero-width characters, quotes and "Bearer" around a pasted key are removed', () => {
  assert.equal(cleanKey('​nvapi-‍AB⁠C­﻿'), 'nvapi-ABC');
  assert.equal(cleanKey(' "Bearer nvapi-xyz"\n'), 'nvapi-xyz');
  assert.equal(cleanKey(null), '');
});

test('M17: no browser storage gets its own help line and the storage help page; full storage keeps its line', () => {
  const text = (code) => helpNode(code).children[0];
  const link = (code) => helpNode(code).children.at(-1).href;
  assert.equal(text('db_unavailable'), DICT[langOf()]['help.dbUnavailable']);
  assert.equal(link('db_unavailable'), 'help.html#storage');
  assert.equal(text('storage_full'), DICT[langOf()]['help.storage']);
  assert.equal(helpNode('bad_slot'), null);
});

// The page language the modules picked (navigator in Node): the two help texts differ in both languages
function langOf() { return DICT.zh['help.storage'] === helpNode('storage_full').children[0] ? 'zh' : 'en'; }

test('phase 10 menu strings exist in both languages with the same placeholders', () => {
  const keys = ['err.request_timeout', 'setup.removeN', 'setup.novel.removeN', 'setup.leaveAsk', 'setup.leaveOk',
    'setup.novel.tooBig', 'stories.undo', 'help.dbUnavailable', 'archive.exportedSkipped', 'archive.importSkipped',
    'archive.noneSkipped'];
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort();
  for (const k of keys) {
    assert.ok(DICT.zh[k] && DICT.en[k], k);
    assert.deepEqual(holes(DICT.zh[k]), holes(DICT.en[k]), k);
  }
  assert.deepEqual(holes(DICT.zh['archive.exportedSkipped']), ['{files}', '{games}', '{skipped}']);
});
