// Browser port of server/llm_client.py. Calls go to the player's CORS relay with the player's own NVIDIA key;
// the same retry groups, cooldowns, RPM window, watchdogs and content filter as the server.
import { DATA } from './data.js';

const L = DATA.llm;
// Failure kinds as in the server, plus network (this browser cannot reach the relay) and upstream (the relay
// answers but cannot reach NVIDIA)
const RETRYABLE = ['transient', 'connect', 'truncated', 'timeout', 'upstream'];
const NETWORK_BACKOFF_S = [1, 3, 6];   // then the relay counts as unreachable: every model goes through it
// An unknown model name gets the gateway's bare "404 page not found" (probe 2026-10-03)
const MODEL_GONE = /model_not_found|model\b[\s\S]{0,120}\b(not found|does not exist)|^\s*404 page not found\s*$/i;
const HISTORY_KEEP = 500;

// Cooldowns, failures in a row, the request window and attempt history live in localStorage, so every tab of
// this site shares them; without storage they last for this tab only
const STATE = 'cg-llm-state';
const fresh = () => ({ cooldown: {}, streak: {}, rpm: [], history: [] });
let mem = fresh();
let stored = true;   // false once storage fails: from then on the copy in memory is the only one
function state() {
  if (stored) {
    try { mem = { ...fresh(), ...JSON.parse(localStorage.getItem(STATE) || '{}') }; } catch { stored = false; }
  }
  return mem;
}
function change(fn) {
  const s = state();
  fn(s);
  if (stored) {
    try { localStorage.setItem(STATE, JSON.stringify(s)); } catch { stored = false; }
  }
}

class AttemptFailure extends Error {
  constructor(kind, detail, partial = false, retryAfter = null, status = null) {
    super(`${kind}: ${detail}`);
    this.kind = kind;
    this.partial = partial;
    this.retryAfter = retryAfter;
    this.status = status;
  }
}

// Seconds from a Retry-After header (a number or an HTTP date); null when missing or unreadable
export function retryAfter(value) {
  if (!value) return null;
  if (/^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Math.max(Number(value), 0);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max((at - Date.now()) / 1000, 0);
}

const sleep = (s, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, s * 1000);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject({ code: 'cancelled' }); }, { once: true });
});

class ContentFilter {
  constructor() { this.raw = ''; this.sent = 0; }

  visible() {
    let text = this.raw;
    if (text.includes('</think>')) {
      text = text.slice(text.lastIndexOf('</think>') + 8);
    } else {
      const head = text.trimStart();
      if (!head || head.startsWith('<think>') || '<think>'.startsWith(head)) return null;
    }
    return text.replace(/^[� \r\n\t]+/, '');
  }

  feed(delta) {
    this.raw += delta;
    const vis = this.visible();
    if (vis === null || (!this.sent && vis.length < 8 && !vis.includes('\n'))) return '';
    const out = vis.slice(this.sent);
    this.sent = vis.length;
    return out;
  }

  flush() {
    const vis = this.visible() || '';
    const out = vis.slice(this.sent);
    this.sent = vis.length;
    return out;
  }
}

function wrappedError(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const num = (c) => (/^\d+$/.test(String(c)) ? Number(c) : null);
  const err = obj.error;
  if (err && typeof err === 'object') return [String(err.message || JSON.stringify(err)), num(err.code || err.status)];
  if (typeof err === 'string' && err) return [err, null];
  if (obj.object === 'error') return [String(obj.message || JSON.stringify(obj)), num(obj.code)];
  return null;
}

function classify(message, code) {
  const m = message.toLowerCase();
  return L.TRANSIENT_STATUS.includes(code) || m.includes('overload') || m.includes('temporarily') ? 'transient' : 'fatal';
}

function note(model, outcome, s, status = null) {
  change((st) => {
    st.history.push({ t: Date.now() / 1000, model, outcome, status, s: Math.round(s * 10) / 10 });
    if (st.history.length > HISTORY_KEEP) st.history.splice(0, st.history.length - HISTORY_KEEP);
  });
}

function waitFor(base, f) {
  if (f.retryAfter !== null) return Math.max(1, Math.ceil(Math.min(f.retryAfter, L.RETRY_AFTER_MAX_S)));
  const [lo, hi] = L.JITTER;
  return Math.max(1, Math.round(base * (lo + (hi - lo) * Math.random())));
}

// [seconds, attempt number, attempts planned or null while queueing] for another try, or null to move on
function retryPlan(f, idx, isLast, retryN, emptyN, waits, started) {
  if (f.kind === 'empty') {
    const table = L.EMPTY_BACKOFF_S;
    return emptyN < table.length ? [waitFor(table[emptyN], f), emptyN + 1, table.length] : null;
  }
  if (!RETRYABLE.includes(f.kind)) return null;
  const table = isLast ? L.TRANSIENT_BACKOFF_S : idx === 0 && waits.prefer === 'quality' ? L.PRIMARY_RETRY_S : [];
  if (retryN < table.length) return [waitFor(table[retryN], f), retryN + 1, table.length];
  const left = waits.patience - (Date.now() - started) / 1000;
  if (isLast && left > 0) return [Math.min(waitFor(L.PATIENCE_STEP_S, f), Math.ceil(left)), retryN + 1, null];
  return null;
}

// skip: { on } set by the "retry now" button
async function countdown(seconds, emit, info, signal, skip) {
  let waited = 0;
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    if (skip?.on) { skip.on = false; break; }
    emit({ type: 'status', state: 'retry', remaining, total: seconds, ...info });
    await sleep(1, signal);
    waited += 1;
  }
  note(info.model, 'wait', waited);
}

async function rpmWait(label, emit, signal) {
  for (;;) {
    const now = Date.now();
    let first = null;
    change((st) => {
      st.rpm = st.rpm.filter((x) => now - x < 60000);
      if (st.rpm.length < L.RPM_LIMIT) st.rpm.push(now); else first = st.rpm[0];
    });
    if (first === null) return;
    emit({ type: 'status', state: 'rpm', remaining: Math.trunc(60 - (now - first) / 1000) + 1, model: label });
    await sleep(1, signal);
  }
}

// Hosted FLUX shares the NVIDIA per-minute limit: an image takes a slot only while IMAGE_RPM_RESERVE stay free
// for the story text
export async function imageSlot() {
  for (;;) {
    const now = Date.now();
    let taken = false;
    change((st) => {
      st.rpm = st.rpm.filter((x) => now - x < 60000);
      if (st.rpm.length < L.RPM_LIMIT - L.IMAGE_RPM_RESERVE) { st.rpm.push(now); taken = true; }
    });
    if (taken) return;
    await sleep(1);
  }
}

// Resolves with the next value, or rejects with 'watchdog' after `seconds`
function within(promise, seconds) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error('watchdog')), seconds * 1000); })])
    .finally(() => clearTimeout(t));
}

async function attempt(cand, messages, emit, temperature, conn, signal) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const t0 = Date.now();
  const deadline = t0 + L.TOTAL_TIMEOUT_S * 1000;
  const filt = new ContentFilter();
  let dataLines = 0; let finish = null; let done = false;
  const rawNonSse = [];
  let firstS = 0;
  try {
    let resp;
    try {
      resp = await within(fetch(`${conn.relay}/v1/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.key}` },
        body: JSON.stringify({ model: cand.model, messages, stream: true, max_tokens: L.MAX_TOKENS, temperature, ...L.extra }),
      }), L.FIRST_DATA_TIMEOUT_S);
    } catch (e) {
      if (signal?.aborted) throw { code: 'cancelled' };
      if (e.message === 'watchdog') throw new AttemptFailure('timeout', 'no headers');
      throw new AttemptFailure('network', String(e));
    }
    if (resp.status !== 200) {
      const status = resp.status;
      const text = (await resp.text().catch(() => '')).slice(0, 300);
      if (status === 403 && text.includes('origin_not_allowed')) throw { code: 'relay_origin' };
      if (status === 401 || status === 403) throw { code: 'key_rejected' };
      if (status === 502 && text.includes('upstream_unreachable')) throw new AttemptFailure('upstream', text, false, null, status);
      if (status === 410 || (status === 404 && MODEL_GONE.test(text))) {
        console.warn(`llm ${cand.model}: model not found or retired, check the candidate list`);
        throw new AttemptFailure('gone', `HTTP ${status}: ${text}`, false, null, status);
      }
      throw new AttemptFailure(L.TRANSIENT_STATUS.includes(status) ? 'transient' : 'fatal', `HTTP ${status}`, false,
        retryAfter(resp.headers.get('retry-after')), status);
    }
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let ended = false;
    outer: while (!ended) {
      const now = Date.now();
      const gate = dataLines ? L.IDLE_TIMEOUT_S : L.FIRST_DATA_TIMEOUT_S - (now - t0) / 1000;
      const wait = Math.min(gate, (deadline - now) / 1000);
      if (wait <= 0) throw new AttemptFailure('timeout', 'total time cap', !!filt.sent);
      let chunk;
      try {
        chunk = await within(reader.read(), wait);
      } catch (e) {
        if (signal?.aborted) throw { code: 'cancelled' };
        if (e.message === 'watchdog') throw new AttemptFailure('timeout', 'watchdog', !!filt.sent);
        throw new AttemptFailure('truncated', String(e), !!filt.sent);
      }
      if (chunk.done) { ended = true; buf += '\n'; } else buf += chunk.value;
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).replace(/\r$/, '');
        buf = buf.slice(cut + 1);
        if (!line.startsWith('data:')) {
          if (line.trim() && rawNonSse.length < 50) rawNonSse.push(line);
          continue;
        }
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break outer; }
        let obj;
        try { obj = JSON.parse(payload); } catch { continue; }
        if (!dataLines) firstS = (Date.now() - t0) / 1000;
        dataLines += 1;
        const err = wrappedError(obj);
        if (err) throw new AttemptFailure(classify(...err), 'wrapped error', !!filt.sent, null, err[1]);
        for (const ch of obj.choices || []) {
          const content = ch.delta?.content;
          if (content) {
            const out = filt.feed(content);
            if (out) emit({ type: 'delta', text: out });
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
        if (filt.raw.length > L.CHAR_CAP) { finish = 'char_cap'; break outer; }
      }
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    ctrl.abort();
  }
  const tail = filt.flush();
  if (tail) emit({ type: 'delta', text: tail });
  const content = filt.visible() || '';
  if (!content.trim()) {
    let bodyErr = null;
    try { bodyErr = rawNonSse.length ? wrappedError(JSON.parse(rawNonSse.join('\n'))) : null; } catch { /* not JSON */ }
    if (bodyErr) throw new AttemptFailure(classify(...bodyErr), 'error body with HTTP 200');
    throw new AttemptFailure('empty', `no content (data_lines=${dataLines})`);
  }
  if (finish === null && !done) throw new AttemptFailure('truncated', 'no finish_reason and [DONE]', true);
  return { content, finish, candidate: cand, firstS };
}

function playerWaits(raw) {
  const patience = Number(raw?.patience);
  return {
    patience: Number.isFinite(patience) ? Math.min(Math.max(patience, 0), L.PATIENCE_MAX_S) : 0,
    prefer: raw?.prefer === 'speed' ? 'speed' : 'quality',
    skip: raw?.skip || null,
  };
}

// conn: { key, relay, waits? }; waits: { patience, prefer, skip } from the job (see playerWaits).
// Throws { code, params } like the server's error events.
export async function stream(messages, emit, temperature, conn, signal) {
  if (!conn.key) throw { code: 'no_key' };
  if (!conn.relay) throw { code: 'no_relay' };
  const waits = playerWaits(conn.waits);
  const started = Date.now();
  const { cooldown } = state();
  const ready = L.candidates.filter((c) => (cooldown[c.model] || 0) <= started);
  if (ready.length) {
    for (const c of L.candidates) {
      if (!ready.includes(c)) emit({ type: 'status', state: 'cooling', model: c.label, remaining: Math.ceil((cooldown[c.model] - started) / 1000) });
    }
  }
  const order = ready.length ? ready : L.candidates;
  const errors = [];
  let networkN = 0;
  for (let idx = 0; idx < order.length; idx += 1) {
    const cand = order[idx];
    const isLast = idx === order.length - 1;
    let retryN = 0; let emptyN = 0;
    for (;;) {
      await rpmWait(cand.label, emit, signal);
      emit({ type: 'status', state: 'waiting', model: cand.label });
      const t0 = Date.now();
      let res;
      try {
        res = await attempt(cand, messages, emit, temperature, conn, signal);
      } catch (f) {
        if (!(f instanceof AttemptFailure)) throw f;
        note(cand.label, f.kind, (Date.now() - t0) / 1000, f.status);
        console.warn(`llm ${cand.label} attempt failed: ${f.message}`);
        const info = { model: cand.label, reason: f.kind, waited: Math.round((Date.now() - started) / 1000) };
        if (f.kind === 'network') {
          // Same relay for every model: switching would not help
          if (networkN >= NETWORK_BACKOFF_S.length) throw { code: 'relay_unreachable' };
          networkN += 1;
          await countdown(waitFor(NETWORK_BACKOFF_S[networkN - 1], f), emit,
            { ...info, attempt: networkN, max: NETWORK_BACKOFF_S.length }, signal, waits.skip);
          continue;
        }
        errors.push({ model: cand.label, reason: f.kind });
        if (f.partial) emit({ type: 'reset' });
        const plan = retryPlan(f, idx, isLast, retryN, emptyN, waits, started);
        if (plan) {
          const [wait, attemptN, most] = plan;
          if (f.kind === 'empty') emptyN += 1; else retryN += 1;
          await countdown(wait, emit, { ...info, attempt: attemptN, max: most }, signal, waits.skip);
          continue;
        }
        change((st) => {
          const n = st.streak[cand.model] = (st.streak[cand.model] || 0) + 1;
          const steps = L.COOLDOWN_STEPS_S;
          st.cooldown[cand.model] = Date.now() + steps[Math.min(n, steps.length) - 1] * 1000;
        });
        if (!isLast) {
          note(cand.label, 'switch', 0);
          emit({ type: 'status', state: 'switch', from: cand.label, to: order[idx + 1].label, reason: f.kind });
        }
        break;
      }
      change((st) => { delete st.streak[cand.model]; delete st.cooldown[cand.model]; });
      note(cand.label, 'ok', res.firstS);
      return res;
    }
  }
  throw { code: 'all_failed', params: { errors: errors.slice(-3) } };
}

export const complete = (messages, temperature, conn, signal) => stream(messages, () => {}, temperature, conn, signal);

// ---------- statistics (same shape as the server's /api/stats) ----------

function summarize(rows) {
  const tries = rows.filter((r) => r.outcome !== 'wait' && r.outcome !== 'switch');
  const first = tries.filter((r) => r.outcome === 'ok').map((r) => r.s);
  const count = (list) => list.reduce((acc, k) => ({ ...acc, [k]: (acc[k] || 0) + 1 }), {});
  return {
    requests: tries.length, ok: first.length,
    failed: count(tries.filter((r) => r.outcome !== 'ok').map((r) => r.outcome)),
    status: count(tries.filter((r) => r.status).map((r) => String(r.status))),
    switches: rows.filter((r) => r.outcome === 'switch').length,
    wait_s: rows.filter((r) => r.outcome === 'wait').reduce((a, r) => a + r.s, 0),
    avg_first_s: first.length ? Math.round(first.reduce((a, b) => a + b, 0) / first.length * 10) / 10 : null,
  };
}

function busyLevel(rows) {
  const s = summarize(rows);
  const busy = Object.entries(s.failed).reduce((a, [k, n]) => a + (RETRYABLE.includes(k) ? n : 0), 0);
  const avg = s.avg_first_s || 0;
  const level = !s.requests ? 'unknown' : busy >= 3 || avg > 25 ? 'red' : busy || avg > 10 ? 'yellow' : 'green';
  return { level, busy, requests: s.requests, avg_first_s: s.avg_first_s };
}

export function stats() {
  const now = Date.now() / 1000;
  const today = new Date().toDateString();
  const rows = state().history;
  return {
    today: summarize(rows.filter((r) => new Date(r.t * 1000).toDateString() === today)),
    recent: busyLevel(rows.filter((r) => now - r.t < L.BUSY_WINDOW_S)),
  };
}
