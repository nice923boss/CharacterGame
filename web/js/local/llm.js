// Browser port of server/llm_client.py. Calls go to the player's CORS relay with the player's own NVIDIA key;
// the same retry groups, cooldowns, RPM window, watchdogs and content filter as the server.
import { DATA } from './data.js';

const L = DATA.llm;
const cooldown = new Map();   // model -> time (ms) until which it is skipped
const rpm = [];               // request times (ms) in the last minute, one provider

class AttemptFailure extends Error {
  constructor(kind, detail, partial = false) {
    super(`${kind}: ${detail}`);
    this.kind = kind;
    this.partial = partial;
  }
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

async function countdown(seconds, emit, info, signal) {
  for (let remaining = seconds; remaining > 0; remaining -= 1) {
    emit({ type: 'status', state: 'retry', remaining, ...info });
    await sleep(1, signal);
  }
}

async function rpmWait(label, emit, signal) {
  for (;;) {
    const now = Date.now();
    while (rpm.length && now - rpm[0] >= 60000) rpm.shift();
    if (rpm.length < L.RPM_LIMIT) { rpm.push(now); return; }
    emit({ type: 'status', state: 'rpm', remaining: Math.trunc(60 - (now - rpm[0]) / 1000) + 1, model: label });
    await sleep(1, signal);
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
      throw { code: 'relay_unreachable' };   // same relay for every model: switching would not help
    }
    if (resp.status !== 200) {
      const text = (await resp.text().catch(() => '')).slice(0, 300);
      if (resp.status === 403 && text.includes('origin_not_allowed')) throw { code: 'relay_origin' };
      if (resp.status === 401 || resp.status === 403) throw { code: 'key_rejected' };
      throw new AttemptFailure(L.TRANSIENT_STATUS.includes(resp.status) ? 'transient' : 'fatal', `HTTP ${resp.status}`);
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
        dataLines += 1;
        const err = wrappedError(obj);
        if (err) throw new AttemptFailure(classify(...err), 'wrapped error', !!filt.sent);
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
  return { content, finish, candidate: cand };
}

// conn: { key, relay }. Throws { code, params } like the server's error events.
export async function stream(messages, emit, temperature, conn, signal) {
  if (!conn.key) throw { code: 'no_key' };
  if (!conn.relay) throw { code: 'no_relay' };
  const now = Date.now();
  const ready = L.candidates.filter((c) => (cooldown.get(c.model) || 0) <= now);
  const order = ready.length ? ready : L.candidates;
  const errors = [];
  for (let idx = 0; idx < order.length; idx += 1) {
    const cand = order[idx];
    const isLast = idx === order.length - 1;
    let transientN = 0; let emptyN = 0;
    for (;;) {
      await rpmWait(cand.label, emit, signal);
      emit({ type: 'status', state: 'waiting', model: cand.label });
      try {
        return await attempt(cand, messages, emit, temperature, conn, signal);
      } catch (f) {
        if (!(f instanceof AttemptFailure)) throw f;
        console.warn(`llm ${cand.label} attempt failed: ${f.message}`);
        errors.push({ model: cand.label, reason: f.kind });
        if (f.partial) emit({ type: 'reset' });
        const info = { model: cand.label, reason: f.kind };
        if (['transient', 'connect', 'truncated'].includes(f.kind) && isLast && transientN < L.TRANSIENT_BACKOFF_S.length) {
          const wait = L.TRANSIENT_BACKOFF_S[transientN];
          transientN += 1;
          await countdown(wait, emit, { ...info, attempt: transientN, max: L.TRANSIENT_BACKOFF_S.length }, signal);
          continue;
        }
        if (f.kind === 'empty' && emptyN < L.EMPTY_BACKOFF_S.length) {
          const wait = L.EMPTY_BACKOFF_S[emptyN];
          emptyN += 1;
          await countdown(wait, emit, { ...info, attempt: emptyN, max: L.EMPTY_BACKOFF_S.length }, signal);
          continue;
        }
        cooldown.set(cand.model, Date.now() + L.COOLDOWN_S * 1000);
        if (!isLast) emit({ type: 'status', state: 'switch', from: cand.label, to: order[idx + 1].label, reason: f.kind });
        break;
      }
    }
  }
  throw { code: 'all_failed', params: { errors: errors.slice(-3) } };
}

export const complete = (messages, temperature, conn, signal) => stream(messages, () => {}, temperature, conn, signal);
