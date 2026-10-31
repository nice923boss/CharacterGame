// web/js/i18n.js: the zh and en dictionaries cover every key in use, error text falls back like t(), a missing key
// warns once on a dev host, and the browser's language list picks the UI language (phase 10, P23-P27)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const JS = process.env.CG_JS_DIR;
const INDEX = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

// What i18n.js reads from the browser when it loads; each fresh() import is a new module instance
const warnings = [];
console.warn = (msg) => { warnings.push(msg); };
globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
let loads = 0;
async function fresh({ languages = ['ja-JP', 'zh-TW', 'en-US'], language = languages[0], host = 'localhost' } = {}) {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages, language } });
  globalThis.location = { hostname: host };
  loads += 1;
  return import(`${pathToFileURL(join(JS, 'i18n.js')).href}?load=${loads}`);
}

const i18n = await fresh();
const { DICT } = i18n;
const placeholders = (s) => [...new Set(s.match(/\{\w+\}/g) || [])].sort();

test('the first Chinese or English entry of the browser language list picks the UI language', async () => {
  assert.equal(i18n.lang, 'zh');   // ja-JP, zh-TW, en-US
  assert.equal((await fresh({ languages: ['ja-JP', 'en-GB', 'zh-TW'] })).lang, 'en');
  assert.equal((await fresh({ languages: ['ko-KR'] })).lang, 'en');
  assert.equal((await fresh({ languages: [], language: 'zh-HK' })).lang, 'zh');   // older browsers: language only
});

test('zh and en have the same keys and the same {placeholders}', () => {
  const zh = Object.keys(DICT.zh);
  const en = Object.keys(DICT.en);
  assert.deepEqual(zh.filter((k) => !(k in DICT.en)), [], 'keys missing in en');
  assert.deepEqual(en.filter((k) => !(k in DICT.zh)), [], 'keys missing in zh');
  const differ = zh.filter((k) => k in DICT.en
    && placeholders(DICT.zh[k]).join() !== placeholders(DICT.en[k]).join());
  assert.deepEqual(differ, [], 'keys whose zh and en placeholders differ');
});

test('every data-i18n and data-i18n-ph key in index.html exists', () => {
  const keys = [...INDEX.matchAll(/data-i18n(?:-ph)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 50);
  assert.deepEqual([...new Set(keys.filter((k) => !(k in DICT.zh)))], []);
});

test('every literal t() key in the modules that import t from i18n.js exists', () => {
  const files = readdirSync(JS, { recursive: true }).filter((f) => String(f).endsWith('.js'));
  const missing = [];
  let checked = 0;
  for (const f of files) {
    const src = readFileSync(join(JS, String(f)), 'utf8');
    // Only modules that use i18n's t(): local/story.js has its own t() for story-language text
    if (!/import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'\.{1,2}\/(?:\.\.\/)*i18n\.js'/.test(src)) continue;
    for (const m of src.matchAll(/(?<![\w.$])t\(\s*'([a-zA-Z]\w*(?:\.\w+)+)'/g)) {
      checked += 1;
      if (!(m[1] in DICT.zh)) missing.push(`${f}: ${m[1]}`);
    }
  }
  assert.ok(checked > 100, `only ${checked} keys found; the pattern no longer matches the code`);
  assert.deepEqual(missing, []);
});

test('errorText falls back to the Chinese text before showing the bare code', () => {
  const saved = DICT.en['err.offline'];
  try {
    i18n.setLang('en');
    delete DICT.en['err.offline'];
    assert.equal(i18n.errorText('offline'), DICT.zh['err.offline']);
    assert.equal(i18n.errorText('no_such_code'), 'no_such_code');
  } finally {
    DICT.en['err.offline'] = saved;
    i18n.setLang('zh');
  }
});

test('a missing key shows the key and warns once, only on a dev host', async () => {
  warnings.length = 0;
  assert.equal(i18n.t('test.noSuchKey'), 'test.noSuchKey');
  i18n.t('test.noSuchKey');
  assert.deepEqual(warnings, ['i18n: no zh text for "test.noSuchKey"']);
  const online = await fresh({ host: 'nice923boss.github.io' });
  warnings.length = 0;
  online.t('test.noSuchKey');
  assert.deepEqual(warnings, []);
});
