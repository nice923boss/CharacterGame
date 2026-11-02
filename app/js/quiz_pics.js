// Pictures of a quest in both editors (the form in quiz.js, the story in quiz_story_edit.js): drawing them with the
// AI and taking one from the computer. The editor passes in how to save the quest, where the new pictures go and
// where messages go: { save() -> saved quest or null, show(pictures), setMsg(text, error) }.
import { job, post } from './api.js?v=6f163306a287';
import { t } from './i18n.js?v=6f163306a287';
import { progress, toastError } from './ui.js?v=6f163306a287';

// Draws the given pictures, or the missing ones when slots is empty; the quest is saved first, the job reads it
export async function drawPics(slots, missing, { save, show, setMsg }) {
  const total = slots.length || missing.length;
  if (!total) { setMsg(t('quiz.pic.noneMissing')); return; }
  const saved = await save();
  if (!saved) return;
  let running = null;
  const box = progress(t('quiz.pic.drawing', { n: 1, total }), t('quiz.pic.drawingSub'), () => running && running.cancel());
  running = job(`/api/quiz/${saved.id}/pictures`, { slots }, (ev) => {
    if (ev.type === 'picture_start') box.update(t('quiz.pic.drawing', { n: ev.n, total: ev.total }));
    if (ev.type === 'picture') show(ev.pictures);
  });
  try {
    show((await running.done).pictures);
    setMsg(t('quiz.pic.done'));
  } catch (e) {
    if (e.code === 'cancelled') setMsg(e.message); else { setMsg(e.message, true); toastError(e); }
  } finally {
    box.close();
  }
}

const PIC_W = 960;
const PIC_H = 720;

// A picture from the computer cut to the 4:3 frame the player shows (its middle), at the AI pictures' size; a
// transparent PNG gets a white background
async function fitPicture(file) {
  const img = await createImageBitmap(file);
  const scale = Math.max(PIC_W / img.width, PIC_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const canvas = document.createElement('canvas');
  canvas.width = PIC_W;
  canvas.height = PIC_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, PIC_W, PIC_H);
  ctx.drawImage(img, (PIC_W - w) / 2, (PIC_H - h) / 2, w, h);
  img.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob gave nothing'))), 'image/jpeg', 0.9));
}

// The chosen file takes the place of the slot's picture (an AI one too); the quest is saved first so it has an id
export async function uploadPic(slot, file, { save, show, setMsg }) {
  let blob;
  try { blob = await fitPicture(file); } catch (e) {
    console.warn('picture file could not be read', file.type, e);
    setMsg(t('quiz.pic.notImage'), true);
    return;
  }
  const saved = await save();
  if (!saved) return;
  try {
    show((await post(`/api/quiz/${saved.id}/picture/${slot}`, blob)).pictures);
    setMsg(t('quiz.pic.uploaded'));
  } catch (e) { setMsg(e.message, true); toastError(e); }
}
