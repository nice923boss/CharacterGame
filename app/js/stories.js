// Story list on the title screen: open a story at its latest turn, or delete it; deleted stories wait 7 days in "recently deleted".
import { del, get, post } from './api.js?v=6f163306a287';
import { t } from './i18n.js?v=6f163306a287';
import { $, closeModal, confirmBox, esc, loadThumbs, openModal, thumbAttr, toast, toastError } from './ui.js?v=6f163306a287';
import { batchRow, rearm, refreshBatches } from './batch.js?v=6f163306a287';

const ACTIVE = ['running', 'images'];
const UNDO_MS = 10000;   // how long the delete notice offers its undo button

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

  // While a request is out the list's buttons are off, so a second click cannot send it again; every way out
  // repaints the list, which brings them back
  let busy = false;
  const working = async (fn) => {
    if (busy) return;
    busy = true;
    $('#story-list').querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try { await fn(); } finally { busy = false; }
  };
  // The repaint replaces the focused button: focus moves to the same story's next step, else the dialog's first control
  const refocus = (sel) => {
    if ($('#mdl-stories').hidden) return;
    const el = sel && $('#story-list').querySelector(sel);
    (el || $('#mdl-stories').querySelector('button:not([disabled]), [href]'))?.focus();
  };
  const at = (attr, gid) => `[data-${attr}="${CSS.escape(gid)}"]`;

  const batchAct = (gid, act) => working(async () => {
    const g = games.find((x) => x.id === gid);
    try {
      await post(`/api/games/${gid}/batch/${act}`, {});
      if (act === 'resume') rearm(gid);
      batches = await get('/api/batches');
    } catch (e) { toastError(e); paint(); refocus(at(`batch-${act}`, gid)); return; }
    paint();
    refocus(at(act === 'pause' ? 'batch-resume' : 'batch-pause', gid) + ',' + at('open-story', gid));
    refreshBatches();
    toast(t(act === 'pause' ? 'stories.batchPaused' : 'stories.batchResumed', { title: g.title || gid }));
  });

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
    await working(async () => {
      try { await del(`/api/games/${gid}`); } catch (e) { toastError(e); paint(); refocus(at('del-story', gid)); return; }
      await reload();
      refocus(at('restore-story', gid));
      refreshBatches();
      undoNotice(gid, g.title || gid);
      onChange();
    });
  };

  // The delete notice carries its own undo, so the player need not find the story in "recently deleted"
  const undoNotice = (gid, title) => {
    const box = document.createElement('span');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn tiny';
    btn.textContent = t('stories.undo');
    btn.onclick = async () => {
      btn.disabled = true;
      if (await restore(gid)) box.closest('.toast')?.remove(); else btn.disabled = false;
    };
    box.append(t('stories.deleted', { title }), btn);
    toast(box, false, UNDO_MS, { id: `del-${gid}` });
  };

  const reload = async () => {
    try { [games, slots, autos, batches, trash] = await fetchAll(); } catch (e) { toastError(e); }
    paint();
  };

  // Restore puts the story back; its save slots only return where those slots are still empty.
  // Resolves true once the story is back.
  const restore = async (gid) => {
    let ok = false;
    await working(async () => {
      const title = trash.find((y) => y.id === gid)?.title || games.find((y) => y.id === gid)?.title || gid;
      try { await post(`/api/trash/${gid}/restore`, {}); } catch (e) { toastError(e); paint(); refocus(at('restore-story', gid)); return; }
      ok = true;
      await reload();
      refocus(at('open-story', gid) + ',' + at('del-story', gid));
      refreshBatches();
      toast(t('stories.restored', { title }));
      onChange();
    });
    return ok;
  };

  const purge = async (gid) => {
    const x = trash.find((y) => y.id === gid);
    if (!(await confirmBox(t('stories.purgeAsk', { title: x.title || gid }), t('stories.purge')))) return;
    await working(async () => {
      try { await del(`/api/trash/${gid}`); } catch (e) { toastError(e); paint(); refocus(at('purge-story', gid)); return; }
      await reload();
      refocus('');
      toast(t('stories.purged', { title: x.title || gid }));
    });
  };

  paint();
  openModal('#mdl-stories');
}
