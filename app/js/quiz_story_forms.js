// The HTML of the story editor (quiz_story_edit.js): the page list, one form per page type, the items and the
// scenes. Every field has data-k with its path in the quest; data-as says how its value is read (num, bool, lines,
// need); data-redraw asks for the whole tab again after a change. Text the player sees is English (lang="en").
import { t } from './i18n.js?v=6f163306a287';
import { esc } from './ui.js?v=6f163306a287';
import { LIMITS, MAX_CHARS, SDGS, SDG_LOOK } from './quest.js?v=6f163306a287';
import { ITEM_KINDS, PAGE_TYPES, STORY_LIMITS as L, STORY_MAX } from './quest_story.js?v=6f163306a287';

export const ICON = { narration: '📖', talk: '💬', caption: '🔤', chapter: '🔖', puzzle: '🧩', notice: '📌', item: '🎒', choice: '🔀', ending: '🏁' };
export const KIND_ICON = { doc: '📄', image: '🖼️', person: '🙂' };

const help = (name) => `<small class="qs-help">${esc(t(`qs.h.${name}`))}</small>`;

// A text field: its label, the box, and one line on what it is for (name picks qs.f.<name> and qs.h.<name>)
function field(k, name, value, { area = false, max, ph = '', rows = 2, en = true, list = '' } = {}) {
  const attrs = `data-k="${k}" maxlength="${max}" placeholder="${esc(ph)}"${en ? ' lang="en"' : ''}`;
  return `<label><span>${esc(t(`qs.f.${name}`))}</span>${area
    ? `<textarea ${attrs} rows="${rows}">${esc(value)}</textarea>`
    : `<input ${attrs} value="${esc(value)}"${list ? ` list="${list}"` : ''}>`}${help(name)}</label>`;
}

const select = (k, name, value, options, redraw = false) => `<label><span>${esc(t(`qs.f.${name}`))}</span>
  <select data-k="${k}"${redraw ? ' data-redraw' : ''}>${options.map(([v, text]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>${help(name)}</label>`;

const check = (k, name, on) => `<label class="check"><input type="checkbox" data-k="${k}" data-as="bool"${on ? ' checked' : ''}>
  <span>${esc(t(`qs.f.${name}`))}</span></label>${help(name)}`;

const btn = (act, text, attrs = '', off = false) => `<button class="btn tiny" data-do="${act}"${attrs}${off ? ' disabled' : ''}>${esc(text)}</button>`;

const cut = (s, n = 26) => (s.length > n ? `${s.slice(0, n)}…` : s);

// A few words that tell the page apart in the list and in the jump menus
export function summary(p, S) {
  const name = p.type === 'item' ? S.items.find((i) => i.id === p.item)?.name || '' : '';
  const text = p.type === 'talk' ? (p.speaker ? `${p.speaker}: ${p.text}` : p.text)
    : p.type === 'chapter' ? [p.heading, p.title].filter(Boolean).join(' ') : name || p.title || p.text || '';
  return cut(text.replace(/\s+/g, ' ').trim()) || t('qs.empty');
}

export const jumpsOf = (p) => (p.type === 'choice' ? p.options.map((o) => o.goto) : [p.goto]).filter(Boolean);

// One row of the page list; the editor redraws only the open page's row while its form is being typed in
export function rowHtml(S, i, cur) {
  const p = S.pages[i];
  const jumps = jumpsOf(p).map((g) => S.pages.findIndex((x) => x.id === g) + 1 || '?');
  return `<button class="qs-row${i === cur ? ' on' : ''}" data-page="${i}"><b>${i + 1}</b><span aria-hidden="true">${ICON[p.type]}</span>
    <span class="qs-sum">${esc(summary(p, S))}</span>${jumps.length ? `<small>→ ${jumps.join(', ')}</small>` : ''}</button>`;
}

export const listHtml = (S, cur) => S.pages.map((_, i) => rowHtml(S, i, cur)).join('') || `<p class="hint">${esc(t('qs.noPages'))}</p>`;

const sceneSelect = (k, S, value) => select(k, 'scene', value, [['', t('qs.sceneKeep')], ...S.scenes.map((s) => [s.id, s.name || s.id])]);

// The pages a page can jump to: every page but itself, "next page" first
function gotoOptions(S, self) {
  return [['', t('qs.gotoNext')], ...S.pages.flatMap((p, i) => (p.id === self ? [] : [[p.id, `${i + 1}. ${ICON[p.type]} ${summary(p, S)}`]]))];
}

function puzzleHtml(p, k) {
  const shown = Array.from({ length: Math.max(2, p.options.length) }, (_, j) => p.options[j] ?? '');
  const kind = (v) => `<label class="qz-ans"><input type="radio" name="qs-kind" data-k="${k}.kind" data-redraw value="${v}"${p.kind === v ? ' checked' : ''}>
    <span>${esc(t(`qs.kind.${v}`))}</span></label>`;
  const answers = p.kind === 'choice'
    ? `<span class="qz-sub">${esc(t('qs.f.options'))}</span>${shown.map((o, j) => `<div class="qs-opt">
        <label class="qz-ans"><input type="radio" name="qs-answer" data-k="${k}.answer" data-as="num" value="${j}"${p.answer === j ? ' checked' : ''}><span>${esc(t('qs.correct'))}</span></label>
        <input data-k="${k}.options.${j}" maxlength="${L.option}" value="${esc(o)}" placeholder="${esc(t('qs.optN', { n: j + 1 }))}" lang="en">
        ${btn('optDel', '✕', ` data-j="${j}" aria-label="${esc(t('qs.optDel'))}"`, shown.length <= 2)}</div>`).join('')}
      ${btn('optAdd', t('qs.optAdd'), '', shown.length >= STORY_MAX.options)}${help('options')}`
    : `<label><span>${esc(t('qs.f.accept'))}</span><textarea data-k="${k}.accept" data-as="lines" rows="3" lang="en">${esc(p.accept.join('\n'))}</textarea>${help('accept')}</label>
      ${field(`${k}.placeholder`, 'placeholder', p.placeholder, { max: L.placeholder, ph: 'Type the password' })}`;
  return `${field(`${k}.title`, 'title', p.title, { max: L.title, ph: 'Puzzle 1' })}
    ${field(`${k}.text`, 'question', p.text, { area: true, rows: 3, max: L.text })}
    <span class="qz-sub">${esc(t('qs.f.kind'))}</span><div class="qz-answers">${kind('choice')}${kind('input')}</div>${answers}
    <span class="qz-sub">${esc(t('qs.f.hints'))}</span>${[0, 1, 2].map((j) => `<input class="qs-hint" data-k="${k}.hints.${j}" maxlength="${L.hint}" value="${esc(p.hints[j] ?? '')}" placeholder="${esc(t('qs.hintN', { n: j + 1 }))}" lang="en">`).join('')}${help('hints')}
    ${field(`${k}.reveal`, 'reveal', p.reveal, { area: true, max: L.feedback })}
    <div class="row2">${field(`${k}.right`, 'right', p.right, { max: L.feedback, ph: 'Correct!' })}${field(`${k}.wrong`, 'wrong', p.wrong, { max: L.feedback, ph: 'Not quite. Try again!' })}</div>`;
}

function choiceHtml(p, k, S) {
  const goto = gotoOptions(S, p.id);
  const rows = p.options.map((o, j) => {
    const others = p.options.filter((x) => x.id !== o.id);
    return `<div class="qs-choice">
      <div class="qs-opt"><b>${j + 1}</b><input data-k="${k}.options.${j}.label" maxlength="${L.option}" value="${esc(o.label)}" placeholder="${esc(t('qs.optLabel'))}" lang="en">
        ${btn('optDel', '✕', ` data-j="${j}" aria-label="${esc(t('qs.optDel'))}"`, p.options.length <= 1)}</div>
      <select data-k="${k}.options.${j}.goto" aria-label="${esc(t('qs.f.goto'))}">${goto.map(([v, text]) => `<option value="${esc(v)}"${v === o.goto ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" data-k="${k}.options.${j}.once" data-as="bool"${o.once ? ' checked' : ''}><span>${esc(t('qs.once'))}</span></label>
      ${others.length ? `<div class="qs-needs"><span>${esc(t('qs.needs'))}</span>${others.map((x) => `<label class="check"><input type="checkbox" data-k="${k}.options.${j}.needs" data-as="need" value="${x.id}"${o.needs.includes(x.id) ? ' checked' : ''}>
        <span>${p.options.indexOf(x) + 1}</span></label>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  return `${field(`${k}.title`, 'title', p.title, { max: L.title, ph: 'What will you do?' })}
    ${field(`${k}.text`, 'text', p.text, { area: true, max: L.text })}${sceneSelect(`${k}.scene`, S, p.scene)}
    <span class="qz-sub">${esc(t('qs.f.choices'))}</span>${rows}${btn('optAdd', t('qs.optAdd'), '', p.options.length >= STORY_MAX.options)}${help('choices')}
    ${check(`${k}.retry`, 'retry', p.retry)}`;
}

// The form of the page at index i; its type picks the fields
export function formHtml(S, i) {
  const p = S.pages[i];
  if (!p) return `<p class="hint">${esc(t('qs.noPages'))}</p>`;
  const k = `pages.${i}`;
  const text = (name = 'text', rows = 3) => field(`${k}.text`, name, p.text, { area: true, rows, max: L.text });
  const scene = () => sceneSelect(`${k}.scene`, S, p.scene);
  const title = (ph) => field(`${k}.title`, 'title', p.title, { max: L.title, ph });
  const names = [...new Set([...S.characters.map((c) => c.name), ...S.items.filter((x) => x.kind === 'person').map((x) => x.name), 'Narrator'].filter(Boolean))];
  const body = {
    narration: () => text('text', 4) + scene(),
    caption: () => text('text', 2) + scene(),
    talk: () => `<div class="row2">${field(`${k}.speaker`, 'speaker', p.speaker, { max: L.name, list: 'qs-names' })}${field(`${k}.label`, 'label', p.label, { max: L.label })}</div>
      ${text('line')}${scene()}<datalist id="qs-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`,
    chapter: () => `<div class="row2">${field(`${k}.heading`, 'heading', p.heading, { max: L.heading, ph: 'Chapter 1' })}${title('The Missing Map')}</div>${scene()}`,
    notice: () => title('Your mission') + text(),
    ending: () => title('A Cleaner River') + text() + scene(),
    item: () => `${select(`${k}.item`, 'item', p.item, [['', t('qs.itemNone')], ...S.items.map((x) => [x.id, `${KIND_ICON[x.kind]} ${x.name || t('qs.empty')}`])])}
      ${select(`${k}.action`, 'action', p.action, [['get', t('qs.action.get')], ['update', t('qs.action.update')]])}
      ${field(`${k}.text`, 'itemText', p.text, { area: true, rows: 3, max: L.itemText })}`,
    puzzle: () => puzzleHtml(p, k) + scene(),
    choice: () => choiceHtml(p, k, S),
  }[p.type]();
  const goto = p.type === 'choice' || p.type === 'ending' ? '' : select(`${k}.goto`, 'goto', p.goto, gotoOptions(S, p.id));
  return `<div class="qs-form-head"><h3>${esc(t('qs.pageN', { n: i + 1 }))}</h3>
      <select id="qs-type" aria-label="${esc(t('qs.type'))}">${PAGE_TYPES.map((x) => `<option value="${x}"${x === p.type ? ' selected' : ''}>${ICON[x]} ${esc(t(`qs.t.${x}`))}</option>`).join('')}</select>
      <button class="btn small" data-do="tryFrom">${esc(t('qs.tryFrom'))}</button></div>
    <p class="hint">${esc(t(`qs.th.${p.type}`))}</p>${body}${goto}`;
}

export function pagesHtml(S, cur, addType) {
  const last = S.pages.length - 1;
  return `<div class="qs-pages">
    <div class="qs-side">
      <div class="qs-tools">
        <select id="qs-add-type" aria-label="${esc(t('qs.addType'))}">${PAGE_TYPES.map((x) => `<option value="${x}"${x === addType ? ' selected' : ''}>${ICON[x]} ${esc(t(`qs.t.${x}`))}</option>`).join('')}</select>
        ${btn('pgAdd', t('qs.pgAdd'), '', S.pages.length >= STORY_MAX.pages)}
        ${btn('pgCopy', t('qs.pgCopy'), '', cur > last || S.pages.length >= STORY_MAX.pages)}${btn('pgUp', '↑', ` aria-label="${esc(t('qs.pgUp'))}"`, cur <= 0 || cur > last)}
        ${btn('pgDown', '↓', ` aria-label="${esc(t('qs.pgDown'))}"`, cur >= last)}${btn('pgDel', t('qs.pgDel'), '', cur > last)}
      </div>
      <div id="qs-list" class="qs-list">${listHtml(S, cur)}</div>
    </div>
    <div id="qs-form" class="qs-form">${formHtml(S, cur)}</div>
  </div>`;
}

export function infoHtml(S) {
  const sdgs = SDGS.map((s) => [s, `${SDG_LOOK[s].icon} ${t(`quiz.sdg.${s}`)}`]);
  return `<section class="qz-sec"><h3>${esc(t('qs.tab.info'))}</h3>
    <label><span>${esc(t('quiz.gameTitle'))}</span><input data-k="title" maxlength="${LIMITS.title}" value="${esc(S.title)}" placeholder="The Lost Key">${help('gameTitle')}</label>
    <div class="row2"><label><span>${esc(t('quiz.sdg'))}</span><select data-k="sdg" data-redraw>${sdgs.map(([v, text]) => `<option value="${v}"${S.sdg === v ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select>${help('sdg')}</label>
      ${S.sdg === 'other' ? `<label><span>${esc(t('quiz.sdgOther'))}</span><input data-k="sdg_other" maxlength="${LIMITS.sdgOther}" value="${esc(S.sdg_other)}"></label>` : '<span></span>'}</div>
    <span class="qz-sub">${esc(t('quiz.chars'))}</span>
    ${S.characters.map((c, i) => `<div class="qz-line qz-char">
      <input data-k="characters.${i}.name" maxlength="${LIMITS.name}" value="${esc(c.name)}" placeholder="${esc(t('quiz.charName'))}" lang="en">
      <input data-k="characters.${i}.who" maxlength="${LIMITS.who}" value="${esc(c.who)}" placeholder="${esc(t('quiz.charWho'))}">
      <button class="btn tiny ghost" data-do="delChar" data-i="${i}" aria-label="${esc(t('quiz.delChar'))}">✕</button></div>`).join('')}
    ${btn('addChar', t('quiz.addChar'), '', S.characters.length >= MAX_CHARS)}${help('chars')}
  </section>`;
}

// The picture of a scene or an item with its draw and upload buttons
function picHtml(slot, pics, name) {
  return `<div class="qs-pic">${pics[slot] ? `<img src="${esc(pics[slot])}" alt="${esc(name)}">` : `<span class="qz-nopic">${esc(t('quiz.pic.none'))}</span>`}
    <span>${btn('pic', t(pics[slot] ? 'quiz.pic.redraw' : 'quiz.pic.draw'), ` data-slot="${slot}"`)}
    ${btn('upload', t(pics[slot] ? 'quiz.pic.replace' : 'quiz.pic.upload'), ` data-slot="${slot}"`)}</span></div>`;
}

function itemHtml(it, i, pics) {
  const k = `items.${i}`;
  const keywords = it.kind !== 'person' ? '' : `<span class="qz-sub">${esc(t('qs.f.keywords'))}</span>
    ${it.keywords.map((w, j) => `<div class="qs-kw">
      <input data-k="${k}.keywords.${j}.words" maxlength="${(L.word + 2) * STORY_MAX.words}" value="${esc(Array.isArray(w.words) ? w.words.join(', ') : w.words)}" placeholder="${esc(t('qs.kwWords'))}" lang="en">
      <textarea data-k="${k}.keywords.${j}.reply" rows="2" maxlength="${L.reply}" placeholder="${esc(t('qs.kwReply'))}" lang="en">${esc(w.reply)}</textarea>
      <button class="btn tiny ghost" data-do="kwDel" data-i="${i}" data-j="${j}" aria-label="${esc(t('qs.kwDel'))}">✕</button></div>`).join('')}
    ${btn('kwAdd', t('qs.kwAdd'), ` data-i="${i}"`, it.keywords.length >= STORY_MAX.keywords)}${help('keywords')}
    ${field(`${k}.miss`, 'miss', it.miss, { max: L.feedback, ph: "Sorry, I don't know about that." })}`;
  return `<section class="qz-sec"><div class="qz-head"><h3>${KIND_ICON[it.kind]} ${esc(it.name || t('qs.empty'))}</h3>
      <button class="btn tiny ghost" data-do="itDel" data-i="${i}">✕ ${esc(t('qs.itDel'))}</button></div>
    <div class="row2">${select(`${k}.kind`, 'itemKind', it.kind, ITEM_KINDS.map((x) => [x, `${KIND_ICON[x]} ${t(`qs.k.${x}`)}`]), true)}
      ${field(`${k}.name`, 'name', it.name, { max: L.name, ph: it.kind === 'person' ? 'Ms. Lin' : 'Old Map' })}</div>
    ${field(`${k}.text`, `itText.${it.kind}`, it.text, { area: true, rows: it.kind === 'doc' ? 5 : 2, max: L.itemText })}
    ${keywords}
    ${field(`${k}.scene`, 'picDesc', it.scene, { area: true, max: L.scene })}${picHtml(`i${it.id}`, pics, it.name)}
  </section>`;
}

export function itemsHtml(S, pics) {
  return `<p class="hint">${esc(t('qs.itemsHint'))}</p>
    <div class="qz-draft">${ITEM_KINDS.map((x) => btn('itAdd', t(`qs.itAdd.${x}`), ` data-kind="${x}"`, S.items.length >= STORY_MAX.items)).join('')}</div>
    ${S.items.map((it, i) => itemHtml(it, i, pics)).join('') || `<p class="hint qz-empty">${esc(t('qs.noItems'))}</p>`}`;
}

export function scenesHtml(S, pics) {
  return `<p class="hint">${esc(t('qs.scenesHint'))}</p>
    <div class="qz-draft">${btn('scAdd', t('qs.scAdd'), '', S.scenes.length >= STORY_MAX.scenes)}
      <button class="btn" data-do="picsAll">${esc(t('quiz.pic.all'))}</button><p class="hint">${esc(t('qs.picsAllHint'))}</p></div>
    ${S.scenes.map((s, i) => `<section class="qz-sec"><div class="qz-head"><h3>🖼️ ${esc(s.name || t('qs.empty'))}</h3>
        <button class="btn tiny ghost" data-do="scDel" data-i="${i}">✕ ${esc(t('qs.scDel'))}</button></div>
      ${field(`scenes.${i}.name`, 'sceneName', s.name, { max: L.sceneName, en: false, ph: t('qs.ph.sceneName') })}
      ${field(`scenes.${i}.scene`, 'scenePrompt', s.scene, { area: true, max: L.scene, ph: 'a night market entrance with red lanterns' })}
      ${picHtml(`s${s.id}`, pics, s.name)}</section>`).join('') || `<p class="hint qz-empty">${esc(t('qs.noScenes'))}</p>`}`;
}
