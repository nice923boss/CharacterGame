// Node tree map: one circle per turn laid out left to right, branches stacked downward,
// consecutive turns in the same scene wrapped in a labelled box. Hover shows the turn, click jumps there.
// Branches a batch could not write hang off their parent as red stubs; clicking one writes it again.
// Options nobody picked yet hang off their turn as dashed stubs; clicking one starts writing from there.
import { errorText, t } from './i18n.js?v=69d1ef9c6b81';
import { $, esc } from './ui.js?v=69d1ef9c6b81';

const DX = 58;
const DY = 46;
const PAD = 40;

// Own children only: a merge-back link (a branch rejoining the main line) is drawn as a dashed edge, not walked again
const kidsOf = (tree, id) => tree.nodes[id].children.filter((c) => tree.nodes[c]?.parent === id);

// stubs: parent id -> ids of failed-branch stubs, laid out as extra leaves of that parent
function layout(tree, stubs) {
  const pos = {};
  let row = 0;
  let maxDepth = 0;
  const walk = (id, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = tree.nodes[id] ? [...kidsOf(tree, id), ...(stubs[id] || [])] : [];
    if (!kids.length) { pos[id] = { x: PAD + depth * DX, y: PAD + 18 + row * DY, depth }; row++; return; }
    kids.forEach((c) => walk(c, depth + 1));
    pos[id] = { x: PAD + depth * DX, y: pos[kids[0]].y, depth };
  };
  if (tree.root) walk(tree.root, 0);
  return { pos, width: PAD * 2 + maxDepth * DX + 40, height: PAD * 2 + row * DY };
}

// Options of every turn that no child was written for: [{parent, option}]
export function untakenOptions(tree) {
  const out = [];
  for (const n of Object.values(tree.nodes)) {
    if (n.result?.ending) continue;
    const taken = new Set(n.children.map((c) => tree.nodes[c]?.player_input?.text?.trim()));
    for (const option of n.result?.options || []) if (!taken.has(option.trim())) out.push({ parent: n.id, option });
  }
  return out;
}

// Longest start of text, cut at whole characters and ended with '…', that fits(s) accepts; the whole text when it fits
export function fitText(text, fits) {
  const chars = [...text];   // code points, so a cut never splits a surrogate pair
  if (chars.length <= 1 || fits(text)) return text;
  let lo = 1;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(`${chars.slice(0, mid).join('')}…`)) lo = mid; else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join('')}…`;
}

const curve = (a, b) => (a.y === b.y ? `M${a.x},${a.y}L${b.x},${b.y}`
  : `M${a.x},${a.y}C${a.x + DX / 2},${a.y} ${b.x - DX / 2},${b.y} ${b.x},${b.y}`);

// Runs of consecutive nodes that share a scene: [{scene_id, ids}]
function segments(tree) {
  const segs = [];
  const walk = (id, seg) => {
    const n = tree.nodes[id];
    const parent = n.parent ? tree.nodes[n.parent] : null;
    if (!seg || !parent || parent.scene_id !== n.scene_id) { seg = { scene_id: n.scene_id, ids: [] }; segs.push(seg); }
    seg.ids.push(id);
    kidsOf(tree, id).forEach((c) => walk(c, seg));
  };
  if (tree.root) walk(tree.root, null);
  return segs;
}

// failed: [{parent, option, error}] branches the batch gave up on; onRewrite(entry) writes one of them again.
// untaken: [{parent, option}] options not written yet; onUntaken(entry) starts writing one
export function renderTree(tree, game, currentId, onPick, failed = [], onRewrite = null, untaken = [], onUntaken = null) {
  const view = $('#tree-view');
  const tip = $('#tree-tip');
  tip.hidden = true;   // its node is about to be replaced
  view.onscroll = () => { tip.hidden = true; };   // the tip would stay put while its node scrolls away
  if (!tree.root) { view.innerHTML = `<p class="hint" style="padding:2cqh">${esc(t('tree.empty'))}</p>`; return; }
  const stubs = {};
  failed.forEach((f, i) => { if (tree.nodes[f.parent]) (stubs[f.parent] ||= []).push(`fail:${i}`); });
  untaken.forEach((u, i) => { if (tree.nodes[u.parent]) (stubs[u.parent] ||= []).push(`opt:${i}`); });
  const { pos, width, height } = layout(tree, stubs);
  const onPath = new Set();
  for (let id = currentId; id; id = tree.nodes[id]?.parent) onPath.add(id);

  const boxes = segments(tree).map((s) => {
    const ids = [...s.ids, ...s.ids.flatMap((id) => stubs[id] || [])];   // a stub stays in its parent's scene box
    const xs = ids.map((id) => pos[id].x);
    const ys = ids.map((id) => pos[id].y);
    const x0 = Math.min(...xs) - 22;
    const y0 = Math.min(...ys) - 34;
    const name = game.scenes[s.scene_id]?.name || s.scene_id;
    const w = Math.max(...xs) - x0 + 22;
    return `<rect class="scene-box" x="${x0}" y="${y0}" width="${w}" height="${Math.max(...ys) - y0 + 22}"/>` +
      `<text class="scene-label" x="${x0 + 6}" y="${y0 + 13}" data-w="${w - 10}"><title>${esc(name)}</title>${esc(name)}</text>`;
  }).join('');

  const edges = Object.values(tree.nodes).filter((n) => n.parent && pos[n.parent] && pos[n.id]).map((n) => {
    const a = pos[n.parent];
    const b = pos[n.id];
    const d = a.y === b.y ? `M${a.x},${a.y}L${b.x},${b.y}` : `M${a.x},${a.y}C${a.x + DX / 2},${a.y} ${b.x - DX / 2},${b.y} ${b.x},${b.y}`;
    return `<path class="edge${onPath.has(n.id) ? ' onpath' : ''}" d="${d}"/>`;
  }).join('') + Object.values(tree.nodes).filter((n) => n.merged_to && pos[n.id] && pos[n.merged_to]).map((n) => {
    const a = pos[n.id];
    const b = pos[n.merged_to];
    return `<path class="edge link" d="M${a.x},${a.y}C${a.x + DX / 2},${a.y} ${b.x - DX / 2},${b.y} ${b.x},${b.y}"/>`;
  }).join('') + failed.map((f, i) => {
    const a = pos[f.parent];
    const b = pos[`fail:${i}`];
    if (!a || !b) return '';
    const d = a.y === b.y ? `M${a.x},${a.y}L${b.x},${b.y}` : `M${a.x},${a.y}C${a.x + DX / 2},${a.y} ${b.x - DX / 2},${b.y} ${b.x},${b.y}`;
    return `<path class="edge failed" d="${d}"/>`;
  }).join('') + untaken.map((u, i) => {
    const a = pos[u.parent];
    const b = pos[`opt:${i}`];
    return a && b ? `<path class="edge untaken" d="${curve(a, b)}"/>` : '';
  }).join('');

  // Every node is a keyboard stop with a spoken name (the tip shows on focus as on hover)
  const turnName = (n) => t('tree.turn', { n: pos[n.id].depth + 1, scene: game.scenes[n.scene_id]?.name || '' });
  const said = (n) => (n.player_input?.text ? t('tree.you', { text: n.player_input.text }) : t('tree.opening'));
  const key = (label) => `tabindex="0" role="button" aria-label="${esc(label)}"`;
  const nodes = Object.values(tree.nodes).filter((n) => pos[n.id]).map((n) => {
    const p = pos[n.id];
    const end = n.result?.ending;
    const cls = (n.id === currentId ? 'current' : onPath.has(n.id) ? 'onpath' : '') +
      (end ? ` ending${end.type === 'good' ? '' : ' bad'}` : '');
    return `<g class="node ${cls}" data-id="${n.id}" transform="translate(${p.x},${p.y})" ` +
      `${key(t('tree.nodeLabel', { turn: turnName(n), said: said(n) }))}${n.id === currentId ? ' aria-current="true"' : ''}>` +
      `<circle r="13"/><text text-anchor="middle" dy="4">${p.depth + 1}</text></g>`;
  }).join('') + failed.map((f, i) => {
    const p = pos[`fail:${i}`];
    return p ? `<g class="node failed" data-fail="${i}" transform="translate(${p.x},${p.y})" ` +
      `${key(`${t('tree.failed')}${t('common.colon')}${f.option}`)}>` +
      `<circle r="10"/><text text-anchor="middle" dy="4">!</text></g>` : '';
  }).join('') + untaken.map((u, i) => {
    const p = pos[`opt:${i}`];
    return p ? `<g class="node untaken" data-opt="${i}" transform="translate(${p.x},${p.y})" ` +
      `${key(`${t('tree.untaken')}${t('common.colon')}${u.option}`)}>` +
      `<circle r="10"/><text text-anchor="middle" dy="4">+</text></g>` : '';
  }).join('');

  view.innerHTML = `<svg width="${width}" height="${height}">${boxes}${edges}${nodes}</svg>`;
  // Long scene names would run into the next box: cut each label to its box width (full name stays in <title>)
  // (a halving search: a deep tree has many boxes and every length check is a layout read)
  view.querySelectorAll('.scene-label').forEach((el) => {
    const label = el.lastChild;
    label.data = fitText(label.data, (s) => { label.data = s; return el.getComputedTextLength() <= +el.dataset.w; });
  });

  const place = (g) => {
    const r = g.getBoundingClientRect();
    const host = $('.tree-panel').getBoundingClientRect();
    tip.style.left = `${Math.min(r.right - host.left + 8, host.width * 0.55)}px`;
    tip.hidden = false;
    // Below the node, or above it when the panel would cut it off
    const below = r.bottom - host.top + 6;
    tip.style.top = `${below + tip.offsetHeight > host.height ? Math.max(0, r.top - host.top - 6 - tip.offsetHeight) : below}px`;
  };
  // Hover or keyboard focus shows the tip; click, Enter or Space acts
  const bind = (g, html, act) => {
    const show = () => { tip.innerHTML = html(); place(g); };
    const hide = () => { tip.hidden = true; };
    g.addEventListener('mouseenter', show);
    g.addEventListener('focus', show);
    g.addEventListener('mouseleave', hide);
    g.addEventListener('blur', hide);
    g.addEventListener('click', () => { hide(); act(); });
    g.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();   // the confirm box this opens would otherwise take the same Enter as its OK
      hide();
      act();
    });
  };
  view.querySelectorAll('.node[data-fail]').forEach((g) => {
    const f = failed[g.dataset.fail];
    bind(g, () => `<b>${esc(t('tree.failed'))}</b><div>${esc(t('tree.you', { text: f.option }))}</div>` +
      `<div>${esc(errorText(f.error || 'internal'))}</div>${onRewrite ? `<div>${esc(t('tree.rewriteHint'))}</div>` : ''}`,
    () => onRewrite?.(f));
  });
  view.querySelectorAll('.node[data-opt]').forEach((g) => {
    const u = untaken[g.dataset.opt];
    bind(g, () => `<b>${esc(t('tree.untaken'))}</b><div>${esc(u.option)}</div><div>${esc(t('tree.untakenHint'))}</div>`,
      () => onUntaken?.(u));
  });
  view.querySelectorAll('.node[data-id]').forEach((g) => {
    const n = tree.nodes[g.dataset.id];
    bind(g, () => {
      const first = n.lines.find((l) => l.kind !== 'narration') || n.lines[0];
      // Narration has no speaker: show its text alone instead of after a stray colon
      const line = !first ? '' : first.kind === 'narration' || !first.speaker ? first.text
        : `${first.speaker}${game.lang === 'en' ? ': ' : '：'}${first.text}`;
      return `<b>${esc(turnName(n))}</b><div>${esc(said(n))}</div><div>${esc(line)}</div>` +
        (n.result?.ending ? `<div>${esc(`${t(n.result.ending.type === 'good' ? 'ending.good' : 'ending.bad')}${t('common.colon')}${n.result.ending.title}`)}</div>` : '');
    }, () => onPick(n.id, pos[n.id].depth + 1));
  });
  const cur = pos[currentId];
  if (cur) { view.scrollLeft = Math.max(0, cur.x - view.clientWidth / 2); view.scrollTop = Math.max(0, cur.y - view.clientHeight / 2); }
  // Keyboard players start on the turn they are at; the tip stays closed until they move
  const here = view.querySelector('.node.current');
  if (here) { here.focus({ preventScroll: true }); tip.hidden = true; }
}
