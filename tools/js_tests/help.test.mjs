// web/help.html page script, run against a fake page: language pick, anchors mapped to the shown language with a
// real fragment navigation, back to an anchor of the other language, focus after switching (phase 10, P24, P26, P35, P36)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const HTML = readFileSync(new URL('../../web/help.html', import.meta.url), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const IDS = [...HTML.matchAll(/<section id="([\w-]+)"/g)].map((m) => m[1]);
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function boot({ hash = '', stored = null, languages = ['en-US'] } = {}) {
  const listeners = {};
  const el = (props) => ({
    hidden: false, focusedWith: null, scrolled: 0,
    focus(opts) { this.focusedWith = opts; },
    scrollIntoView() { this.scrolled += 1; },
    ...props,
  });
  const mains = { zh: el({ dataset: { lang: 'zh' } }), en: el({ dataset: { lang: 'en' }, hidden: true }) };
  // The switch link inside each main points to the other language
  const switches = { zh: el({ dataset: { switch: 'en' } }), en: el({ dataset: { switch: 'zh' } }) };
  const sections = Object.fromEntries(IDS.map((id) => [id, el({ id })]));
  const navEn = [el({ href: 'https://x/help.html#busy' }), el({ href: 'https://x/help.html#key' })];
  const doc = {
    documentElement: {},
    title: '',
    getElementById: (id) => sections[id] || null,
    querySelector: (sel) => switches[sel.match(/^main\[data-lang="(\w+)"\] \[data-switch\]$/)[1]],
    querySelectorAll: (sel) => ({ main: Object.values(mains), '[data-switch]': Object.values(switches),
      'main[data-lang="en"] nav a': navEn })[sel],
  };
  // A fragment navigation changes the hash and fires hashchange as a later task, like a browser
  const loc = {
    hash,
    replaced: [],
    replace(url) {
      this.replaced.push(url);
      this.hash = url;
      setImmediate(() => listeners.hashchange?.());
    },
  };
  const history = { replaceState() { throw new Error('replaceState leaves :target on the old section'); } };
  new Function('document', 'location', 'navigator', 'localStorage', 'addEventListener', 'history', SCRIPT)(
    doc, loc, { languages, language: languages[0] }, { getItem: () => stored },
    (type, fn) => { listeners[type] = fn; }, history,
  );
  return {
    mains, switches, sections, loc, doc, navEn,
    async back(to) { loc.hash = to; listeners.hashchange(); await tick(); },
  };
}

test('the stored game language wins, then the first Chinese or English browser language', () => {
  const zh = boot({ languages: ['ja-JP', 'zh-TW', 'en-US'] });
  assert.equal(zh.mains.zh.hidden, false);
  assert.equal(zh.mains.en.hidden, true);
  assert.equal(zh.doc.documentElement.lang, 'zh-Hant');
  const en = boot({ languages: ['fr-FR', 'en-GB', 'zh-TW'] });
  assert.equal(en.mains.en.hidden, false);
  assert.equal(en.doc.documentElement.lang, 'en');
  assert.equal(boot({ stored: 'zh', languages: ['en-US'] }).mains.zh.hidden, false);
});

test('an anchor from the game opens the section of the shown language with a fragment navigation', async () => {
  const page = boot({ hash: '#relay', languages: ['en-US'] });
  assert.deepEqual(page.loc.replaced, ['#relay-en']);   // location.replace moves :target; replaceState would throw here
  await tick();
  assert.ok(page.sections['relay-en'].scrolled >= 1);
  assert.deepEqual(page.navEn.map((a) => a.href.split('#')[1]), ['busy-en', 'key-en']);
});

test('an anchor that is already right or unknown is left alone', () => {
  const right = boot({ hash: '#relay', languages: ['zh-TW'] });
  assert.deepEqual(right.loc.replaced, []);
  assert.equal(right.sections.relay.scrolled, 1);
  assert.deepEqual(boot({ hash: '#nothing', languages: ['zh-TW'] }).loc.replaced, []);
});

test('going back to an anchor of the other language shows this language\'s section', async () => {
  const page = boot({ hash: '#key-en', languages: ['en-US'] });
  await page.back('#relay');
  assert.deepEqual(page.loc.replaced, ['#relay-en']);
  assert.equal(page.mains.en.hidden, false);
});

test('switching language keeps the section and moves focus to the visible switch link without scrolling', async () => {
  const page = boot({ hash: '#busy', languages: ['zh-TW'] });
  let prevented = false;
  page.switches.zh.onclick({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(page.mains.zh.hidden, true);
  assert.equal(page.mains.en.hidden, false);
  assert.deepEqual(page.loc.replaced, ['#busy-en']);
  assert.deepEqual(page.switches.en.focusedWith, { preventScroll: true });
  await tick();
  assert.equal(page.mains.en.hidden, false);   // the hashchange that follows keeps English
});
