// The NVIDIA key: the settings field, the connection test and the first-run guide (B01-B04, B09, H06).
// Both builds answer the same routes: the server tests with httpx, the browser build through the relay.
import { LOCAL, get, post } from './api.js?v=b9289d23998c';
import { t } from './i18n.js?v=b9289d23998c';
import { $, closeModal, confirmBox, openModal, setNoKeyHelp } from './ui.js?v=b9289d23998c';

// What gets pasted along with the key: quotes, "Bearer ", line breaks and spaces from a copied snippet (B03),
// and the invisible zero-width characters web pages and documents put in (\s already covers U+FEFF)
export function cleanKey(raw) {
  const unquote = (s) => s.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '');
  return unquote(unquote(String(raw ?? '').replace(/[\s­​-‍⁠]+/g, '')).replace(/^bearer:?/i, ''));
}

const stateText = (r) => t(r.state === 'unreachable' && LOCAL ? 'check.unreachableLocal' : `check.${r.state}`,
  { status: r.status });
const lineText = (r) => t('check.line', { kind: t(`check.${r.kind}`), state: stateText(r), ms: r.ms });

// Resolves { ok, text, code } (ok: saved), or null when the player cancelled at the "not nvapi-" question.
// The save itself sends one tiny request first: a key NVIDIA rejects is not saved (B01)
async function saveKey(raw) {
  const key = cleanKey(raw);
  if (!key) return { ok: false, text: t('err.bad_key'), code: 'bad_key' };
  if (!key.startsWith('nvapi-') && !(await confirmBox(t('key.notNvapi'), t('key.saveAnyway')))) return null;
  try {
    const r = await post('/api/settings/nvidia_key', { key });
    const c = r.check;
    const text = c.state === 'ok' ? t('key.savedOk', { ms: c.ms })
      : r.key_check === 'valid' ? t('key.savedBusy') : t('key.savedUnsure', { reason: stateText(c) });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, text: e.code === 'key_rejected' ? t('key.rejected') : e.message, code: e.code };
  }
}

function paintLine(el, text, error = false) {
  el.textContent = text;
  el.classList.toggle('error', error);
}

// A button disabled while it works loses keyboard focus, and the confirm dialog cannot hand it back
export function enable(btn) {
  btn.disabled = false;
  if (document.activeElement === document.body) btn.focus();
}

// "nvapi-****AB12, saved 10/3" (B04)
export function keyNowText(h) {
  if (!h?.key_hint) return t('key.none');
  const d = h.key_saved_at ? new Date(h.key_saved_at) : null;
  return d && !Number.isNaN(d.getTime())
    ? t('key.nowSaved', { hint: h.key_hint, date: `${d.getMonth() + 1}/${d.getDate()}` }) : t('key.now', { hint: h.key_hint });
}

// The bundled demo, if the player still has it
export async function demoGame(h) {
  if (!h?.demo) return null;
  const games = await get('/api/games').catch(() => []);
  return games.some((g) => g.id === h.demo) ? h.demo : null;
}

let app;   // { refreshHealth: () => Promise<health | false>, play: (gid) => void, newStory: () => void }

async function runSave(input, line, btn) {
  btn.disabled = true;
  paintLine(line, t('key.testing'));
  const r = await saveKey(input.value);
  enable(btn);
  if (!r) { paintLine(line, ''); return false; }
  paintLine(line, r.text, !r.ok);
  if (r.ok) {
    input.value = '';
    await app.refreshHealth();
  }
  return r.ok;
}

// Three steps: get a key, paste and test it, then play the demo or start a story (B09)
export async function openOnboard() {
  const h = await app.refreshHealth();
  const demo = await demoGame(h);
  $('#ob-demo').hidden = !demo;
  $('#ob-demo').dataset.gid = demo || '';
  $('#ob-new').disabled = !h?.key_hint;
  $('#ob-key').value = '';
  paintLine($('#ob-result'), h?.key_hint ? keyNowText(h) : '');
  openModal('#mdl-onboard');
}

export function initConnect(appHooks) {
  app = appHooks;
  setNoKeyHelp(openOnboard);
  $('#set-key-save').addEventListener('click', () => runSave($('#set-key'), $('#set-key-result'), $('#set-key-save')));
  $('#ob-save').addEventListener('click', async () => {
    if (!(await runSave($('#ob-key'), $('#ob-result'), $('#ob-save')))) return;
    $('#ob-new').disabled = false;
    if (!$('#mdl-onboard').hidden) $('#ob-new').focus();   // the next step is to start a story
  });
  for (const [input, btn] of [['#set-key', '#set-key-save'], ['#ob-key', '#ob-save']]) {
    // Enter in a key field saves it like the button beside it
    $(input).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.repeat || e.isComposing || $(btn).disabled) return;
      e.preventDefault();
      $(btn).click();
    });
  }
  // A key typed and not saved does not stay in the field after its dialog closes
  $('#mdl-settings').addEventListener('modal-close', () => { $('#set-key').value = ''; });
  $('#mdl-onboard').addEventListener('modal-close', () => { $('#ob-key').value = ''; });
  // Both paths with the saved key, side by side with their latency (B02)
  $('#set-key-test').addEventListener('click', async () => {
    const btn = $('#set-key-test');
    const line = $('#set-key-result');
    btn.disabled = true;
    paintLine(line, t('key.testing'));
    try {
      const r = await post('/api/settings/check', {});
      const verdict = { valid: 'check.valid', rejected: 'check.rejected' }[r.key_check] || 'check.unknown';
      paintLine(line, t('check.result', { text: lineText(r.text), image: lineText(r.image), verdict: t(verdict) }),
        r.key_check === 'rejected');
      app.refreshHealth();
    } catch (e) {
      paintLine(line, e.message, true);
    }
    enable(btn);
  });
  $('#ob-demo').addEventListener('click', () => { closeModal('#mdl-onboard'); app.play($('#ob-demo').dataset.gid); });
  $('#ob-new').addEventListener('click', () => { closeModal('#mdl-onboard'); app.newStory(); });
}
