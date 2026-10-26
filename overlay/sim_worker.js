// Simulation runtime for the "sim" board op. Runs in a Worker started by
// sandbox.html (opaque origin, no network, no DOM). Model-written code gets a
// small drawing API over an OffscreenCanvas in board pixels, plus Matter.js
// when it asks for physics. A heartbeat tells the sandbox it's alive; if the
// code loops forever the heartbeat stops and the sandbox terminates us.
'use strict';

const C = {
  ink: '#EEF1F7', blue: '#6CB6FF', green: '#5BE49B', red: '#FF6B6B',
  amber: '#FFC857', purple: '#C79BFF', muted: '#8B93A7', bg: '#161922',
};
const CYCLE = ['blue', 'amber', 'green', 'purple', 'red'];
const FONT = '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const DEFAULT_LABEL = /^(Body|Circle Body|Rectangle Body|Polygon Body|Trapezoid Body)$/;

let ctx = null, K = 1, W = 0, H = 0;
const frames = [], handlers = [], waiters = [], engines = [];
let failed = false, drew = false, looping = false, t0 = 0, prev = 0;

setInterval(() => postMessage({ type: 'beat' }), 250);

function fail(e) {
  if (failed) return;
  failed = true;
  const msg = e && e.message ? `${e.name || 'Error'}: ${e.message}` : String(e);
  postMessage({ type: 'error', message: msg.slice(0, 300) });
}
self.addEventListener('error', (e) => { e.preventDefault(); fail(e.error || e.message); });
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fail(e.reason); });

// ------------------------------------------------------------ colours
const color = (c, d = C.ink) => (c == null || c === true ? d : C[c] || String(c));
function alpha(c, a) {
  const h = color(c);
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h);
  if (!m) return h;
  let s = m[1];
  if (s.length === 3) s = s.replace(/./g, (x) => x + x);
  const n = parseInt(s, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------ drawing
// o = {color, fill: true (solid) | false | colour | default translucent, width, dash, alpha}
function shape(build, o = {}, closed = true) {
  const c = color(o.color);
  ctx.save();
  if (o.alpha != null) ctx.globalAlpha = +o.alpha;
  ctx.beginPath();
  build();
  if (closed && o.fill !== false) {
    ctx.fillStyle = o.fill === true ? c : typeof o.fill === 'string' ? color(o.fill) : alpha(c, 0.22);
    ctx.fill();
  }
  if (o.stroke !== false && o.width !== 0) {
    ctx.strokeStyle = color(o.stroke ?? o.color);
    ctx.lineWidth = o.width ?? 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (o.dash) ctx.setLineDash(Array.isArray(o.dash) ? o.dash : [9, 8]);
    ctx.stroke();
  }
  ctx.restore();
}

function circle(x, y, r, o) { shape(() => ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2), o); }
function rect(x, y, w, h, o = {}) {
  shape(() => (o.radius && ctx.roundRect ? ctx.roundRect(x, y, w, h, o.radius) : ctx.rect(x, y, w, h)), o);
}
function poly(pts, o) {
  if (!pts || pts.length < 2) return;
  shape(() => { ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath(); }, o);
}
// line(x1,y1,x2,y2,o) or line([[x,y],...], o) for a polyline
function line(a, b, c, d, e) {
  const pts = Array.isArray(a) ? a : [[a, b], [c, d]];
  const o = (Array.isArray(a) ? b : e) || {};
  if (pts.length < 2) return;
  shape(() => { ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); }, o, false);
}
function arrow(x1, y1, x2, y2, o = {}) {
  const ang = Math.atan2(y2 - y1, x2 - x1), L = o.head ?? 16;
  const bx = x2 - Math.cos(ang) * L * 0.8, by = y2 - Math.sin(ang) * L * 0.8;
  line(x1, y1, bx, by, o);
  poly([[x2, y2], [x2 - L * Math.cos(ang - 0.42), y2 - L * Math.sin(ang - 0.42)],
    [x2 - L * Math.cos(ang + 0.42), y2 - L * Math.sin(ang + 0.42)]], { color: o.color, fill: true, width: 1 });
}
// Text is centred on x,y by default, with a dark halo so it reads over shapes.
function text(s, x, y, o = {}) {
  ctx.save();
  const size = Math.max(12, +o.size || 22);
  ctx.font = `${o.weight || 600} ${size}px ${FONT}`;
  ctx.textAlign = o.align || 'center';
  ctx.textBaseline = o.baseline || 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size / 5);
  ctx.strokeStyle = 'rgba(13,15,22,0.85)';
  ctx.strokeText(String(s), x, y);
  ctx.fillStyle = color(o.color);
  ctx.fillText(String(s), x, y);
  ctx.restore();
}
function clear() { ctx.clearRect(0, 0, W, H); }

// Bar chart across an area (default: the whole box): sorting, histograms.
// o.hi = {index: colour} highlights bars; o.labels:false hides the values.
function bars(values, o = {}) {
  const n = values.length;
  if (!n) return;
  const x0 = o.x ?? 20, y0 = o.y ?? 16, w = o.w ?? W - 40, h = o.h ?? H - 32;
  const lab = o.labels !== false, base = lab ? 30 : 0;
  const max = o.max ?? Math.max(1e-9, ...values.map((v) => Math.abs(+v)));
  const gap = Math.min(14, (w / n) * 0.18), bw = (w - gap * (n - 1)) / n;
  values.forEach((v, i) => {
    const bh = (Math.abs(+v) / max) * (h - base);
    const c = (o.hi && o.hi[i]) || (o.colors && o.colors[i]) || o.color || 'blue';
    const x = x0 + i * (bw + gap);
    rect(x, y0 + h - base - bh, bw, bh, { color: c, fill: alpha(c, 0.35), radius: Math.min(6, bw / 4) });
    if (lab && bw >= 22) text(v, x + bw / 2, y0 + h - 12, { size: 20, color: (o.hi && o.hi[i]) || 'ink' });
  });
}

// Line chart of one or more series: [[...],[...]], scaled to fit.
function graph(series, o = {}) {
  const S = Array.isArray(series[0]) ? series : [series];
  const x0 = o.x ?? 50, y0 = o.y ?? 16, w = o.w ?? W - 70, h = o.h ?? H - 50;
  const all = S.flat().map(Number).filter(Number.isFinite);
  const max = o.max ?? Math.max(1e-9, ...all), min = o.min ?? Math.min(0, ...all);
  const n = o.n ?? Math.max(2, ...S.map((s) => s.length));
  line([[x0, y0], [x0, y0 + h], [x0 + w, y0 + h]], { color: 'muted', width: 2 });
  S.forEach((s, k) => {
    const c = (o.colors && o.colors[k]) || CYCLE[k % CYCLE.length];
    const pts = s.map((v, i) => [x0 + (i / (n - 1)) * w, y0 + h - ((v - min) / (max - min || 1)) * h]);
    line(pts, { color: c, width: 3 });
    const lab = o.labels && o.labels[k];
    if (lab && pts.length) {
      const p = pts[pts.length - 1];
      text(lab, Math.min(p[0] + 8, x0 + w - 4), p[1], { size: 20, color: c, align: p[0] + 8 > x0 + w - 60 ? 'right' : 'left' });
    }
  });
}

const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, +ms || 0)));

// ------------------------------------------------------------ physics
// Matter.js quirk: a body created with isStatic:true remembers an infinite
// mass, so un-pinning it later (the "hold, then release on cue" pattern)
// turns its position into NaN. Give such a body a real mass when released.
function patchMatter() {
  const { Body, Vertices, Vector } = Matter;
  const setStatic = Body.setStatic;
  Body.setStatic = function patched(body, isStatic) {
    setStatic.call(this, body, isStatic);
    if (isStatic || body.parts.length > 1 || (Number.isFinite(body.mass) && Number.isFinite(body.inertia))) return;
    const density = Number.isFinite(body.density) && body.density > 0 ? body.density : 0.001;
    const mass = density * body.area;
    Vertices.translate(body.vertices, Vector.neg(body.position));
    const inertia = 4 * Vertices.inertia(body.vertices, mass);
    Vertices.translate(body.vertices, body.position);
    Object.assign(body, { density, mass, inverseMass: 1 / mass, inertia, inverseInertia: 1 / inertia, friction: 0.1 });
  };
}

function physics(o = {}) {
  if (!self.Matter) throw new Error('Matter.js is not available');
  const E = Matter.Engine.create({ gravity: { x: o.gx ?? 0, y: o.gravity ?? 1 } });
  E.autoDraw = o.draw !== false;
  E.acc = 0;
  engines.push(E);
  startLoop();
  return E;
}
// Floor and side walls for the latest physics() world ({top:true} closes it).
function walls(o = {}) {
  const E = engines[engines.length - 1] || physics();
  const { Bodies, Composite } = Matter, t = 80;
  const opt = { isStatic: true, color: o.color || 'muted' };
  const list = [
    Bodies.rectangle(W / 2, H - 5 + t / 2, W * 3, t, opt),
    Bodies.rectangle(-t / 2, H / 2, t, H * 3, { ...opt, render: { visible: false } }),
    Bodies.rectangle(W + t / 2, H / 2, t, H * 3, { ...opt, render: { visible: false } }),
  ];
  if (o.top) list.push(Bodies.rectangle(W / 2, -t / 2, W * 3, t, { ...opt, render: { visible: false } }));
  Composite.add(E.world, list);
  return list;
}
function drawWorld(E) {
  const { Composite } = Matter;
  for (const k of Composite.allConstraints(E.world)) {
    if (k.render && k.render.visible === false) continue;
    const a = k.bodyA ? { x: k.bodyA.position.x + k.pointA.x, y: k.bodyA.position.y + k.pointA.y } : k.pointA;
    const b = k.bodyB ? { x: k.bodyB.position.x + k.pointB.x, y: k.bodyB.position.y + k.pointB.y } : k.pointB;
    if (!a || !b) continue;
    line(a.x, a.y, b.x, b.y, { color: k.color || 'muted', width: 2.5 });
    if (!k.bodyA) circle(a.x, a.y, 5, { color: 'muted', fill: true });
  }
  for (const b of Composite.allBodies(E.world)) {
    if (b.render && b.render.visible === false) continue;
    const c = color(b.color, b.isStatic ? C.muted : C.blue);
    for (const p of b.parts.length > 1 ? b.parts.slice(1) : [b]) {
      if (p.circleRadius) {
        const r = p.circleRadius, { x, y } = p.position;
        circle(x, y, r, { color: c, fill: b.fill });
        if (!b.isStatic && r > 8) line(x, y, x + Math.cos(b.angle) * r, y + Math.sin(b.angle) * r, { color: c, width: 2 });
      } else {
        poly(p.vertices.map((v) => [v.x, v.y]), { color: c, fill: b.fill });
      }
    }
    if (b.label && !DEFAULT_LABEL.test(b.label)) text(b.label, b.position.x, b.position.y, { size: 20 });
  }
}

// ------------------------------------------------------------ the loop
const raf = self.requestAnimationFrame
  ? (f) => self.requestAnimationFrame(f)
  : (f) => setTimeout(() => f(performance.now()), 16);

function frame(fn) {
  if (typeof fn !== 'function') throw new Error('frame() needs a function');
  frames.push(fn);
  startLoop();
}
function startLoop() {
  if (looping) return;
  looping = true;
  raf(tick);
}
function tick(now) {
  if (failed) return;
  try {
    if (!t0) { t0 = now; prev = now; }
    const dt = Math.min(0.05, Math.max(0, (now - prev) / 1000));
    prev = now;
    ctx.setTransform(K, 0, 0, K, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const E of engines) {
      E.acc += dt;
      let n = 0;
      while (E.acc >= 1 / 60 && n < 4) { Matter.Engine.update(E, 1000 / 60); E.acc -= 1 / 60; n++; }
      if (n === 4) E.acc = 0;
      if (E.autoDraw) drawWorld(E);
    }
    for (const f of frames) f((now - t0) / 1000, dt);
    if (!drew) { drew = true; postMessage({ type: 'drew' }); }
  } catch (e) { fail(e); return; }
  raf(tick);
}

// ------------------------------------------------------------ messages
// simsend data reaches on(fn) handlers, on(name, fn) when data (or
// data.name/phase/type) equals name, and whoever is awaiting next().
function on(a, b) {
  if (typeof a === 'function') handlers.push({ fn: a });
  else if (typeof b === 'function') handlers.push({ name: a, fn: b });
}
const next = () => new Promise((r) => waiters.push(r));
function deliver(data) {
  for (const h of handlers) {
    const hit = h.name == null || h.name === data ||
      (data && typeof data === 'object' && (data.name === h.name || data.phase === h.name || data.type === h.name));
    if (!hit) continue;
    try { h.fn(data); } catch (e) { fail(e); }
  }
  for (const r of waiters.splice(0)) r(data);
}

function run(code) {
  Object.assign(self, {
    ctx, W, H, C, frame, on, next, sleep, text, circle, rect, line, arrow, poly, bars, graph,
    physics, walls, drawWorld, clear, rand, clamp, lerp, color, alpha,
  });
  const AsyncFunction = (async () => {}).constructor;
  let fn;
  // p5-style draw()/setup() work too.
  const body = `${code}\n;if (typeof setup === 'function') await setup();` +
    `if (typeof draw === 'function') frame(draw);`;
  try { fn = new AsyncFunction(body); } catch (e) { fail(e); return; }
  ctx.setTransform(K, 0, 0, K, 0, 0);
  fn().then(() => { if (!drew && !looping) postMessage({ type: 'drew' }); }, fail);
}

self.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'init') {
    try {
      K = +m.k || 1; W = +m.w; H = +m.h;
      ctx = m.canvas.getContext('2d');
      if (m.matter) { (0, eval)(m.matter); patchMatter(); }
    } catch (err) { fail(err); return; }
    run(String(m.code || ''));
  } else if (m.type === 'msg') {
    deliver(m.data);
  }
};
