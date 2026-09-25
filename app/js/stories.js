// Story list on the title screen: open a story at its latest turn, or delete it with its tree, images, slots and autosave.
import { del, get, post } from './api.js';
import { t } from './i18n.js';
import { $, confirmBox, esc, openModal, toast } from './ui.js';
import { batchRow, rearm, refreshBatches } from './batch.js';

const ACTIVE = ['running', 'images'];

// onChange runs after a delete, so the title menu can refresh "continue"; onOpen(gid, nodeId) plays a story
export async function openStories(onChange, onOpen) {
  let games, slots, auto, batches;
  try {
    [games, slots, auto, batches] = await Promise.all([get('/api/games'), get('/api/slots'), get('/api/autosave'),
      get('/api/batches')]);
  } catch (e) { toast(e.message, true); return; }
  const batchOf = (gid) => batches.find((b) => b.id === gid);
  // A batch story opens at its opening, so every option ahead is already written; a live story at its latest turn
  const openAt = (g) => (g.batch ? g.root : g.latest);

  const refs = (gid) => {
    const n = slots.filter((s) => s?.game_id === gid).length;
    return [n && t('stories.slots', { n }), auto?.game_id === gid && t('stories.auto')].filter(Boolean).join(t('common.sep'));
  };

  const row = (g) => {
    const thumb = g.thumb ? ` style="background-image:url('${g.thumb}')"` : '';
    const used = refs(g.id);
    return `<div class="story-row"><div class="thumb"${thumb}></div>` +
      `<div class="meta"><b>${esc(g.title || g.id)} <small>${esc(t(`stories.lang.${g.lang}`))}</small></b>` +
      `${esc(t('stories.meta', { chars: g.characters.join(t('common.sep')) || t('stories.noChars'), nodes: g.nodes }))}<br>` +
      `${esc(t('stories.created', { date: String(g.created_at || '').slice(0, 16).replace('T', ' ') }))}` +
      `${used ? esc(t('stories.usedBy', { used })) : ''}${batchLine(g.id)}</div>` +
      batchButton(g.id) +
      (openAt(g) ? `<button class="btn small" data-open-story="${esc(g.id)}">${esc(t('stories.open'))}</button>` : '') +
      `<button class="btn small ghost" data-del-story="${esc(g.id)}">${esc(t('common.delete'))}</button></div>`;
  };

  const batchLine = (gid) => {
    const b = batchOf(gid);
    return b ? `<br>${esc(t('stories.batch', { state: t(`batch.state.${b.state}`), row: batchRow(b) }))}` : '';
  };
  // Stop a working batch; resume a stopped, failed or partly failed one
  const batchButton = (gid) => {
    const b = batchOf(gid);
    if (!b) return '';
    if (ACTIVE.includes(b.state)) return `<button class="btn small ghost" data-batch-stop="${esc(gid)}">${esc(t('stories.cancelBatch'))}</button>`;
    if (b.state !== 'done' || b.failed) return `<button class="btn small ghost" data-batch-resume="${esc(gid)}">${esc(t('stories.resumeBatch'))}</button>`;
    return '';
  };

  const batchAct = async (gid, act) => {
    const g = games.find((x) => x.id === gid);
    try {
      await post(`/api/games/${gid}/batch/${act}`, {});
      if (act === 'resume') rearm(gid);
      batches = await get('/api/batches');
    } catch (e) { toast(e.message, true); return; }
    paint();
    refreshBatches();
    toast(t(act === 'cancel' ? 'stories.batchStopped' : 'stories.batchResumed', { title: g.title || gid }));
  };

  const paint = () => {
    $('#story-list').innerHTML = games.length ? games.map(row).join('') : `<p class="hint">${esc(t('stories.none'))}</p>`;
    $('#story-list').querySelectorAll('[data-del-story]').forEach((b) => { b.onclick = () => remove(b.dataset.delStory); });
    $('#story-list').querySelectorAll('[data-open-story]').forEach((b) => {
      b.onclick = () => {
        const g = games.find((x) => x.id === b.dataset.openStory);
        $('#mdl-stories').hidden = true;
        onOpen(g.id, openAt(g));
      };
    });
    $('#story-list').querySelectorAll('[data-batch-stop]').forEach((b) => { b.onclick = () => batchAct(b.dataset.batchStop, 'cancel'); });
    $('#story-list').querySelectorAll('[data-batch-resume]').forEach((b) => { b.onclick = () => batchAct(b.dataset.batchResume, 'resume'); });
  };

  const remove = async (gid) => {
    const g = games.find((x) => x.id === gid);
    const used = refs(gid);
    const text = t('stories.delAsk', { title: g.title || gid, used: used ? t('stories.delUsed', { used }) : '' });
    if (!(await confirmBox(text, t('common.delete')))) return;
    try { await del(`/api/games/${gid}`); } catch (e) { toast(e.message, true); return; }
    games = games.filter((x) => x.id !== gid);
    batches = batches.filter((x) => x.id !== gid);
    refreshBatches();
    slots = slots.map((s) => (s?.game_id === gid ? null : s));
    if (auto?.game_id === gid) auto = null;
    paint();
    toast(t('stories.deleted', { title: g.title || gid }));
    onChange();
  };

  paint();
  openModal('#mdl-stories');
}
