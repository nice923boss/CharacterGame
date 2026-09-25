// p5 stage: background with crossfade and fade-through-black transitions, up to 3 sprites with speaker
// highlight, weather particles and a vignette. Text and buttons are DOM layers above the canvas.

const W = 1280;
const H = 720;
const SPRITE_H = 680;
const SLOTS = { 1: [0.5], 2: [0.3, 0.7], 3: [0.2, 0.5, 0.8] };

export function createStage(host) {
  const S = {
    bg: null, bgPrev: null, bgFade: 1, bgUrl: null,
    black: 0, blackTarget: 0, onBlack: null,
    pending: false, dim: 0,
    cast: [],              // [{cid, url, img, x, alpha, focus, leaving}]
    speaker: null,
    weather: 'none', weatherOn: true, parts: [],
    cache: new Map(),      // url -> p5.Image | 'loading' | 'error'
  };
  let P = null;

  function image(url) {
    if (!url || !P) return null;
    const hit = S.cache.get(url);
    if (hit === undefined) {
      S.cache.set(url, 'loading');
      P.loadImage(url, (img) => S.cache.set(url, img), () => S.cache.set(url, 'error'));
      return null;
    }
    return typeof hit === 'object' ? hit : null;
  }

  function layout() {
    const staying = S.cast.filter((c) => !c.leaving);
    const xs = SLOTS[staying.length] || [];
    staying.forEach((c, i) => { c.tx = xs[i] * W; });
  }

  function makeParts(kind) {
    const n = { rain: 170, snow: 120, fog: 7, fireflies: 38, petals: 55 }[kind] || 0;
    return Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H, s: Math.random(), p: Math.random() * Math.PI * 2,
    }));
  }

  new p5((p) => {
    P = p;
    let vignette;
    let blob;
    p.setup = () => {
      p.createCanvas(W, H).parent(host);
      p.pixelDensity(1);
      p.frameRate(60);
      vignette = p.createGraphics(W, H);
      const ctx = vignette.drawingContext;
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,10,0.55)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      blob = p.createGraphics(400, 400);
      const b = blob.drawingContext;
      const bg = b.createRadialGradient(200, 200, 0, 200, 200, 200);
      bg.addColorStop(0, 'rgba(225,230,240,0.32)');
      bg.addColorStop(1, 'rgba(225,230,240,0)');
      b.fillStyle = bg;
      b.fillRect(0, 0, 400, 400);
    };

    function cover(img, alpha) {
      const k = Math.max(W / img.width, H / img.height);
      const w = img.width * k;
      const h = img.height * k;
      p.tint(255 * (1 - S.dim * 0.5), alpha);
      p.image(img, (W - w) / 2, (H - h) / 2, w, h);
      p.noTint();
    }

    function emptySky(t) {
      const ctx = p.drawingContext;
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#0d1330');
      g.addColorStop(1, '#241a33');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      for (let i = 0; i < 5; i++) {
        p.image(blob, ((t * 12 + i * 330) % (W + 500)) - 400, 180 + Math.sin(t * 0.3 + i) * 60 + i * 50, 560, 360);
      }
    }

    function drawWeather(t, dt) {
      if (!S.weatherOn) return;
      const kind = S.weather;
      p.noStroke();
      if (kind === 'rain') {
        p.stroke(200, 215, 240, 120);
        p.strokeWeight(1.4);
        for (const q of S.parts) {
          q.y += (900 + q.s * 500) * dt;
          q.x -= 180 * dt;
          if (q.y > H) { q.y = -20; q.x = Math.random() * (W + 200); }
          p.line(q.x, q.y, q.x - 6, q.y + 22 + q.s * 10);
        }
      } else if (kind === 'snow') {
        p.fill(255, 255, 255, 210);
        for (const q of S.parts) {
          q.y += (30 + q.s * 50) * dt;
          q.x += Math.sin(t + q.p) * 20 * dt;
          if (q.y > H) { q.y = -8; q.x = Math.random() * W; }
          p.circle(q.x, q.y, 2 + q.s * 4);
        }
      } else if (kind === 'fog') {
        S.parts.forEach((q, i) => {
          const x = ((t * (14 + q.s * 16) + q.x) % (W + 900)) - 600;
          p.tint(255, 150);
          p.image(blob, x, 260 + i * 55 + Math.sin(t * 0.2 + q.p) * 30, 900, 420);
          p.noTint();
        });
      } else if (kind === 'fireflies') {
        for (const q of S.parts) {
          const x = q.x + Math.sin(t * 0.5 + q.p) * 40;
          const y = q.y + Math.cos(t * 0.4 + q.p * 2) * 30;
          const a = 0.5 + 0.5 * Math.sin(t * 2 + q.p * 3);
          p.fill(255, 236, 140, 40 * a);
          p.circle(x, y, 22);
          p.fill(255, 248, 190, 220 * a);
          p.circle(x, y, 4);
        }
      } else if (kind === 'petals') {
        p.fill(250, 190, 210, 220);
        for (const q of S.parts) {
          q.y += (40 + q.s * 40) * dt;
          q.x += (30 + Math.sin(t + q.p) * 40) * dt;
          if (q.y > H || q.x > W + 10) { q.y = -10; q.x = Math.random() * W - 100; }
          p.push();
          p.translate(q.x, q.y);
          p.rotate(t * (1 + q.s) + q.p);
          p.ellipse(0, 0, 9, 5);
          p.pop();
        }
      }
    }

    p.draw = () => {
      const dt = Math.min(p.deltaTime / 1000, 0.1);
      const t = p.millis() / 1000;
      S.dim += ((S.pending ? 1 : 0) - S.dim) * Math.min(1, dt * 3);
      if (S.bg) S.bgFade = Math.min(1, S.bgFade + dt / 1.2);

      p.background(0);
      if (S.bgPrev && (!S.bg || S.bgFade < 1)) cover(S.bgPrev, 255);
      if (S.bg) cover(S.bg, 255 * S.bgFade);
      else if (!S.bgPrev) emptySky(t);

      for (const c of S.cast) {
        const img = image(c.url) || c.img;
        if (img) c.img = img;
        c.x += (c.tx - c.x) * Math.min(1, dt * 6);
        c.alpha += ((c.leaving ? 0 : 1) - c.alpha) * Math.min(1, dt * 5);
        const focus = S.speaker === null || S.speaker === c.cid ? 1 : 0;
        c.focus += (focus - c.focus) * Math.min(1, dt * 6);
        if (!c.img) continue;
        const k = SPRITE_H / c.img.height * (0.97 + 0.03 * c.focus);
        const w = c.img.width * k;
        const h = c.img.height * k;
        const shade = 150 + 105 * c.focus;
        p.tint(shade * (1 - S.dim * 0.3), shade * (1 - S.dim * 0.3), shade * (1 - S.dim * 0.25), 255 * c.alpha);
        p.image(c.img, c.x - w / 2, H - h + 10 * (1 - c.focus), w, h);
        p.noTint();
      }
      S.cast = S.cast.filter((c) => !(c.leaving && c.alpha < 0.02));

      drawWeather(t, dt);
      p.image(vignette, 0, 0);

      const before = S.black;
      S.black += Math.sign(S.blackTarget - S.black) * Math.min(Math.abs(S.blackTarget - S.black), dt / 0.5);
      if (S.black >= 1 && before < 1 && S.onBlack) {
        const fn = S.onBlack;
        S.onBlack = null;
        fn();
        S.blackTarget = 0;
      }
      if (S.black > 0) { p.noStroke(); p.fill(0, 255 * S.black); p.rect(0, 0, W, H); }
    };
  }, host);

  return {
    // url: scene image or null (not drawn yet); transition: fade through black and clear the cast
    setScene(url, { transition = false, onSwap = null } = {}) {
      const swap = () => {
        if (transition) S.cast = [];
        S.speaker = null;
        if (url !== S.bgUrl) {
          S.bgUrl = url;
          const ready = image(url);
          if (transition && ready) { S.bg = ready; S.bgPrev = null; S.bgFade = 1; }
          else { S.bgPrev = S.bg || S.bgPrev; S.bg = null; S.bgFade = 0; }   // keep the old picture until the new one loads
        }
        if (onSwap) onSwap();
      };
      if (transition) { S.onBlack = swap; S.blackTarget = 1; } else swap();
    },
    // Called every frame-ish from the game loop; resolves the scene image once it is loaded
    refreshScene() {
      if (!S.bgUrl || S.bg) return;
      const img = image(S.bgUrl);
      if (img) { S.bg = img; S.bgFade = 0; }
    },
    setPending(v) { S.pending = v; },
    // Show a character (joins the stage if absent; the oldest leaves when a 4th arrives)
    show(cid, url) {
      let c = S.cast.find((x) => x.cid === cid && !x.leaving);
      if (!c) {
        const staying = S.cast.filter((x) => !x.leaving);
        if (staying.length >= 3) staying[0].leaving = true;
        c = { cid, url, img: null, x: W / 2, tx: W / 2, alpha: 0, focus: 0 };
        S.cast.push(c);
        layout();
        c.x = c.tx;
      }
      c.url = url;
      image(url);
      return c;
    },
    setCast(list) {
      S.cast = [];
      list.forEach(({ cid, url }) => this.show(cid, url));
      S.cast.forEach((c) => { c.alpha = 1; c.x = c.tx; });
    },
    castIds() { return S.cast.filter((c) => !c.leaving).map((c) => c.cid); },
    setSpeaker(cid) { S.speaker = cid; },
    setWeather(kind) { if (kind !== S.weather) { S.weather = kind; S.parts = makeParts(kind); } },
    setWeatherOn(on) { S.weatherOn = on; },
    preload(url) { image(url); },
  };
}
