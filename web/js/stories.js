// Story list on the title screen: open a story at its latest turn, or delete it; deleted stories wait 7 days in "recently deleted".
import { del, get, post } from './api.js';
import { t } from './i18n.js';
import { $, closeModal, confirmBox, esc, loadThumbs, openModal, thumbAttr, toast, toastError } from './ui.js';
import { batchRow, rearm, refreshBatches } from './batch.js';

const ACTIVE = ['running', 'images'];

// onChange runs after a delete, so the title menu can refresh "continue"; onOpen(gid, nodeId) plays a story
export async function openStories(onChange, onOpen) {
  let games, slots, autos, batches, trash;
  const fetchAll = () => Promise.all([get('/api/games'), get('/api/slots'), get('/api/autosaves'), get('/api/batches'),
    get('/api/trash')]);
  try { [games, slots, autos, batches, trash] = await fetchAll(); } catch (e) { toastError(e); return; }
  const batchOf = (gid) => batches.find((b) => b.id === gid);
  // A batch story opens at its opening, so every option ahead is already written; a live story at its latest turn
  const openAt = (g) => (g.batch ? g.root : g.latest);

  const refs = (gid) => {
    const n = slots.filter((s) => s?.game_id === gid).length;
    return [n && t('stories.slots', { n }), autos.some((a) => a.game_id === gid) && t('stories.auto')].filter(Boolean).join(t('common.sep'));
  };

  const row = (g) => {
    const used = refs(g.id);
    return `<div class="story-row"><div class="thumb"${thumbAttr(g.thumb)}></div>` +
      `<div class="meta"><b>${esc(g.title || g.id)} <small>${esc(t(`stories.lang.${g.lang}`))}</small></b>` +
      `${esc(t('stories.meta', { chars: g.characters.join(t('common.sep')) || t('stories.noChars'), nodes: g.nodes }))}<br>` +
      `${esc(t('stories.created', { date: String(g.created_at || '').slice(0, 16).replace('T', ' ') }))}` +
      `${used ? esc(t('stories.usedBy', { used })) : ''}${batchLine(g.id)}</div>` +
      batchButton(g.id) +
      (openAt(g) ? `<button class="btn small" data-open-story="${esc(g.id)}">${esc(t('stories.open'))}</button>` : '') +
      // A story whose batch is still writing cannot be deleted; pause the batch first
      (ACTIVE.includes(batchOf(g.id)?.state)
        ? `<button class="btn small ghost" disabled title="${esc(t('stories.busyDel'))}">${esc(t('common.delete'))}</button></div>`
        : `<button class="btn small ghost" data-del-story="${esc(g.id)}">${esc(t('common.delete'))}</button></div>`);
  };

  const daysLeft = (x) => Math.ceil((Date.parse(x.expires_at) - Date.now()) / 864e5);
  const trashRow = (x) => {
    const days = daysLeft(x);
    return `<div class="story-row trashed"><div class="meta"><b>${esc(x.title || x.id)}</b>` +
      `${esc(days > 1 ? t('stories.expires', { nodes: x.nodes, days }) : t('stories.expiresToday', { nodes: x.nodes }))}</div>` +
      `<button class="btn small" data-restore-story="${esc(x.id)}">${esc(t('stories.restore'))}</button>` +
      `<button class="btn small ghost" data-purge-story="${esc(x.id)}">${esc(t('stories.purge'))}</button></div>`;
  };

  const batchLine = (gid) => {
    const b = batchOf(gid);
    return b ? `<br>${esc(t('stories.batch', { state: t(`batch.state.${b.state}`), row: batchRow(b) }))}` : '';
  };
  // Pause a working batch; resume a paused, stopped, failed or partly failed one
  const batchButton = (gid) => {
    const b = batchOf(gid);
    if (!b) return '';
    if (ACTIVE.includes(b.state)) return `<button class="btn small ghost" data-batch-pause="${esc(gid)}">${esc(t('stories.pauseBatch'))}</button>`;
    if (b.state !== 'done' || b.failed) return `<button class="btn small ghost" data-batch-resume="${esc(gid)}">${esc(t('stories.resumeBatch'))}</button>`;
    return '';
  };

  const batchAct = async (gid, act) => {
    const g = games.find((x) => x.id === gid);
    try {
      await post(`/api/games/${gid}/batch/${act}`, {});
      if (act === 'resume') rearm(gid);
      batches = await get('/api/batches');
    } catch (e) { toastError(e); return; }
    paint();
    refreshBatches();
    toast(t(act === 'pause' ? 'stories.batchPaused' : 'stories.batchResumed', { title: g.title || gid }));
  };

  const paint = () => {
    $('#story-list').innerHTML = (games.length ? games.map(row).join('') : `<p class="hint">${esc(t('stories.none'))}</p>`) +
      (trash.length ? `<h3 class="trash-head">${esc(t('stories.trash'))}</h3>${trash.map(trashRow).join('')}` : '');
    loadThumbs($('#story-list'));
    $('#story-list').querySelectorAll('[data-restore-story]').forEach((b) => { b.onclick = () => restore(b.dataset.restoreStory); });
    $('#story-list').querySelectorAll('[data-purge-story]').forEach((b) => { b.onclick = () => purge(b.dataset.purgeStory); });
    $('#story-list').querySelectorAll('[data-del-story]').forEach((b) => { b.onclick = () => remove(b.dataset.delStory); });
    $('#story-list').querySelectorAll('[data-open-story]').forEach((b) => {
      b.onclick = () => {
        const g = games.find((x) => x.id === b.dataset.openStory);
        closeModal('#mdl-stories');
        onOpen(g.id, openAt(g));
      };
    });
    $('#story-list').querySelectorAll('[data-batch-pause]').forEach((b) => { b.onclick = () => batchAct(b.dataset.batchPause, 'pause'); });
    $('#story-list').querySelectorAll('[data-batch-resume]').forEach((b) => { b.onclick = () => batchAct(b.dataset.batchResume, 'resume'); });
  };

  const remove = async (gid) => {
    const g = games.find((x) => x.id === gid);
    const used = refs(gid);
    const text = t('stories.delAsk', { title: g.title || gid, used: used ? t('stories.delUsed', { used }) : '' });
    if (!(await confirmBox(text, t('common.delete')))) return;
    try { await del(`/api/games/${gid}`); } catch (e) { toastError(e); return; }
    await reload();
    refreshBatches();
    toast(t('stories.deleted', { title: g.title || gid }));
    onChange();
  };

  const reload = async () => {
    try { [games, slots, autos, batches, trash] = await fetchAll(); } catch (e) { toastError(e); }
    paint();
  };

  // Restore puts the story back; its save slots only return where those slots are still empty
  const restore = async (gid) => {
    const x = trash.find((y) => y.id === gid);
    try { await post(`/api/trash/${gid}/restore`, {}); } catch (e) { toastError(e); return; }
    await reload();
    refreshBatches();
    toast(t('stories.restored', { title: x.title || gid }));
    onChange();
  };

  const purge = async (gid) => {
    const x = trash.find((y) => y.id === gid);
    if (!(await confirmBox(t('stories.purgeAsk', { title: x.title || gid }), t('stories.purge')))) return;
    try { await del(`/api/trash/${gid}`); } catch (e) { toastError(e); return; }
    await reload();
    toast(t('stories.purged', { title: x.title || gid }));
  };

  paint();
  openModal('#mdl-stories');
}
