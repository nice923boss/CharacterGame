// Synthesized effects (Web Audio, no audio files).
// Voices come from the p5-comfyui-animation SKILL sound kit: rain ambience and a few UI effects; the game has no
// background music.

function envGain(ctx, dest, t, attack, peak, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(dest);
  return g;
}

function noiseBuffer(ctx) {
  if (!ctx._noise) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    ctx._noise = buf;
  }
  return ctx._noise;
}

function noiseSource(ctx, t, len) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  src.start(t, Math.random() * 1.5);
  src.stop(t + len + 0.1);
  return src;
}

function biquad(ctx, type, freq, q = 1) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function chime(ctx, bus, t, vol = 0.08) {
  [1568, 2349, 3136].forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(envGain(ctx, bus, t + i * 0.06, 0.004, vol / (i + 1), 2.2));
    o.start(t + i * 0.06);
    o.stop(t + 2.5);
  });
}

function popSfx(ctx, bus, t, vol = 0.16) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(1300, t + 0.07);
  o.connect(envGain(ctx, bus, t, 0.004, vol, 0.12));
  o.start(t);
  o.stop(t + 0.2);
}

function whoosh(ctx, dest, t, dur = 0.9, up = false, vol = 0.2) {
  const bp = biquad(ctx, 'bandpass', up ? 400 : 3000, 1.5);
  bp.frequency.exponentialRampToValueAtTime(up ? 3000 : 400, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  noiseSource(ctx, t, dur).connect(bp).connect(g).connect(dest);
}

const MUTE_KEY = 'chienzhi.muted';

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

class SoundSystem {
  constructor() {
    this.ctx = null;
    this.rain = null;
    this.sfxVol = 0.7;
    this.wantWeather = 'none';
    this.muted = readMuted();
  }

  // Must run inside a user gesture (browser autoplay rule)
  unlock() {
    if (this.ctx) { this.wake(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;   // no Web Audio: the game plays silently instead of breaking the click that called this
    let ctx;
    try { ctx = new AC(); } catch (e) { console.warn('audio unavailable', e); return; }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);
    this.setWeather(this.wantWeather);
  }

  // Resume after the autoplay block, a background tab, or an iOS interruption (state 'interrupted')
  wake() {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed' && !document.hidden) ctx.resume().catch(() => {});
  }

  // M on the game screen: silences the effects, remembered across visits
  toggleMute() {
    this.muted = !this.muted;
    try {
      if (this.muted) localStorage.setItem(MUTE_KEY, '1');
      else localStorage.removeItem(MUTE_KEY);
    } catch { /* storage blocked: muted for this visit only */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  setVolume(sfx) {
    this.sfxVol = sfx;
    if (!this.ctx) return;
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.1);
  }

  setWeather(weather) {
    this.wantWeather = weather;
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (weather === 'rain' && !this.rain) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer(ctx);
      src.loop = true;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setTargetAtTime(0.05, ctx.currentTime, 1);
      src.connect(biquad(ctx, 'bandpass', 1800, 0.6)).connect(g).connect(this.sfx);
      src.start();
      this.rain = { src, g };
    } else if (weather !== 'rain' && this.rain) {
      const r = this.rain;
      r.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.6);
      setTimeout(() => r.src.stop(), 4000);
      this.rain = null;
    }
  }

  play(name) {
    if (!this.ctx || this.muted || this.sfxVol <= 0) return;
    const t = this.ctx.currentTime + 0.01;
    if (name === 'select') chime(this.ctx, this.sfx, t, 0.07);
    else if (name === 'click') popSfx(this.ctx, this.sfx, t, 0.1);
    else if (name === 'scene') whoosh(this.ctx, this.sfx, t, 1.1, false, 0.18);
  }
}

export const sound = new SoundSystem();

// Keyboard-only players never click: a key press is also a gesture that may start audio
document.addEventListener('keydown', () => sound.unlock(), true);
// A background tab stops the rain instead of playing to nobody
document.addEventListener('visibilitychange', () => {
  if (!sound.ctx) return;
  if (document.hidden) sound.ctx.suspend().catch(() => {});
  else sound.wake();
});
