// Synthesized music and effects (Web Audio, no audio files).
// Voices come from the p5-comfyui-animation SKILL sound kit; the fixed score timeline is replaced by
// a looping generator per bgm_mood with a 2.5 s crossfade, plus rain ambience and a few UI effects.

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function makeReverb(ctx, seconds = 2.6) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

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

function pluck(ctx, bus, t, midi, durSec = 1, vol = 0.22) {
  const f = midiToHz(midi);
  const decay = Math.max(1.2, durSec * 1.6);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(f * 8, t);
  lp.frequency.exponentialRampToValueAtTime(f * 1.5, t + decay);
  const g = envGain(ctx, lp, t, 0.005, vol, decay);
  lp.connect(bus);
  [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]].forEach(([mult, type, amp]) => {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = type;
    o.frequency.value = f * mult;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + decay + 0.1);
  });
}

function pad(ctx, bus, t, notes, len, vol = 0.045) {
  notes.forEach((m) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = midiToHz(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.9);
    g.gain.setValueAtTime(vol, t + len - 0.6);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 0.4);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + len + 0.5);
  });
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

function thud(ctx, bus, t, vol = 0.4, pitch = 1) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(190 * pitch, t);
  o.frequency.exponentialRampToValueAtTime(80 * pitch, t + 0.12);
  o.connect(envGain(ctx, bus, t, 0.003, vol, 0.18));
  o.start(t);
  o.stop(t + 0.25);
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

// ---------- mood loops ----------
// prog: one chord per bar (4 beats); scale: melody notes; density: chance of a melody note per beat;
// pulse: low thud on each beat; arp: pluck chord notes on every eighth
const MOODS = {
  calm: { bpm: 72, prog: [[48, 55, 64, 71], [45, 52, 60, 67], [41, 48, 57, 64], [43, 50, 59, 62]],
          scale: [72, 74, 76, 79, 81, 84], density: 0.35 },
  warm: { bpm: 84, prog: [[41, 48, 57, 64], [50, 57, 62, 65], [46, 53, 62, 65], [48, 55, 64, 67]],
          scale: [72, 74, 77, 79, 81, 84], density: 0.45 },
  tense: { bpm: 100, prog: [[45, 52, 60], [45, 52, 60], [46, 53, 62], [44, 52, 59]],
           scale: [69, 70, 72, 75, 76], density: 0.2, pulse: true },
  sad: { bpm: 62, prog: [[45, 52, 60, 64], [41, 48, 57, 60], [50, 57, 60, 65], [40, 52, 56, 59]],
         scale: [69, 71, 72, 74, 76], density: 0.3 },
  mysterious: { bpm: 68, prog: [[50, 57, 65], [46, 53, 62, 69], [43, 50, 58, 62], [45, 52, 61, 64]],
                scale: [74, 76, 78, 80, 82], density: 0.28 },
  action: { bpm: 132, prog: [[40, 52, 55, 59], [36, 48, 52, 55], [38, 50, 54, 57], [40, 52, 55, 59]],
            scale: [76, 79, 81, 83, 86], density: 0.25, pulse: true, arp: true },
};

class SoundSystem {
  constructor() {
    this.ctx = null;
    this.layer = null;
    this.rain = null;
    this.bgmVol = 0.6;
    this.sfxVol = 0.7;
    this.wantMood = null;
    this.wantWeather = 'none';
  }

  // Must run inside a user gesture (browser autoplay rule)
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const reverb = makeReverb(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    reverb.connect(wet).connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = this.bgmVol;
    this.music.connect(this.master);
    this.music.connect(reverb);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.sfxVol;
    this.sfx.connect(this.master);
    setInterval(() => this.tick(), 200);
    if (this.wantMood) this.setMood(this.wantMood, true);
    this.setWeather(this.wantWeather);
  }

  setVolumes(bgm, sfx) {
    this.bgmVol = bgm;
    this.sfxVol = sfx;
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(bgm, this.ctx.currentTime, 0.1);
    this.sfx.gain.setTargetAtTime(sfx, this.ctx.currentTime, 0.1);
  }

  setMood(mood, force = false) {
    if (!MOODS[mood]) mood = 'calm';
    if (!force && mood === this.wantMood && this.layer) return;
    this.wantMood = mood;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.layer) {
      const old = this.layer;
      old.gain.gain.setTargetAtTime(0.0001, now, 0.8);
      setTimeout(() => old.gain.disconnect(), 6000);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.setTargetAtTime(1, now + 0.3, 0.8);
    gain.connect(this.music);
    this.layer = { mood, spec: MOODS[mood], gain, next: now + 0.3, beat: 0 };
  }

  stopMusic() {
    this.wantMood = null;
    if (this.layer && this.ctx) this.layer.gain.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.5);
    this.layer = null;
  }

  tick() {
    const L = this.layer;
    if (!L) return;
    const ctx = this.ctx;
    const beatLen = 60 / L.spec.bpm;
    while (L.next < ctx.currentTime + 1.2) {
      const t = L.next;
      const bar = Math.floor(L.beat / 4) % L.spec.prog.length;
      const chord = L.spec.prog[bar];
      if (L.beat % 4 === 0) pad(ctx, L.gain, t, chord, 4 * beatLen);
      if (L.spec.pulse) thud(ctx, L.gain, t, L.beat % 4 === 0 ? 0.22 : 0.12, 0.7);
      if (L.spec.arp) {
        pluck(ctx, L.gain, t, chord[(L.beat * 2) % chord.length] + 12, beatLen / 2, 0.07);
        pluck(ctx, L.gain, t + beatLen / 2, chord[(L.beat * 2 + 1) % chord.length] + 12, beatLen / 2, 0.06);
      }
      if (Math.random() < L.spec.density) {
        const note = L.spec.scale[Math.floor(Math.random() * L.spec.scale.length)];
        pluck(ctx, L.gain, t + (Math.random() < 0.3 ? beatLen / 2 : 0), note, beatLen * 2, 0.11);
      }
      L.beat++;
      L.next += beatLen;
    }
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
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.01;
    if (name === 'select') chime(this.ctx, this.sfx, t, 0.07);
    else if (name === 'click') popSfx(this.ctx, this.sfx, t, 0.1);
    else if (name === 'scene') whoosh(this.ctx, this.sfx, t, 1.1, false, 0.18);
  }
}

export const sound = new SoundSystem();
