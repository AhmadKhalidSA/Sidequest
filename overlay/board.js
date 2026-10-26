// Whiteboard renderer. The tutor sends small JSON ops; this draws them on a
// fixed 1000x600 board (scaled to the panel) with hand-drawn rough.js strokes
// that animate in, KaTeX for math, and HTML for text and tables. Layout
// templates (row, stack, seq/msg) do the geometry so the model only has to
// supply content, which is where most ugly AI-drawn boards come from.

const COLORS = {
  ink: '#EEF1F7', blue: '#6CB6FF', green: '#5BE49B', red: '#FF6B6B',
  amber: '#FFC857', purple: '#C79BFF', muted: '#8B93A7',
};
const color = (c) => COLORS[c] || (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : COLORS.ink);
const W = 1000, H = 600;
const SVGNS = 'http://www.w3.org/2000/svg';

// Animation libraries (all local, all free licences): GSAP for tweens and
// motion paths, Rough Notation for hand-drawn marks, Mermaid for auto-laid-out
// diagrams. Each is optional: an op whose library is missing does nothing.
if (window.gsap && window.MotionPathPlugin) gsap.registerPlugin(MotionPathPlugin);
if (window.mermaid) {
  mermaid.initialize({
    startOnLoad: false, theme: 'dark', securityLevel: 'strict',
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif', fontSize: 18,
    themeVariables: {
      background: 'transparent', primaryColor: '#283247', primaryTextColor: '#EEF1F7', primaryBorderColor: '#6CB6FF',
      secondaryColor: '#2f2744', tertiaryColor: '#1f2a2a', lineColor: '#8B93A7', textColor: '#EEF1F7',
      nodeTextColor: '#EEF1F7', mainBkg: '#283247', clusterBkg: '#1c2030', edgeLabelBackground: '#1c2030',
      actorBkg: '#283247', actorBorder: '#6CB6FF', actorTextColor: '#EEF1F7', signalColor: '#FFC857', signalTextColor: '#EEF1F7',
      labelBoxBkgColor: '#283247', noteBkgColor: '#3a3320', noteTextColor: '#FFC857',
      pie1: '#6CB6FF', pie2: '#FFC857', pie3: '#5BE49B', pie4: '#C79BFF', pie5: '#FF6B6B', pie6: '#8B93A7',
    },
    flowchart: { curve: 'basis', padding: 12 }, sequence: { mirrorActors: false },
  });
}
const GEOMETRY = 'path, line, polyline, polygon, circle, ellipse, rect';

// Free-form SVG from the model: only drawing elements survive; no scripts,
// no links, no external references, no event handlers.
const SVG_TAGS = new Set(['g', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse',
  'text', 'tspan', 'defs', 'marker', 'lineargradient', 'radialgradient', 'stop', 'title', 'clippath',
  // motion: a packet travelling along a path, a pulse, a fade
  'animate', 'animatemotion', 'animatetransform', 'set', 'mpath']);
function sanitizeSvg(markup) {
  const doc = new DOMParser().parseFromString(`<svg xmlns="${SVGNS}">${markup}</svg>`, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('bad svg markup');
  const clean = (node) => {
    for (const child of [...node.children]) {
      if (!SVG_TAGS.has(child.tagName.toLowerCase())) { child.remove(); continue; }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase(), v = attr.value.trim();
        const external = n.includes('href') ? !v.startsWith('#') : /url\(/i.test(v) && !/url\(\s*#/i.test(v);
        if (n.startsWith('on') || external) child.removeAttribute(attr.name);
      }
      clean(child);
    }
  };
  clean(doc.documentElement);
  const frag = document.createDocumentFragment();
  for (const child of [...doc.documentElement.childNodes]) frag.appendChild(document.importNode(child, true));
  return frag;
}

// HTML mockups from the model (terminals, app windows, cards): layout and
// text only. No scripts, frames, forms, links or outside resources; images
// only from the local media cache.
const HTML_TAGS = new Set(['div', 'span', 'p', 'b', 'i', 'em', 'strong', 'u', 's', 'code', 'pre', 'table',
  'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'ul', 'ol', 'li', 'br', 'hr', 'small', 'sup', 'sub', 'h1', 'h2',
  'h3', 'h4', 'img', 'kbd', 'mark', 'blockquote', 'figure', 'figcaption', 'caption', 'colgroup', 'col']);
const HTML_ATTRS = new Set(['class', 'style', 'colspan', 'rowspan', 'title', 'alt', 'width', 'height', 'src']);
function sanitizeHtml(markup) {
  const doc = new DOMParser().parseFromString(`<div>${markup}</div>`, 'text/html');
  const clean = (node) => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'svg', 'math'].includes(tag)) {
        child.remove();
        continue;
      }
      if (!HTML_TAGS.has(tag)) { clean(child); child.replaceWith(...child.childNodes); continue; }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase(), v = attr.value;
        const badSrc = n === 'src' && !(tag === 'img' && /^(\.\.\/cache\/|data:image\/)/.test(v));
        const badStyle = n === 'style' && /url\(|expression|position\s*:\s*fixed|@import/i.test(v);
        if (!HTML_ATTRS.has(n) || badSrc || badStyle) child.removeAttribute(attr.name);
      }
      clean(child);
    }
  };
  const root = doc.body.firstElementChild;
  clean(root);
  return root.innerHTML;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Text with inline $math$.
function richText(s) {
  return String(s ?? '').split(/(\$[^$]+\$)/g).map((part) => {
    if (part.length > 2 && part.startsWith('$') && part.endsWith('$')) {
      return katex.renderToString(part.slice(1, -1), { throwOnError: false });
    }
    return escapeHtml(part);
  }).join('');
}

// Right-to-left text (Arabic, Hebrew...). An element whose own text is mostly
// RTL letters gets dir="rtl": bidi order, shaping and start (right) alignment.
// A mostly-LTR line with an RTL word keeps LTR; the browser orders the
// embedded run. Numbers and symbols don't vote. English boards never get past
// the first test.
const RTL_RE = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER_RE = /\p{L}/u;
function plainText(node) {   // the readable text, without KaTeX or SVG internals
  let s = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) s += c.data;
    else if (c.nodeType === 1 && !c.classList.contains('katex') && c.localName !== 'svg') s += plainText(c);
  }
  return s;
}
function textDir(s) {   // 'rtl' | 'ltr' | null (no letters)
  let r = 0, l = 0, first = null;
  for (const ch of String(s ?? '')) {
    if (!LETTER_RE.test(ch)) continue;
    const rtl = RTL_RE.test(ch);
    if (rtl) r++; else l++;
    first = first || (rtl ? 'rtl' : 'ltr');
  }
  return r > l ? 'rtl' : r < l ? 'ltr' : first;
}
const BIDI_BLOCKS = 'div, p, li, th, td, caption, figcaption, h1, h2, h3, h4, blockquote, .note, [data-bidi]';
function applyBidi(el) {
  if (!el || !RTL_RE.test(el.textContent || '') || el.matches('pre, svg')) return;
  if (!el.hasAttribute('dir') && textDir(plainText(el)) === 'rtl') el.dir = 'rtl';
  // Inner blocks (table cells, card lines) that read the other way get their own dir.
  for (const node of el.querySelectorAll(BIDI_BLOCKS)) {
    if (node.hasAttribute('dir') || node.closest('.katex, pre, code, .term')) continue;
    const d = textDir(plainText(node));
    const inherited = node.parentElement.closest('[dir]')?.dir || 'ltr';
    if (d && d !== inherited) node.dir = d;
  }
  if (el.localName === 'table') {
    // A table whose cells are mostly RTL flows right to left (first column on the right).
    let r = 0, l = 0;
    for (const c of el.querySelectorAll('th, td')) {
      const d = textDir(plainText(c));
      if (d === 'rtl') r++; else if (d === 'ltr') l++;
    }
    if (r > l && el.dir !== 'rtl') {
      el.dir = 'rtl';
      for (const c of el.querySelectorAll('th[dir=rtl], td[dir=rtl]')) c.removeAttribute('dir');
      for (const c of el.querySelectorAll('th:not([dir]), td:not([dir])')) {
        if (textDir(plainText(c)) === 'ltr') c.dir = 'ltr';
      }
    }
  }
}

// Safe expression compiler for plots: + - * / ^, implicit multiplication,
// a whitelist of functions and constants. No eval.
function compileExpr(src) {
  const s = String(src).toLowerCase().replace(/\*\*/g, '^');
  const toks = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) { let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++; toks.push({ t: 'n', v: parseFloat(s.slice(i, j)) }); i = j; continue; }
    if (/[a-z]/.test(c)) { let j = i; while (j < s.length && /[a-z0-9]/.test(s[j])) j++; toks.push({ t: 'id', v: s.slice(i, j) }); i = j; continue; }
    if ('+-*/^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
    throw new Error(`bad character ${c}`);
  }
  const FN = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
    ln: Math.log, log: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow,
  };
  const CONST = { pi: Math.PI, e: Math.E };
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => (toks[p] && toks[p].t === t ? (p++, true) : false);
  const expr = () => {
    let a = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t, b = term(), l = a;
      a = op === '+' ? (x) => l(x) + b(x) : (x) => l(x) - b(x);
    }
    return a;
  };
  const term = () => {
    let a = unary();
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === '*' || t.t === '/') {
        p++; const b = unary(), l = a;
        a = t.t === '*' ? (x) => l(x) * b(x) : (x) => l(x) / b(x);
      } else if (t.t === 'n' || t.t === 'id' || t.t === '(') {
        const b = power(), l = a;   // implicit multiplication: 2x, 3(x+1)
        a = (x) => l(x) * b(x);
      } else break;
    }
    return a;
  };
  const unary = () => {
    if (eat('-')) { const a = unary(); return (x) => -a(x); }
    if (eat('+')) return unary();
    return power();
  };
  const power = () => {
    const base = atom();
    if (eat('^')) { const ex = unary(); return (x) => Math.pow(base(x), ex(x)); }
    return base;
  };
  const atom = () => {
    const t = toks[p++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'n') return () => t.v;
    if (t.t === '(') { const a = expr(); if (!eat(')')) throw new Error('missing )'); return a; }
    if (t.t === 'id') {
      if (t.v === 'x') return (x) => x;
      if (t.v in CONST) { const v = CONST[t.v]; return () => v; }
      if (t.v in FN) {
        if (!eat('(')) throw new Error(`${t.v} needs (`);
        const args = [expr()];
        while (eat(',')) args.push(expr());
        if (!eat(')')) throw new Error('missing )');
        const f = FN[t.v];
        return (x) => f(...args.map((g) => g(x)));
      }
      throw new Error(`unknown name ${t.v}`);
    }
    throw new Error(`unexpected ${t.t}`);
  };
  const f = expr();
  if (p !== toks.length) throw new Error('trailing input');
  return f;
}

class Board {
  constructor(root, onTitle) {
    this.root = root;
    this.svg = root.querySelector('svg');
    this.layer = root.querySelector('.html');
    this.rc = rough.svg(this.svg);
    this.onTitle = onTitle;
    // Content layers live in an untransformed viewport, which clips them to
    // below the title zone (a zoomed table can't run over the title).
    this.viewport = document.createElement('div');
    this.viewport.className = 'viewport';
    root.insertBefore(this.viewport, this.svg);
    this.viewport.appendChild(this.svg);
    this.viewport.appendChild(this.layer);
    // The title sits in its own layer, so framing and zoom never move it.
    this.head = document.createElement('div');
    this.head.className = 'html head';
    root.appendChild(this.head);
    this.els = new Map();
    this.seqs = new Map();
    this.highlight = null;
    this.top = 20;          // nothing is drawn above this (the title zone)
    this.cursorY = 30;
    this.auto = 0;
    this.view = { s: 1, tx: 0, ty: 0 };   // camera framing of the content
    this.zoom = null;                      // an explicit zoom overrides it
    this.fitTimer = null;
  }

  apply(cmd) {
    const fn = this[`op_${cmd.op}`];
    if (!fn) { console.warn('unknown board op', cmd); return; }
    if (cmd.op !== 'clear') this.unveil();
    try { fn.call(this, cmd); } catch (e) { console.error('board op failed', cmd, e); }
    this.fitContent();
  }

  // ------------------------------------------------------------- layout
  // The model picks coordinates, and it doesn't always pick well. These
  // rules keep a board readable whatever it sends:
  //  1. nothing enters the title zone,
  //  2. text and templates that would land on top of something are pushed
  //     below it (unless fully inside a shape: a label in a container),
  //  3. if the board grows too tall or wide, the drawing scales down to fit.
  overlaps(a, b) {
    return a.x < b.x + b.w - 2 && b.x < a.x + a.w - 2 && a.y < b.y + b.h - 2 && b.y < a.y + a.h - 2;
  }

  contains(outer, inner) {
    return inner.x >= outer.x - 2 && inner.y >= outer.y - 2 &&
      inner.x + inner.w <= outer.x + outer.w + 2 && inner.y + inner.h <= outer.y + outer.h + 2;
  }

  avoid(b) {
    let y = Math.max(b.y, this.top);
    for (let guard = 0; guard < 30; guard++) {
      const probe = { ...b, y };
      let hit = null;
      for (const rec of this.els.values()) {
        if (rec.solid === false) continue;
        if (this.overlaps(probe, rec.bbox) && !this.contains(rec.bbox, probe)) { hit = rec; break; }
      }
      if (!hit) break;
      y = hit.bbox.y + hit.bbox.h + 12;
    }
    return y;
  }

  // Camera framing: the content fills the board, centred, up to 1.75x. It
  // shrinks at once when something new lands outside the view, and grows
  // only after a short pause, so a board that's still being drawn doesn't
  // jump around under the learner's eyes.
  fitContent() {
    if (this.zoom) return;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const rec of this.els.values()) {
      const b = rec.bbox;
      if (!(b.w > 0 || b.h > 0)) continue;
      left = Math.min(left, b.x); top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.w); bottom = Math.max(bottom, b.y + b.h);
    }
    let target = { s: 1, tx: 0, ty: 0 };
    if (Number.isFinite(left)) {
      const pad = 24, availW = W - 2 * pad, availH = H - this.top - pad;
      const cw = Math.max(right - left, 1), ch = Math.max(bottom - top, 1);
      const s = Math.min(1.75, availW / cw, availH / ch);
      target = {
        s,
        tx: pad + (availW - cw * s) / 2 - left * s,
        ty: this.top + Math.max(0, (availH - ch * s) / 2) - top * s,
      };
    }
    const cur = this.view;
    clearTimeout(this.fitTimer);
    const outside = Number.isFinite(left) && (
      left * cur.s + cur.tx < 0 || top * cur.s + cur.ty < this.top - 2 ||
      right * cur.s + cur.tx > W || bottom * cur.s + cur.ty > H);
    const changed = Math.abs(target.s - cur.s) > 0.06 ||
      Math.abs(target.tx - cur.tx) > 20 || Math.abs(target.ty - cur.ty) > 20;
    if (outside || target.s < cur.s - 0.01) this.setView(target);
    else if (changed) this.fitTimer = setTimeout(() => this.setView(target), 1200);
  }

  setView(v) {
    this.view = v;
    this.applyView();
  }

  applyView() {
    const v = this.zoom || this.view;
    this.viewport.style.clipPath = this.top > 20 ? `inset(${this.top - 8}px 0 0 0)` : '';
    for (const layer of [this.svg, this.layer]) {
      layer.style.transformOrigin = '0 0';
      layer.style.transition = 'transform 550ms cubic-bezier(.2,.7,.2,1)';
      layer.style.transform = (v.s === 1 && !v.tx && !v.ty) ? '' : `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    }
  }

  // Resolve a pointing target: an element id, optionally one row of a table
  // ("row" 1 = first data row, or "tb1:3"). Returns {rec, id, row, bbox}.
  targetBox(cmd) {
    let id = cmd.target, row = cmd.row;
    if (typeof id === 'string') {
      const m = id.match(/^(.*):(\d+)$/);
      if (m && this.els.has(m[1])) { id = m[1]; row = +m[2]; }
    }
    const rec = this.els.get(id);
    if (!rec) return null;
    let bbox = rec.bbox;
    const table = rec.nodes[0];
    if (row != null && table && table.rows && table.rows[row]) {
      const tr = table.rows[row];
      bbox = { x: rec.bbox.x, y: rec.bbox.y + tr.offsetTop, w: rec.bbox.w, h: tr.offsetHeight };
    } else {
      row = null;
    }
    return { rec, id, row, bbox };
  }

  // ---------------------------------------------------------- bookkeeping
  register(id, rec) {
    id = id || `_auto${++this.auto}`;
    if (this.els.has(id)) this.remove(id, true);
    rec.id = id;
    this.els.set(id, rec);
    const b = rec.bbox;
    if (rec.solid !== false) this.cursorY = Math.max(this.cursorY, b.y + b.h + 18);
    return rec;
  }

  remove(id, instant = false) {
    const rec = this.els.get(id);
    if (!rec) return;
    this.els.delete(id);
    if (rec.anno) { try { rec.anno.remove(); } catch { /* already gone */ } }
    for (const n of rec.nodes) this.fadeOut(n, instant);
    if (this.highlight && this.highlight.target === id) { this.fadeOut(this.highlight.node); this.highlight = null; }
  }

  fadeOut(node, instant = false) {
    if (instant) { node.remove(); return; }
    node.style.transition = 'opacity 220ms ease';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 240);
  }

  // Draw-on animation for strokes (rough.js or free SVG); fills fade in.
  animate(g, delay = 0) {
    g.style.opacity = '0';
    g.style.transition = `opacity 200ms ease ${delay}ms`;
    let d = delay;
    for (const p of g.querySelectorAll(GEOMETRY)) {
      if (p.getAttribute('stroke') === 'none' || p.dataset.static) continue;
      const len = p.getTotalLength();
      if (!len) continue;
      const t = Math.min(650, Math.max(160, len * 1.1));
      p.style.strokeDasharray = `${len} ${len}`;
      p.style.strokeDashoffset = `${len}`;
      p.style.transition = `stroke-dashoffset ${t}ms ease-out ${d}ms`;
      d += t * 0.3;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      g.style.opacity = '1';
      for (const p of g.querySelectorAll(GEOMETRY)) p.style.strokeDashoffset = '0';
    }));
  }

  addSvg(node, delay = 0) {
    this.svg.appendChild(node);
    this.animate(node, delay);
    return node;
  }

  addHtml(el, delay = 0) {
    el.classList.add('el');
    el.style.animationDelay = `${delay}ms`;
    applyBidi(el);   // before anyone measures it
    this.layer.appendChild(el);
    return el;
  }

  // Place an HTML element: x,y = top-left, or x = center with align:center.
  place(el, cmd, defaults = {}) {
    const size = cmd.size || defaults.size || 28;
    el.style.fontSize = `${size}px`;
    el.style.color = color(cmd.color || defaults.color);
    el.style.visibility = 'hidden';
    const x = cmd.x ?? 40;
    let y = cmd.y ?? this.cursorY;
    const align = cmd.align || defaults.align || 'left';
    const maxW = align === 'center' ? Math.min(x, W - x) * 2 - 20 : W - x - 20;
    el.style.maxWidth = `${Math.max(120, maxW)}px`;
    this.addHtml(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    if (!defaults.free) y = this.avoid({ x: left, y, w, h });
    el.style.left = `${left}px`;
    el.style.top = `${y}px`;
    el.style.visibility = '';
    return { x: left, y, w, h };
  }

  label(text, box, opts = {}) {
    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = opts.html ?? richText(text);
    let size = opts.size || Math.max(16, Math.min(34, box.h * 0.4));
    Object.assign(el.style, {
      left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`,
      fontSize: `${size}px`, color: color(opts.color || 'ink'),
    });
    this.addHtml(el, opts.delay || 0);
    // Shrink the label until it fits inside its box.
    while ((el.scrollHeight > box.h + 1 || el.scrollWidth > box.w + 1) && size > 12) {
      size = Math.floor(size * 0.88);
      el.style.fontSize = `${size}px`;
    }
    return el;
  }

  // Resolve an id or [x,y] to a geometry: {cx, cy, shape, bbox, r}.
  geom(ref) {
    if (Array.isArray(ref)) return { cx: ref[0], cy: ref[1], shape: 'point' };
    const rec = this.els.get(ref);
    if (!rec) return null;
    const b = rec.bbox;
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2, shape: rec.shape || 'rect', bbox: b, r: rec.r };
  }

  // Where the ray from g's center toward (tx,ty) leaves g's outline.
  edge(g, tx, ty, pad = 8) {
    const dx = tx - g.cx, dy = ty - g.cy;
    const len = Math.hypot(dx, dy) || 1;
    if (g.shape === 'point') return [g.cx + (dx / len) * 4, g.cy + (dy / len) * 4];
    if (g.shape === 'circle') return [g.cx + (dx / len) * (g.r + pad), g.cy + (dy / len) * (g.r + pad)];
    const hw = g.bbox.w / 2 + pad, hh = g.bbox.h / 2 + pad;
    const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return [g.cx + dx * t, g.cy + dy * t];
  }

  opts(cmd, extra = {}) {
    return { stroke: color(cmd.color), strokeWidth: 2.4, roughness: 1.1, bowing: 1.2, ...extra };
  }

  // ------------------------------------------------------------------ ops
  op_clear(cmd) {
    this.beforeClear?.(cmd);   // board_extras.js keeps a frozen copy for rewind
    for (const rec of this.els.values()) if (rec.anno) { try { rec.anno.remove(); } catch { /* gone */ } }
    for (const n of [...this.svg.childNodes, ...this.layer.childNodes, ...this.head.childNodes]) this.fadeOut(n);
    this.els.clear();
    this.seqs.clear();
    this.lists = new Map();
    this.plots = new Map();
    this.stepLists = new Map();
    this.clips = new Map();
    this.cursorEl = null;
    this.pointer = null;
    this.sceneQ = [];
    this.gen = (this.gen || 0) + 1;   // delayed scene pieces check this
    this.highlight = null;
    this.unveil();
    clearTimeout(this.fitTimer);
    this.zoom = null;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.applyView();
    this.top = cmd.title ? 85 : 20;
    this.cursorY = this.top;
    if (cmd.title != null) {
      this.onTitle(cmd.title);
      // The title lives ON the board, so a topic change is obvious at a glance.
      const el = document.createElement('div');
      el.className = 'heading';
      el.innerHTML = richText(cmd.title);
      this.place(el, { x: 500, y: 16, size: 34, align: 'center' }, { free: true });
      if (el.offsetWidth > 940) el.style.fontSize = `${Math.floor(34 * 940 / el.offsetWidth)}px`;
      el.style.left = `${500 - el.offsetWidth / 2}px`;
      this.head.appendChild(el);
    }
  }

  // Instant feedback when you ask something: dim the board and show your
  // question until the tutor's first drawing or sentence arrives.
  veil(text) {
    this.unveil();
    const v = document.createElement('div');
    v.className = 'veil';
    v.innerHTML = `<div class="veil-q">${escapeHtml(text)}</div><div class="veil-dots"><i></i><i></i><i></i></div>`;
    applyBidi(v.firstElementChild);
    this.root.appendChild(v);
    this.veilEl = v;
  }

  unveil() {
    if (!this.veilEl) return;
    const v = this.veilEl;
    this.veilEl = null;
    v.style.opacity = '0';
    setTimeout(() => v.remove(), 200);
  }

  op_text(cmd) {
    const el = document.createElement('div');
    el.className = 'text';
    el.innerHTML = richText(cmd.text);
    const bbox = this.place(el, cmd);
    if (cmd.type) {
      // Typewriter: a stepped wipe from the left, one step per character.
      const n = Math.max(4, String(cmd.text || '').length);
      el.style.clipPath = 'inset(0 100% 0 0)';
      requestAnimationFrame(() => {
        el.style.transition = `clip-path ${Math.min(4, n * 0.04)}s steps(${n})`;
        el.style.clipPath = 'inset(0 -2% 0 0)';
      });
    }
    this.register(cmd.id, { nodes: [el], bbox });
  }

  op_math(cmd) {
    const el = document.createElement('div');
    el.className = 'math';
    el.innerHTML = katex.renderToString(String(cmd.tex || ''), { throwOnError: false, displayMode: false });
    const bbox = this.place(el, cmd, { size: 36 });
    this.register(cmd.id, { nodes: [el], bbox });
  }

  op_code(cmd) {
    const el = document.createElement('pre');
    el.className = 'code';
    el.textContent = cmd.text || '';
    const bbox = this.place(el, cmd, { size: 22, color: 'green' });
    this.register(cmd.id, { nodes: [el], bbox });
  }

  op_table(cmd) {
    const el = document.createElement('table');
    el.className = 'table';
    (cmd.rows || []).forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.style.animationDelay = `${i * 120}ms`;
      for (const cell of row) {
        const td = document.createElement(i === 0 ? 'th' : 'td');
        td.innerHTML = richText(cell);
        tr.appendChild(td);
      }
      el.appendChild(tr);
    });
    const bbox = this.place(el, cmd, { size: 22 });
    this.register(cmd.id, { nodes: [el], bbox });
  }

  box(cmd, delay = 0) {
    const x = cmd.x ?? 40, w = cmd.w || 180, h = cmd.h || 80;
    const y = Math.max(cmd.y ?? this.cursorY, this.top);
    const fill = cmd.fill === false ? undefined : `${color(cmd.color)}26`;
    const g = this.addSvg(this.rc.rectangle(x, y, w, h, this.opts(cmd, { fill, fillStyle: 'solid' })), delay);
    const nodes = [g];
    if (cmd.label != null || cmd.labelHtml != null) {
      nodes.push(this.label(cmd.label, { x, y, w, h }, { size: cmd.size, delay: delay + 150, html: cmd.labelHtml }));
    }
    return this.register(cmd.id, { nodes, bbox: { x, y, w, h }, shape: 'rect' });
  }

  op_box(cmd) { this.box(cmd); }

  op_circle(cmd) {
    const r = cmd.r || 50, cx = cmd.x ?? 500;
    const cy = Math.max(cmd.y ?? 300, this.top + r);
    const fill = cmd.fill === false ? undefined : `${color(cmd.color)}26`;
    const g = this.addSvg(this.rc.circle(cx, cy, r * 2, this.opts(cmd, { fill, fillStyle: 'solid' })));
    const bbox = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    const nodes = [g];
    if (cmd.label != null) nodes.push(this.label(cmd.label, bbox, { size: cmd.size || Math.min(30, r * 0.5), delay: 150 }));
    this.register(cmd.id, { nodes, bbox, shape: 'circle', r });
  }

  arrowBetween(a, b, cmd, delay = 0) {
    const [x1, y1] = this.edge(a, b.cx, b.cy);
    const [x2, y2] = this.edge(b, a.cx, a.cy);
    const g = document.createElementNS(SVGNS, 'g');
    const o = this.opts(cmd, { roughness: 0.7, bowing: 0.6 });
    g.appendChild(this.rc.line(x1, y1, x2, y2, o));
    const ang = Math.atan2(y2 - y1, x2 - x1), L = 16;
    for (const s of [-1, 1]) {
      const a2 = ang + Math.PI - s * 0.45;
      g.appendChild(this.rc.line(x2, y2, x2 + L * Math.cos(a2), y2 + L * Math.sin(a2), o));
    }
    if (cmd.animate) {
      // Something travels along the arrow: once (a message) or forever (a flow).
      const once = cmd.animate === 'once';
      const route = document.createElementNS(SVGNS, 'path');
      route.id = `mp${++this.auto}`;
      route.setAttribute('d', `M${x1} ${y1} L${x2} ${y2}`);
      route.setAttribute('fill', 'none'); route.setAttribute('stroke', 'none');
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('r', '7'); dot.setAttribute('fill', color(cmd.color));
      dot.dataset.static = '1';
      const am = document.createElementNS(SVGNS, 'animateMotion');
      am.setAttribute('dur', once ? '0.9s' : '1.8s');
      am.setAttribute('repeatCount', once ? '1' : 'indefinite');
      am.setAttribute('fill', 'freeze');
      am.setAttribute('begin', `${(delay + 350) / 1000}s`);
      const mp = document.createElementNS(SVGNS, 'mpath');
      mp.setAttribute('href', `#${route.id}`);
      am.appendChild(mp); dot.appendChild(am);
      g.append(route, dot);
      if (once) setTimeout(() => dot.remove(), delay + 1600);
    }
    this.addSvg(g, delay);
    const nodes = [g];
    let bbox = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (cmd.label) {
      const el = document.createElement('div');
      el.className = 'pill';
      el.innerHTML = richText(cmd.label);
      el.style.fontSize = `${cmd.size || 20}px`;
      el.style.color = color(cmd.color);
      el.style.visibility = 'hidden';
      this.addHtml(el, delay + 200);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const horizontal = Math.abs(x2 - x1) >= Math.abs(y2 - y1);
      // Left-to-right labels sit above the arrow, right-to-left below (and
      // down/up arrows right/left), so a pair of opposite arrows never collides.
      const lx = horizontal ? mx - el.offsetWidth / 2 : (y2 >= y1 ? mx + 12 : mx - el.offsetWidth - 12);
      const ly = horizontal ? (x2 >= x1 ? my - el.offsetHeight - 6 : my + 6) : my - el.offsetHeight / 2;
      el.style.left = `${lx}px`; el.style.top = `${ly}px`; el.style.visibility = '';
      nodes.push(el);
      bbox = { x: Math.min(bbox.x, lx), y: Math.min(bbox.y, ly), w: bbox.w, h: bbox.h };
    }
    return this.register(cmd.id, { nodes, bbox, shape: 'rect', solid: false });
  }

  op_arrow(cmd) {
    const a = this.geom(cmd.from), b = this.geom(cmd.to);
    if (!a || !b) { console.warn('arrow endpoint missing', cmd); return; }
    this.arrowBetween(a, b, cmd);
  }

  op_line(cmd) {
    const pts = cmd.points || [];
    if (pts.length < 2) return;
    const o = this.opts(cmd, { roughness: 0.8 });
    if (cmd.dashed) o.strokeLineDash = [10, 8];
    const g = this.rc.linearPath(pts, o);
    if (cmd.dashed) g.querySelectorAll('path').forEach((p) => { p.dataset.static = '1'; });
    this.addSvg(g);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    this.register(cmd.id, { nodes: [g], bbox, solid: false });
  }

  // ------------------------------------------------- pointing / focus
  // {"op":"highlight","target":"tb1","row":3,"color":"red"}
  op_highlight(cmd) {
    const t = this.targetBox(cmd);
    if (!t) return;
    if (this.highlight) this.fadeOut(this.highlight.node);
    const b = t.bbox;
    const o = { stroke: color(cmd.color || 'red'), strokeWidth: 3.2, roughness: 1.4 };
    const node = this.addSvg(b.w / Math.max(b.h, 1) > 4 || t.row != null
      ? this.rc.rectangle(b.x - 12, b.y - 6, b.w + 24, b.h + 12, o)
      : this.rc.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w + 44, b.h + 34, o));
    this.highlight = { target: t.id, node };
    const pulse = t.row != null ? [t.rec.nodes[0].rows[t.row]] : t.rec.nodes;
    for (const n of pulse) {
      n.classList.remove('pulse'); void n.getBoundingClientRect(); n.classList.add('pulse');
    }
  }

  // {"op":"focus","target":"tb1","row":3}  or  {"op":"focus","targets":["o2","o3"]}
  // Dims everything else so one thing is unmistakable. {"op":"unfocus"} restores.
  op_focus(cmd) {
    const list = [].concat(cmd.targets ?? cmd.target ?? []);
    const hits = list.map((t) => this.targetBox(typeof t === 'string'
      ? { target: t, row: list.length === 1 ? cmd.row : undefined } : t)).filter(Boolean);
    if (!hits.length) return;
    const keep = new Map();   // id -> Set of rows, or null for the whole element
    for (const h of hits) {
      if (h.row == null) keep.set(h.id, null);
      else if (keep.get(h.id) !== null) keep.set(h.id, (keep.get(h.id) || new Set()).add(h.row));
    }
    for (const [id, rec] of this.els) {
      if (id === this.highlight?.target && rec.nodes.length === 0) continue;
      rec.nodes.forEach((n) => n.classList.toggle('dimmed', !keep.has(id)));
      const rows = keep.get(id), table = rec.nodes[0];
      if (rows && table?.rows) [...table.rows].forEach((tr, i) => tr.classList.toggle('dimmed', i > 0 && !rows.has(i)));
    }
    this.op_highlight({ target: hits[0].id, row: hits[0].row, color: cmd.color });
  }

  op_unfocus() {
    for (const rec of this.els.values()) {
      rec.nodes.forEach((n) => n.classList.remove('dimmed'));
      const table = rec.nodes[0];
      if (table?.rows) [...table.rows].forEach((tr) => tr.classList.remove('dimmed'));
    }
    if (this.highlight) { this.fadeOut(this.highlight.node); this.highlight = null; }
  }

  // {"op":"callout","id":"c1","target":"ips","row":2,"text":"this one hit the firewall","color":"red"}
  // A short note pinned beside the target with an arrow to it.
  op_callout(cmd) {
    const t = this.targetBox(cmd);
    if (!t) return;
    const c = color(cmd.color || 'amber');
    const el = document.createElement('div');
    el.className = 'callout';
    el.innerHTML = richText(cmd.text || '');
    el.style.fontSize = `${cmd.size || 22}px`;
    el.style.color = c;
    el.style.visibility = 'hidden';
    this.addHtml(el);
    const w = el.offsetWidth, h = el.offsetHeight, b = t.bbox;
    let x, y;
    if (b.x + b.w + 48 + w <= W - 20) { x = b.x + b.w + 48; y = b.y + b.h / 2 - h / 2; }
    else if (b.x - 48 - w >= 20) { x = b.x - 48 - w; y = b.y + b.h / 2 - h / 2; }
    else { x = Math.min(Math.max(20, b.x + b.w / 2 - w / 2), W - 20 - w); y = b.y + b.h + 40; }
    y = Math.min(Math.max(y, this.top), H - h - 10);
    el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.visibility = '';
    const note = { cx: x + w / 2, cy: y + h / 2, shape: 'rect', bbox: { x, y, w, h } };
    const tgt = { cx: b.x + b.w / 2, cy: b.y + b.h / 2, shape: 'rect', bbox: b };
    this.arrowBetween(note, tgt, { id: `${cmd.id || 'co'}_arrow`, color: cmd.color || 'amber' });
    this.register(cmd.id, { nodes: [el], bbox: { x, y, w, h } });
    const pulse = t.row != null ? [t.rec.nodes[0].rows[t.row]] : t.rec.nodes;
    for (const n of pulse) { n.classList.remove('pulse'); void n.getBoundingClientRect(); n.classList.add('pulse'); }
  }

  // {"op":"zoom","target":"tb1","row":3}  or  {"op":"zoom","x":100,"y":300,"w":400,"h":150}
  // Blows that part up to fill the board. {"op":"unzoom"} goes back.
  op_zoom(cmd) {
    let r;
    if (cmd.target) { const t = this.targetBox(cmd); if (!t) return; r = t.bbox; }
    else if (cmd.x != null && cmd.w) r = { x: cmd.x, y: cmd.y ?? this.top, w: cmd.w, h: cmd.h || 200 };
    else return;
    const pad = 30;
    r = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    const availW = W - 40, availH = H - this.top - 20;
    const s = Math.min(cmd.max || 3, availW / r.w, availH / r.h);
    this.zoom = { s, tx: 20 + (availW - r.w * s) / 2 - r.x * s, ty: this.top + (availH - r.h * s) / 2 - r.y * s };
    clearTimeout(this.fitTimer);
    this.applyView();
    if (cmd.target) this.op_highlight({ target: cmd.target, row: cmd.row, color: cmd.color || 'amber' });
  }

  op_unzoom() {
    this.zoom = null;
    this.applyView();
    this.fitContent();
  }

  op_erase(cmd) { this.remove(cmd.target || cmd.id); }

  op_plot(cmd) {
    const w = cmd.w || 420, h = cmd.h || 320;
    const x0 = cmd.x ?? 540;
    const y0 = this.avoid({ x: x0, y: Math.max(cmd.y ?? this.top + 10, this.top + 10), w, h });
    const xmin = cmd.xmin ?? -5, xmax = cmd.xmax ?? 5;
    const fns = (Array.isArray(cmd.fn) ? cmd.fn : [cmd.fn]).filter(Boolean);
    let ymin = cmd.ymin, ymax = cmd.ymax;
    if (ymin == null || ymax == null) {
      // Auto-range from the curves, ignoring wild outliers.
      const ys = [];
      for (const src of fns) {
        try {
          const f = compileExpr(src);
          for (let i = 0; i <= 120; i++) ys.push(f(xmin + (i / 120) * (xmax - xmin)));
        } catch { /* rejected below */ }
      }
      const fin = ys.filter(Number.isFinite).sort((a, b) => a - b);
      const lo = fin[Math.floor(fin.length * 0.02)] ?? -1, hi = fin[Math.ceil(fin.length * 0.98) - 1] ?? 1;
      const pad = (hi - lo || 1) * 0.1;
      ymin = ymin ?? lo - pad; ymax = ymax ?? hi + pad;
    }
    const sx = (x) => x0 + ((x - xmin) / (xmax - xmin)) * w;
    const sy = (y) => y0 + h - ((y - ymin) / (ymax - ymin)) * h;
    const nodes = [];
    const axes = document.createElementNS(SVGNS, 'g');
    const ax = { stroke: COLORS.muted, strokeWidth: 1.8, roughness: 0.5 };
    const yAxisX = xmin <= 0 && xmax >= 0 ? sx(0) : x0;
    const xAxisY = ymin <= 0 && ymax >= 0 ? sy(0) : y0 + h;
    axes.appendChild(this.rc.line(x0, xAxisY, x0 + w, xAxisY, ax));
    axes.appendChild(this.rc.line(yAxisX, y0, yAxisX, y0 + h, ax));
    nodes.push(this.addSvg(axes));
    const tick = (text, x, y, align) => {
      const el = document.createElement('div');
      el.className = 'tick';
      el.textContent = text;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      if (align === 'right') el.style.transform = 'translateX(-100%)';
      nodes.push(this.addHtml(el, 200));
    };
    const fmt = (v) => String(+v.toFixed(2));
    tick(fmt(xmin), x0, xAxisY + 6, 'left');
    tick(fmt(xmax), x0 + w, xAxisY + 6, 'right');
    tick(fmt(ymax), yAxisX - 6, y0 - 4, 'right');
    tick(fmt(ymin), yAxisX - 6, y0 + h - 18, 'right');
    const rec = this.register(cmd.id, { nodes, bbox: { x: x0, y: y0, w, h } });
    const clipId = `plotclip${++this.auto}`;
    const clip = document.createElementNS(SVGNS, 'clipPath');
    clip.id = clipId;
    const clipRect = document.createElementNS(SVGNS, 'rect');
    for (const [k, v] of Object.entries({ x: x0 - 4, y: y0 - 4, width: w + 8, height: h + 8 })) clipRect.setAttribute(k, v);
    clip.appendChild(clipRect);
    this.svg.appendChild(clip);
    nodes.push(clip);
    const plot = { rec, sx, sy, xmin, xmax, ymin, ymax, x0, y0, w, h, count: 0, clipId };
    this.plots = this.plots || new Map();
    this.plots.set(rec.id, plot);
    fns.forEach((src, i) => nodes.push(...this.plotCurve(plot, src, cmd.colors?.[i])));
    this.plotExtras(plot, { shade: cmd.shade, points: cmd.points, color: cmd.pointColor });
  }

  // --------------------------------------------------------- templates
  // {"op":"row","id":"oct","items":["192","168","1","10"],"y":120,"h":90}
  // -> boxes oct1..octN spread evenly across the board.
  op_row(cmd) {
    const items = cmd.items || [];
    const n = items.length || 1, gap = cmd.gap ?? 24;
    const x = cmd.x ?? 40, totalW = cmd.w ?? (W - 2 * x), h = cmd.h || 90;
    const y = this.avoid({ x, y: cmd.y ?? this.cursorY, w: totalW, h });
    const bw = (totalW - gap * (n - 1)) / n;
    items.forEach((item, i) => this.box({
      id: `${cmd.id || 'row'}${i + 1}`, x: x + i * (bw + gap), y, w: bw, h,
      label: item, color: cmd.colors?.[i] || cmd.color || 'blue', size: cmd.size,
    }, i * 160));
  }

  // {"op":"stack","id":"osi","items":["Application","Transport","Network","Link"],"x":300,"w":400}
  // -> boxes osi1..osiN stacked top to bottom.
  op_stack(cmd) {
    const items = cmd.items || [];
    const n = items.length || 1, gap = cmd.gap ?? 10;
    const w = cmd.w || 640, x = cmd.x ?? (W - w) / 2;
    const rowH = (yy) => Math.max(40, Math.min(80, ((cmd.h ?? (588 - yy)) - gap * (n - 1)) / n));
    let y = Math.max(cmd.y ?? this.cursorY, this.top);
    y = this.avoid({ x, y, w, h: n * rowH(y) + gap * (n - 1) });
    const bh = rowH(y);   // if it still doesn't fit, fitContent scales it down
    items.forEach((item, i) => this.box({
      id: `${cmd.id || 'stack'}${i + 1}`, x, y: y + i * (bh + gap), w, h: bh,
      label: item, color: cmd.colors?.[i] || cmd.color || 'purple', size: cmd.size,
    }, i * 140));
  }

  // {"op":"bullets","id":"b","items":["...","..."],"y":100} reveals points one
  // after another; {"op":"bullet","list":"b","text":"..."} appends the next
  // point, so the model can sync each one with a sentence.
  op_bullets(cmd) {
    const id = cmd.id || 'list';
    const list = {
      x: cmd.x ?? 50, y: cmd.y ?? this.cursorY, size: cmd.size || 28,
      color: cmd.color || 'ink', n: 0, nextY: cmd.y ?? this.cursorY, id,
    };
    this.lists = this.lists || new Map();
    this.lists.set(id, list);
    (cmd.items || []).forEach((t, i) => this.addBullet(list, t, i * 380));
  }

  op_bullet(cmd) {
    this.lists = this.lists || new Map();
    let list = this.lists.get(cmd.list) || [...this.lists.values()].pop();
    if (!list) { this.op_bullets({ id: cmd.list || 'list', items: [] }); list = this.lists.get(cmd.list || 'list'); }
    this.addBullet(list, cmd.text, 0, cmd.color);
  }

  addBullet(list, text, delay, colorName) {
    const el = document.createElement('div');
    el.className = 'bullet';
    el.innerHTML = `<span class="dot-b" style="background:${color(colorName || 'amber')}"></span><span>${richText(text)}</span>`;
    el.style.animationDelay = `${delay}ms`;
    const bbox = this.place(el, { x: list.x, y: list.nextY, size: list.size, color: colorName || list.color });
    el.style.animationDelay = `${delay}ms`;
    if (el.dir === 'rtl') {
      // Right-to-left points share a right edge, so their bullets line up.
      list.right = Math.max(list.right || 0, bbox.x + bbox.w);
      for (let i = 1; i <= list.n + 1; i++) {
        const r = i <= list.n ? this.els.get(`${list.id}${i}`) : { bbox, nodes: [el] };
        if (!r || r.nodes[0].dir !== 'rtl') continue;
        r.bbox.x = list.right - r.bbox.w;
        r.nodes[0].style.left = `${r.bbox.x}px`;
      }
    }
    list.n += 1;
    list.nextY = bbox.y + bbox.h + Math.round(list.size * 0.45);
    this.register(`${list.id}${list.n}`, { nodes: [el], bbox });
  }

  // {"op":"flow","id":"f","items":["Browser","DNS","Server"],"labels":["query","IP"],"y":150}
  op_flow(cmd) {
    const items = cmd.items || [];
    const n = items.length || 1, gap = cmd.gap ?? Math.max(60, 200 - n * 25);
    const x = cmd.x ?? 40, totalW = cmd.w ?? (W - 2 * x), h = cmd.h || 90;
    const y = this.avoid({ x, y: cmd.y ?? this.cursorY, w: totalW, h: h + 40 });
    const bw = (totalW - gap * (n - 1)) / n;
    const id = cmd.id || 'flow';
    items.forEach((item, i) => {
      this.box({ id: `${id}${i + 1}`, x: x + i * (bw + gap), y, w: bw, h, label: item,
        color: cmd.colors?.[i] || cmd.color || 'blue', size: cmd.size }, i * 450);
      if (i > 0) {
        const a = this.geom(`${id}${i}`), b = this.geom(`${id}${i + 1}`);
        this.arrowBetween(a, b, { id: `${id}a${i}`, label: cmd.labels?.[i - 1], color: 'amber', animate: cmd.animate }, i * 450 - 200);
      }
    });
  }

  // {"op":"compare","id":"c","left":"TCP","right":"UDP","rows":[["Reliable","Best effort"]]}
  op_compare(cmd) {
    const el = document.createElement('table');
    el.className = 'table compare';
    const head = document.createElement('tr');
    head.innerHTML = `<th style="color:${color(cmd.leftColor || 'blue')}">${richText(cmd.left || '')}</th>` +
      `<th style="color:${color(cmd.rightColor || 'amber')}">${richText(cmd.right || '')}</th>`;
    el.appendChild(head);
    (cmd.rows || []).forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.style.animationDelay = `${(i + 1) * 300}ms`;
      tr.innerHTML = `<td>${richText(row[0] ?? '')}</td><td>${richText(row[1] ?? '')}</td>`;
      el.appendChild(tr);
    });
    el.style.width = `${cmd.w || 860}px`;
    const bbox = this.place(el, { x: cmd.x ?? 70, y: cmd.y ?? this.cursorY, size: cmd.size || 26 });
    this.register(cmd.id, { nodes: [el], bbox });
  }

  // {"op":"packet","id":"p","fields":[["Src port",16],["Dst port",16],["Seq",32]],"y":100}
  // Protocol header layout: 32 bits per row, field widths in bits.
  op_packet(cmd) {
    const x = cmd.x ?? 40, totalW = cmd.w ?? (W - 2 * x), rowH = cmd.h || 64;
    const totalBits = (cmd.fields || []).reduce((s, f) => s + Math.max(1, Math.min(32, Number(f[1]) || 8)), 0);
    let y = this.avoid({ x, y: cmd.y ?? this.cursorY, w: totalW, h: Math.ceil(totalBits / 32) * rowH });
    let bit = 0, i = 0;
    const id = cmd.id || 'pkt';
    const palette = ['blue', 'purple', 'green', 'amber', 'red'];
    for (const [name, bitsRaw] of cmd.fields || []) {
      let bits = Math.max(1, Math.min(32, Number(bitsRaw) || 8));
      while (bits > 0) {
        const take = Math.min(bits, 32 - bit);
        const labelHtml = take === bits || bit === 0
          ? (take >= 6 ? `${richText(name)}<small>${bitsRaw}b</small>` : richText(name)) : '';
        this.box({ id: `${id}${++i}`, x: x + (bit / 32) * totalW, y, w: (take / 32) * totalW, h: rowH,
          labelHtml, color: palette[(i - 1) % palette.length], size: cmd.size || (take <= 4 ? 14 : 20) }, i * 160);
        bit += take; bits -= take;
        if (bit === 32) { bit = 0; y += rowH; }
      }
    }
  }

  // ------------------------------------------------------ free drawing
  // {"op":"svg","id":"s","x":100,"y":100,"w":400,"h":300,"viewBox":"0 0 400 300","content":"<path d='...'/>..."}
  // Anything the templates can't express: curves, scenes, icons, geometry.
  op_svg(cmd) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'free');
    g.appendChild(sanitizeSvg(cmd.content || cmd.svg || ''));
    if (cmd.viewBox || cmd.x != null || cmd.y != null) {
      // A self-contained picture: fit its viewBox into x,y,w,h.
      const vb = String(cmd.viewBox || `0 0 ${cmd.w || 400} ${cmd.h || 300}`).split(/[\s,]+/).map(Number);
      const w = cmd.w || vb[2], h = cmd.h || vb[3];
      const s = Math.min(w / vb[2], h / vb[3]);
      const x = cmd.x ?? (W - vb[2] * s) / 2;
      const y = Math.max(cmd.y ?? this.cursorY, this.top);
      g.setAttribute('transform', `translate(${x - vb[0] * s},${y - vb[1] * s}) scale(${s})`);
      this.addSvg(g);
      this.register(cmd.id, { nodes: [g], bbox: { x, y, w: vb[2] * s, h: vb[3] * s } });
      return;
    }
    // Board coordinates: pieces of one picture can arrive across several
    // commands and line up exactly. Never pushed around by the layout rules,
    // and never an obstacle to text (solid: false): lines and shapes are
    // drawn around and over, like on a real whiteboard.
    if (this.inScene && this.sceneRect) g.setAttribute('clip-path', this.rectClip(this.sceneRect));
    this.addSvg(g);
    const b = g.getBBox();
    this.register(cmd.id, { nodes: [g], bbox: { x: b.x, y: b.y, w: b.width, h: b.height }, solid: false });
  }

  // A clip for one rectangle, created once per board.
  rectClip(r) {
    this.clips = this.clips || new Map();
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (!this.clips.has(key)) {
      const id = `clip${++this.auto}`;
      const cp = document.createElementNS(SVGNS, 'clipPath');
      cp.id = id;
      const rect = document.createElementNS(SVGNS, 'rect');
      for (const [k, v] of Object.entries({ x: r.x - 2, y: r.y - 2, width: r.w + 4, height: r.h + 4 })) rect.setAttribute(k, v);
      cp.appendChild(rect);
      this.svg.appendChild(cp);
      this.clips.set(key, id);
    }
    return `url(#${this.clips.get(key)})`;
  }

  // A scene supersedes whatever was under its rectangle: elements mostly
  // covered by it fade out, so two drawings never stack on top of each other.
  makeRoom(rect, keepId) {
    for (const [id, rec] of [...this.els]) {
      if (id === keepId || rec.solid === false) continue;
      const b = rec.bbox;
      const ix = Math.max(0, Math.min(b.x + b.w, rect.x + rect.w) - Math.max(b.x, rect.x));
      const iy = Math.max(0, Math.min(b.y + b.h, rect.y + rect.h) - Math.max(b.y, rect.y));
      if (ix * iy > 0.3 * Math.max(1, b.w * b.h)) this.remove(id);
    }
  }

  // {"op":"html","id":"t","x":520,"y":100,"w":440,"content":"<div class='term'>...</div>"}
  // Realistic mockups: what a tool, terminal, app or document actually looks like.
  op_html(cmd) {
    const el = document.createElement('div');
    el.className = 'mock';
    el.innerHTML = sanitizeHtml(String(cmd.content || cmd.html || ''));
    el.style.width = `${Math.min(cmd.w || 460, 960)}px`;
    const bbox = this.place(el, { x: cmd.x ?? 40, y: cmd.y, size: cmd.size || 18, align: cmd.align }, { color: 'ink' });
    this.register(cmd.id, { nodes: [el], bbox });
  }

  // {"op":"scene","id":"s1","x":40,"y":95,"w":920,"h":400,"pending":true,"caption":"..."} then,
  // when the background illustrator is done, the same id with "ops":[...].
  // Pieces carry "at" (ms) so the scene builds up like an animation.
  op_scene(cmd) {
    const prev = this.els.get(cmd.id);
    if (cmd.append && !prev) return;   // its board is gone
    const bbox = prev && cmd.append ? prev.bbox : {
      x: cmd.x ?? 40, y: Math.max(cmd.y ?? this.cursorY, this.top), w: cmd.w || 920, h: cmd.h || 460,
    };
    const placeholder = (text, pending) => {
      const fig = document.createElement('figure');
      fig.className = 'media scene';
      Object.assign(fig.style, { left: `${bbox.x}px`, top: `${bbox.y}px`, width: `${bbox.w}px`, height: `${bbox.h}px` });
      fig.innerHTML = pending
        ? `<div class="shimmer"></div><figcaption class="sketching">sketching: ${escapeHtml(text)}</figcaption>`
        : `<div class="nomedia">${escapeHtml(text)}</div>`;
      this.addHtml(fig);
      this.register(cmd.id, { nodes: [fig], bbox, pending });
    };
    if (cmd.failed) {
      if (!prev || prev.pending) placeholder(cmd.brief || '', false);
      return;
    }
    if (!prev) this.makeRoom(bbox, cmd.id);
    if (!cmd.ops?.length) { placeholder(cmd.caption || '', true); return; }
    // Pieces: drop the placeholder (once), keep the area reserved, draw them.
    if (!prev || prev.pending || !cmd.append) this.register(cmd.id, { nodes: [], bbox });
    // Pieces go on at a steady pace (one every ~0.7 s), never in a burst,
    // so the eye can follow the scene being built.
    const gen = this.gen;
    for (const op of cmd.ops) this.sceneQ.push({ op, gen, rect: bbox });
    if (!this.sceneTimer) this.drainScene();
  }

  drainScene() {
    const next = this.sceneQ.shift();
    if (!next) { this.sceneTimer = null; return; }
    if (next.gen === this.gen) {   // the board hasn't moved on
      const at = Math.max(0, Math.min(Number(next.op.at) || 0, 3000));
      const run = () => {
        if (next.gen !== this.gen) return;
        this.inScene = true;
        this.sceneRect = next.rect;
        try { this.apply(next.op); } finally { this.inScene = false; this.sceneRect = null; }
      };
      if (at) setTimeout(run, at); else run();
    }
    this.sceneTimer = setTimeout(() => this.drainScene(), next.gen === this.gen ? 700 : 0);
  }

  // {"op":"image","id":"ws","query":"Wireshark screenshot","x":40,"y":100,"w":520,"h":340,"caption":"Wireshark"}
  // The engine searches and downloads it; until then a placeholder holds the spot.
  op_image(cmd) { this.media(cmd, false); }

  // {"op":"icon","id":"i","name":"wireshark","x":100,"y":120,"size":72,"label":"Wireshark"}
  op_icon(cmd) { this.media(cmd, true); }

  media(cmd, icon) {
    const prev = this.els.get(cmd.id);
    if (cmd.update && !(prev && prev.pending)) return;  // its board is gone
    let bbox;
    if (cmd.update) {
      bbox = prev.bbox;
    } else {
      const w = icon ? (cmd.size || 72) : (cmd.w || 460);
      const h = icon ? w + (cmd.label ? 34 : 0) : (cmd.h || 300);
      const x = cmd.x ?? (W - w) / 2;
      bbox = { x, y: this.avoid({ x, y: cmd.y ?? this.cursorY, w, h }), w, h };
    }
    const fig = document.createElement('figure');
    fig.className = `media${icon ? ' icon' : ''}`;
    Object.assign(fig.style, { left: `${bbox.x}px`, top: `${bbox.y}px`, width: `${bbox.w}px`, height: `${bbox.h}px` });
    const caption = cmd.caption || cmd.label || '';
    const src = /^(\.\.\/cache\/|data:image\/)/.test(cmd.src || '') ? cmd.src : '';
    if (cmd.pending) {
      fig.innerHTML = `<div class="shimmer"></div>${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}`;
    } else if (!src) {
      fig.innerHTML = `<div class="nomedia">${escapeHtml(caption || cmd.query || cmd.name || '')}</div>`;
    } else {
      fig.innerHTML = `<img src="${src}" alt="">${caption ? `<figcaption>${richText(caption)}</figcaption>` : ''}`;
    }
    this.addHtml(fig);
    this.register(cmd.id, { nodes: [fig], bbox, pending: !!cmd.pending });
  }

  // {"op":"path","d":"M 100 300 C 250 100 400 500 550 300","color":"blue","fill":false}
  op_path(cmd) {
    const fill = cmd.fill ? `${color(cmd.color)}33` : undefined;
    const g = this.addSvg(this.rc.path(String(cmd.d || ''), this.opts(cmd, { fill, fillStyle: 'solid', roughness: cmd.rough === false ? 0 : 0.8 })));
    const b = g.getBBox();
    this.register(cmd.id, { nodes: [g], bbox: { x: b.x, y: b.y, w: b.width, h: b.height }, solid: !!cmd.fill });
  }

  // {"op":"polygon","id":"tri","points":[[300,450],[600,450],[450,200]],"label":"A","color":"green"}
  op_polygon(cmd) {
    const pts = cmd.points || [];
    if (pts.length < 3) return;
    const fill = cmd.fill === false ? undefined : `${color(cmd.color)}26`;
    const g = this.addSvg(this.rc.polygon(pts, this.opts(cmd, { fill, fillStyle: 'solid' })));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const nodes = [g];
    if (cmd.label != null) {
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      nodes.push(this.label(cmd.label, { x: cx - 80, y: cy - 25, w: 160, h: 50 }, { size: cmd.size || 26, delay: 200 }));
    }
    this.register(cmd.id, { nodes, bbox });
  }

  // {"op":"steps","id":"e","lines":["2x+3=7","2x=4"]} then {"op":"step","list":"e","tex":"x=2","note":"divide by 2"}
  // A derivation, one line at a time; earlier lines dim so the newest stands out.
  op_steps(cmd) {
    const id = cmd.id || 'steps';
    const list = { id, x: cmd.x ?? 500, align: cmd.align || 'center', size: cmd.size || 34, nextY: cmd.y ?? this.cursorY, n: 0 };
    this.stepLists = this.stepLists || new Map();
    this.stepLists.set(id, list);
    (cmd.lines || []).forEach((t, i) => this.addStep(list, t, cmd.notes?.[i], i * 500));
  }

  op_step(cmd) {
    this.stepLists = this.stepLists || new Map();
    let list = this.stepLists.get(cmd.list) || [...this.stepLists.values()].pop();
    if (!list) { this.op_steps({ id: cmd.list || 'steps', lines: [] }); list = this.stepLists.get(cmd.list || 'steps'); }
    this.addStep(list, cmd.tex ?? cmd.text ?? '', cmd.note, 0, cmd.color);
  }

  addStep(list, tex, note, delay, colorName) {
    for (let i = 1; i <= list.n; i++) {
      const prev = this.els.get(`${list.id}${i}`);
      if (prev) prev.nodes.forEach((n) => { n.style.opacity = '0.6'; });
    }
    const el = document.createElement('div');
    el.className = 'math step';
    el.innerHTML = katex.renderToString(String(tex), { throwOnError: false }) +
      (note ? `<span class="note">${richText(note)}</span>` : '');
    el.style.animationDelay = `${delay}ms`;
    const bbox = this.place(el, { x: list.x, y: list.nextY, size: list.size, align: list.align, color: colorName });
    list.n += 1;
    list.nextY = bbox.y + bbox.h + 10;
    this.register(`${list.id}${list.n}`, { nodes: [el], bbox });
  }

  // {"op":"plotadd","plot":"p1","fn":"2*x-1","points":[[1,1,"P"]],"shade":{"fn":"x^2","from":0,"to":2}}
  // Builds an existing plot up frame by frame.
  op_plotadd(cmd) {
    this.plots = this.plots || new Map();
    const plot = this.plots.get(cmd.plot) || [...this.plots.values()].pop();
    if (!plot) return;
    this.plotExtras(plot, cmd);
  }

  plotExtras(plot, cmd) {
    const { sx, sy, xmin, xmax, ymin, ymax } = plot;
    const nodes = [];
    for (const sh of [].concat(cmd.shade || [])) {
      try {
        const f = compileExpr(sh.fn), a = sh.from ?? xmin, b = sh.to ?? xmax;
        const base = Math.max(ymin, Math.min(ymax, 0));
        let d = `M${sx(a)},${sy(base)}`;
        for (let i = 0; i <= 80; i++) {
          const x = a + (i / 80) * (b - a);
          d += `L${sx(x)},${sy(Math.max(ymin, Math.min(ymax, f(x))))}`;
        }
        d += `L${sx(b)},${sy(base)}Z`;
        const p = document.createElementNS(SVGNS, 'path');
        p.setAttribute('d', d);
        p.setAttribute('fill', `${color(sh.color || 'amber')}40`);
        p.setAttribute('stroke', 'none');
        const g = document.createElementNS(SVGNS, 'g');
        g.appendChild(p);
        g.setAttribute('clip-path', `url(#${plot.clipId})`);
        nodes.push(this.addSvg(g));
      } catch (e) { console.warn('shade rejected', sh, e.message); }
    }
    for (const src of [].concat(cmd.fn || [])) nodes.push(...this.plotCurve(plot, src, cmd.color));
    for (const pt of cmd.points || []) {
      const [x, y, lab] = pt;
      const c = this.addSvg(this.rc.circle(sx(x), sy(y), 14, { stroke: color(cmd.color || 'red'), fill: color(cmd.color || 'red'), fillStyle: 'solid', roughness: 0.3 }), 150);
      nodes.push(c);
      if (lab) {
        const el = document.createElement('div');
        el.className = 'tick fn';
        el.innerHTML = richText(lab);
        el.style.left = `${sx(x) + 10}px`;
        el.style.top = `${sy(y) - 30}px`;
        el.style.color = color(cmd.color || 'red');
        nodes.push(this.addHtml(el, 250));
      }
    }
    plot.rec.nodes.push(...nodes);
  }

  plotCurve(plot, src, colorName) {
    const { sx, sy, xmin, xmax, ymin, ymax, x0, y0, w, h } = plot;
    let f;
    try { f = compileExpr(src); } catch (e) { console.warn('plot fn rejected', src, e.message); return []; }
    const N = 240;
    let d = '', pen = false;
    for (let i = 0; i <= N; i++) {
      const x = xmin + (i / N) * (xmax - xmin), y = f(x);
      const ok = Number.isFinite(y) && y > ymin - 4 * (ymax - ymin) && y < ymax + 4 * (ymax - ymin);
      if (!ok) { pen = false; continue; }
      const py = sy(y);
      d += `${pen ? 'L' : 'M'}${sx(x).toFixed(1)},${py.toFixed(1)}`;
      pen = true;
    }
    const slot = plot.count++;
    const c = color(colorName || ['blue', 'amber', 'green', 'purple', 'red'][slot % 5]);
    const g = document.createElementNS(SVGNS, 'g');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', c);
    path.setAttribute('stroke-width', '3');
    path.setAttribute('stroke-linecap', 'round');
    g.appendChild(path);
    g.setAttribute('clip-path', `url(#${plot.clipId})`);
    const el = document.createElement('div');
    el.className = 'tick fn';
    el.innerHTML = richText(`$${String(src).replace(/\*/g, '\\cdot ')}$`);
    el.style.color = c;
    el.style.left = `${x0 + w + 8}px`;
    el.style.top = `${y0 + slot * 28}px`;
    return [this.addSvg(g, 150), this.addHtml(el, 400)];
  }

  // {"op":"numberline","min":-5,"max":5,"points":[{"x":2,"label":"a"}],"intervals":[{"from":-1,"to":3,"openFrom":true}]}
  op_numberline(cmd) {
    const min = cmd.min ?? -5, max = cmd.max ?? 5;
    const x0 = cmd.x ?? 80, w = cmd.w ?? 840;
    const y = this.avoid({ x: x0, y: cmd.y ?? this.cursorY, w, h: 90 }) + 40;
    const sx = (v) => x0 + ((v - min) / (max - min)) * w;
    const g = document.createElementNS(SVGNS, 'g');
    const o = { stroke: COLORS.ink, strokeWidth: 2.4, roughness: 0.5 };
    g.appendChild(this.rc.line(x0 - 20, y, x0 + w + 20, y, o));
    for (const s of [-1, 1]) {
      const ex = s < 0 ? x0 - 20 : x0 + w + 20;
      g.appendChild(this.rc.line(ex, y, ex - s * 14, y - 8, o));
      g.appendChild(this.rc.line(ex, y, ex - s * 14, y + 8, o));
    }
    const nodes = [g];
    const step = cmd.step || (max - min <= 20 ? 1 : Math.ceil((max - min) / 10));
    for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
      g.appendChild(this.rc.line(sx(v), y - 7, sx(v), y + 7, { ...o, strokeWidth: 1.6 }));
      const el = document.createElement('div');
      el.className = 'tick';
      el.textContent = String(+v.toFixed(3));
      el.style.left = `${sx(v)}px`; el.style.top = `${y + 12}px`; el.style.transform = 'translateX(-50%)';
      nodes.push(this.addHtml(el, 150));
    }
    this.addSvg(g);
    (cmd.intervals || []).forEach((iv, i) => {
      const c = color(iv.color || 'amber');
      const seg = this.addSvg(this.rc.line(sx(iv.from ?? min), y - 16, sx(iv.to ?? max), y - 16, { stroke: c, strokeWidth: 6, roughness: 0.4 }), 300 + i * 300);
      nodes.push(seg);
      for (const [v, open] of [[iv.from, iv.openFrom], [iv.to, iv.openTo]]) {
        if (v == null) continue;
        nodes.push(this.addSvg(this.rc.circle(sx(v), y - 16, 16, { stroke: c, strokeWidth: 3, fill: open ? COLORS.ink.replace('#EEF1F7', '#1b1e28') : c, fillStyle: 'solid', roughness: 0.3 }), 500 + i * 300));
      }
    });
    (cmd.points || []).forEach((pt, i) => {
      const c = color(pt.color || 'red');
      nodes.push(this.addSvg(this.rc.circle(sx(pt.x), y, 16, { stroke: c, fill: pt.open ? '#1b1e28' : c, fillStyle: 'solid', strokeWidth: 3, roughness: 0.3 }), 300 + i * 250));
      if (pt.label) {
        const el = document.createElement('div');
        el.className = 'tick fn';
        el.innerHTML = richText(pt.label);
        el.style.color = c;
        el.style.left = `${sx(pt.x)}px`; el.style.top = `${y - 52}px`; el.style.transform = 'translateX(-50%)';
        nodes.push(this.addHtml(el, 400 + i * 250));
      }
    });
    this.register(cmd.id, { nodes, bbox: { x: x0 - 20, y: y - 45, w: w + 40, h: 90 } });
  }

  // {"op":"timeline","id":"tl","items":[["1969","ARPANET"],["1983","TCP/IP switch-over"]]}
  op_timeline(cmd) {
    const items = cmd.items || [];
    const n = items.length || 1, x0 = cmd.x ?? 70, w = cmd.w ?? 860;
    const y = this.avoid({ x: x0, y: cmd.y ?? this.cursorY, w, h: 150 }) + 50;
    const id = cmd.id || 'tl';
    const line = this.addSvg(this.rc.line(x0, y, x0 + w, y, { stroke: COLORS.muted, strokeWidth: 2.4, roughness: 0.5 }));
    const nodes = [line];
    const gap = n > 1 ? w / (n - 1) : 0;
    items.forEach((it, i) => {
      const [when, what] = Array.isArray(it) ? it : [it.when, it.what];
      const x = n > 1 ? x0 + i * gap : x0 + w / 2;
      const c = color(cmd.colors?.[i] || cmd.color || 'amber');
      nodes.push(this.addSvg(this.rc.circle(x, y, 18, { stroke: c, fill: c, fillStyle: 'solid', roughness: 0.3 }), i * 450));
      const top = document.createElement('div');
      top.className = 'tick fn';
      top.style.cssText = `left:${x}px;top:${y - 44}px;transform:translateX(-50%);color:${c};font-size:22px;font-weight:700`;
      top.innerHTML = richText(when);
      const bottom = document.createElement('div');
      bottom.className = 'tl-text';
      bottom.style.cssText = `left:${x}px;top:${y + 18}px;width:${Math.max(110, Math.min(240, gap - 14))}px`;
      bottom.innerHTML = richText(what);
      nodes.push(this.addHtml(top, i * 450 + 150), this.addHtml(bottom, i * 450 + 250));
      this.register(`${id}${i + 1}`, { nodes: [], bbox: { x: x - 20, y: y - 20, w: 40, h: 40 }, solid: false });
    });
    this.register(id, { nodes, bbox: { x: x0, y: y - 50, w, h: 150 } });
  }

  // {"op":"tree","id":"dns","root":{"label":".","children":[{"label":"com","children":[{"label":"google"}]}]}}
  // Hierarchies: file systems, DNS, taxonomies, decision trees, recursion.
  op_tree(cmd) {
    const root = cmd.root || cmd.data;
    if (!root) return;
    const leaves = (n) => (n.children?.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1);
    const depth = (n) => 1 + Math.max(0, ...(n.children || []).map(depth));
    const total = leaves(root), levels = depth(root);
    const x0 = cmd.x ?? 40, w = cmd.w ?? 920;
    const y0 = this.avoid({ x: x0, y: cmd.y ?? this.cursorY, w, h: Math.min(500, levels * 110) });
    const levelH = Math.min(120, (588 - y0) / levels);
    const slot = w / total;
    const bw = Math.min(170, slot - 16), bh = Math.min(56, levelH - 30);
    const id = cmd.id || 'tree';
    let k = 0, leafIndex = 0;
    const place = (node, lvl, parent) => {
      let cx;
      if (node.children?.length) {
        const xs = node.children.map((c) => place(c, lvl + 1, null));
        cx = (xs[0] + xs[xs.length - 1]) / 2;
      } else {
        cx = x0 + slot * (leafIndex++ + 0.5);
      }
      node._cx = cx; node._lvl = lvl;
      return cx;
    };
    place(root, 0);
    const draw = (node, parentId) => {
      const nid = `${id}${++k}`;
      const y = y0 + node._lvl * levelH;
      this.box({ id: nid, x: node._cx - bw / 2, y, w: bw, h: bh, label: node.label, color: node.color || cmd.color || (node._lvl === 0 ? 'purple' : 'blue'), size: cmd.size }, node._lvl * 350);
      if (parentId) {
        const p = this.els.get(parentId).bbox;
        const l = this.addSvg(this.rc.line(p.x + p.w / 2, p.y + p.h, node._cx, y, { stroke: COLORS.muted, strokeWidth: 2, roughness: 0.5 }), node._lvl * 350 - 150);
        this.register(`${nid}l`, { nodes: [l], bbox: { x: node._cx, y, w: 1, h: 1 }, solid: false });
      }
      (node.children || []).forEach((c) => draw(c, nid));
    };
    draw(root, null);
  }

  // {"op":"seq","id":"tcp","actors":["Client","Server"]} then
  // {"op":"msg","seq":"tcp","from":"Client","to":"Server","label":"SYN"}
  op_seq(cmd) {
    const actors = cmd.actors || [];
    const x = cmd.x ?? 80, w = cmd.w ?? (W - 2 * x), y = Math.max(cmd.y ?? this.cursorY, this.top);
    const bottom = y + (cmd.h ?? (H - y - 20));
    const n = actors.length || 1;
    const bw = Math.min(200, w / n - 30);
    const xs = actors.map((_, i) => (n === 1 ? x + w / 2 : x + bw / 2 + (i * (w - bw)) / (n - 1)));
    const id = cmd.id || 'seq';
    actors.forEach((name, i) => {
      this.box({ id: `${id}${i + 1}`, x: xs[i] - bw / 2, y, w: bw, h: 60, label: name, color: cmd.color || 'blue' }, i * 150);
      const life = this.rc.line(xs[i], y + 66, xs[i], bottom, { stroke: COLORS.muted, strokeWidth: 1.6, roughness: 0.4, strokeLineDash: [8, 8] });
      life.querySelectorAll('path').forEach((p) => { p.dataset.static = '1'; });
      this.register(`${id}${i + 1}life`, { nodes: [this.addSvg(life, 300)], bbox: { x: xs[i], y: y + 66, w: 1, h: bottom - y - 66 }, solid: false });
    });
    this.seqs.set(id, { actors, xs, nextY: y + 110, step: cmd.step || 62 });
  }

  op_msg(cmd) {
    const s = this.seqs.get(cmd.seq) || [...this.seqs.values()].pop();
    if (!s) return;
    const idx = (v) => (typeof v === 'number' ? v : Math.max(0, s.actors.indexOf(v)));
    const a = idx(cmd.from), b = idx(cmd.to);
    const y = s.nextY;
    s.nextY += s.step;
    this.arrowBetween({ cx: s.xs[a], cy: y, shape: 'point' }, { cx: s.xs[b], cy: y, shape: 'point' },
      { ...cmd, color: cmd.color || 'amber', animate: cmd.animate ?? 'once' });
  }

  // {"op":"counter","id":"c","x":500,"y":300,"from":0,"to":255,"ms":1500,"suffix":" users","size":64}
  // A number that rolls up (or down) to its value.
  op_counter(cmd) {
    const el = document.createElement('div');
    el.className = 'text counter';
    const from = Number(cmd.from) || 0, to = Number(cmd.to) || 0, ms = Math.min(6000, Math.max(300, Number(cmd.ms) || 1500));
    const decimals = Math.max((String(cmd.to).split('.')[1] || '').length, (String(cmd.from).split('.')[1] || '').length);
    const fmt = (v) => `${cmd.prefix || ''}${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${cmd.suffix || ''}`;
    el.textContent = fmt(to);   // measure at the final size
    const bbox = this.place(el, { ...cmd, size: cmd.size || 56, color: cmd.color || 'amber', align: cmd.align || 'center' });
    el.textContent = fmt(from);
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    this.register(cmd.id, { nodes: [el], bbox });
  }

  // ----------------------------------------------------- follow-along
  // The engine sends {"op":"spot","target":id} as the voice starts on a
  // newly drawn piece: the piece glows, a pointer glides next to it, and the
  // rest of the board steps back. {"op":"spot","clear":true} at the end.

  // An id, or a template's base id (row "r" -> r1, r2...), as one box.
  groupBox(id) {
    if (!id) return null;
    let ids = this.els.has(id) ? [id] : [...this.els.keys()].filter(
      (k) => k.startsWith(id) && /^[\d_a]/.test(k.slice(id.length)));
    if (!ids.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const k of ids) {
      const b = this.els.get(k).bbox;
      if (!(b.w > 1 || b.h > 1)) continue;
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    if (!Number.isFinite(x1)) return null;
    return { ids, bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
  }

  op_spot(cmd) {
    if (cmd.clear) { this.clearSpot(); return; }
    const g = this.groupBox(cmd.target);
    if (!g) return;
    const keep = new Set(g.ids);
    const dim = this.els.size >= 3;   // nothing to step back from on a sparse board
    for (const [k, rec] of this.els) {
      const on = keep.has(k);
      rec.nodes.forEach((n) => {
        n.classList.toggle('spot-glow', on);
        n.classList.toggle('soft-dim', dim && !on && !keep.has(k));
      });
    }
    // The pointer: left of the piece, or above it when there's no room.
    // The pointer: left of the piece; for wide pieces (or no room on the
    // left), above the middle pointing down, or below pointing up.
    const b = g.bbox;
    let px = b.x - 54, py = b.y + Math.min(b.h, 160) / 2 - 18, rot = 0;
    if (px < 4 || b.w > 600) {
      px = b.x + b.w / 2 - 22;
      if (b.y - 62 >= this.top - 10) { py = b.y - 62; rot = 90; }
      else { py = b.y + b.h + 24; rot = -90; }
    }
    if (!this.pointer || !this.pointer.isConnected) {
      const el = document.createElement('div');
      el.className = 'follow-pointer';
      el.innerHTML = '<svg width="44" height="36" viewBox="0 0 44 36"><path d="M2 12 H26 V3 L42 18 L26 33 V24 H2 Z" fill="#FFC857" stroke="#1b1e28" stroke-width="2" stroke-linejoin="round"/></svg>';
      Object.assign(el.style, { left: `${px}px`, top: `${py}px`, opacity: '0' });
      this.layer.appendChild(el);
      this.pointer = el;
    }
    if (window.gsap) {
      gsap.to(this.pointer, { left: px, top: py, rotation: rot, opacity: 1, duration: 0.45, ease: 'power3.out' });
      gsap.fromTo(this.pointer, { x: -6 }, { x: 0, duration: 0.5, ease: 'power1.inOut', repeat: 3, yoyo: true, delay: 0.45 });
    } else {
      Object.assign(this.pointer.style, { left: `${px}px`, top: `${py}px`, opacity: '1' });
    }
  }

  clearSpot() {
    for (const rec of this.els.values()) rec.nodes.forEach((n) => n.classList.remove('spot-glow', 'soft-dim'));
    if (this.pointer) {
      const p = this.pointer;
      this.pointer = null;
      if (window.gsap) gsap.to(p, { opacity: 0, duration: 0.3, onComplete: () => p.remove() });
      else p.remove();
    }
  }

  // {"op":"pulse","target":"r2"}: draw the eye to an element without a ring.
  op_pulse(cmd) {
    const t = this.targetBox(cmd);
    if (!t) return;
    const nodes = t.row != null ? [t.rec.nodes[0].rows[t.row]] : t.rec.nodes;
    for (const n of nodes) { n.classList.remove('pulse'); void n.getBoundingClientRect(); n.classList.add('pulse'); }
  }

  // --------------------------------------------- library-backed motion
  nodesOf(cmd) {
    const t = this.targetBox(cmd);
    if (!t) return null;
    const nodes = (t.row != null ? [t.rec.nodes[0].rows[t.row]] : t.rec.nodes).filter((n) => n && n.isConnected);
    return nodes.length ? { t, nodes } : null;
  }

  // {"op":"fx","target":"<id>","effect":"bounce","repeat":-1}
  op_fx(cmd) {
    if (!window.gsap) return;
    const r = this.nodesOf(cmd);
    if (!r) return;
    const FX = {
      bounce: { y: -26, duration: 0.45, ease: 'power2.out', yoyo: true, repeat: 1 },
      pop: { scale: 1.25, duration: 0.25, ease: 'back.out(3)', yoyo: true, repeat: 1 },
      shake: { x: 10, duration: 0.07, ease: 'none', yoyo: true, repeat: 7 },
      wiggle: { rotation: 6, duration: 0.12, yoyo: true, repeat: 7, ease: 'sine.inOut' },
      float: { y: -12, duration: 1.3, yoyo: true, repeat: -1, ease: 'sine.inOut' },
      spin: { rotation: 360, duration: 1.2, ease: 'power1.inOut' },
      blink: { opacity: 0.15, duration: 0.3, yoyo: true, repeat: 5 },
      grow: { scale: 1.3, duration: 0.6, ease: 'power2.out' },
      shrink: { scale: 0.7, duration: 0.6, ease: 'power2.out' },
      slideIn: { from: { x: -300, opacity: 0 }, duration: 0.7, ease: 'power3.out' },
      drop: { from: { y: -300, opacity: 0 }, duration: 0.8, ease: 'bounce.out' },
      swing: { rotation: 12, duration: 0.5, yoyo: true, repeat: 5, ease: 'sine.inOut', origin: 'top center' },
      heartbeat: { scale: 1.15, duration: 0.18, yoyo: true, repeat: 3, ease: 'power1.inOut', repeatDelay: 0.1 },
    };
    const spec = FX[cmd.effect] || FX.pop;
    const { from, origin, ...to } = spec;
    const opts = { ...to, delay: Number(cmd.delay) || 0, transformOrigin: origin || 'center center' };
    if (cmd.repeat != null) {
      opts.repeat = Number(cmd.repeat);
      if (opts.repeat === -1 && !('yoyo' in opts) && cmd.effect !== 'spin') opts.yoyo = true;
      if (opts.repeat === -1 && cmd.effect === 'spin') opts.ease = 'none';
    }
    for (const n of r.nodes) {
      if (from) gsap.from(n, { ...from, duration: opts.duration, ease: opts.ease, delay: opts.delay });
      else gsap.to(n, opts);
    }
  }

  // {"op":"move","target":"<id>","path":"M ...","duration":2,"repeat":-1,"rotate":true}
  op_move(cmd) {
    if (!window.gsap) return;
    const r = this.nodesOf(cmd);
    if (!r) return;
    const d = String(cmd.path || '').trim();
    const b = r.t.bbox, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const single = d.match(/^M\s*([-\d.]+)[\s,]+([-\d.]+)\s*$/i);
    for (const n of r.nodes) {
      if (single) {
        gsap.to(n, { x: +single[1] - cx, y: +single[2] - cy, duration: Math.min(10, Number(cmd.duration) || 1), ease: 'power2.inOut' });
        continue;
      }
      if (!window.MotionPathPlugin) return;
      gsap.to(n, {
        duration: Math.min(20, Number(cmd.duration) || 2), repeat: cmd.repeat != null ? Number(cmd.repeat) : 0,
        yoyo: !!cmd.yoyo, ease: typeof cmd.ease === 'string' ? cmd.ease : 'none', delay: Number(cmd.delay) || 0,
        motionPath: { path: d, offsetX: -cx, offsetY: -cy, autoRotate: !!cmd.rotate },
      });
    }
  }

  // {"op":"anim","target":"<id>","to":{...},"from":{...},"duration":1,"repeat":-1,"yoyo":true}
  op_anim(cmd) {
    if (!window.gsap) return;
    const r = this.nodesOf(cmd);
    if (!r) return;
    const allowed = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'skewX', 'skewY'];
    const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => allowed.includes(k) && Number.isFinite(+v)).map(([k, v]) => [k, +v]));
    const base = {
      duration: Math.min(10, Number(cmd.duration) || 1), delay: Number(cmd.delay) || 0,
      repeat: cmd.repeat != null ? Number(cmd.repeat) : 0, yoyo: !!cmd.yoyo,
      ease: typeof cmd.ease === 'string' ? cmd.ease : 'power2.inOut', transformOrigin: 'center center',
    };
    for (const n of r.nodes) {
      if (cmd.from && cmd.to) gsap.fromTo(n, clean(cmd.from), { ...clean(cmd.to), ...base });
      else if (cmd.from) gsap.from(n, { ...clean(cmd.from), ...base });
      else gsap.to(n, { ...clean(cmd.to), ...base });
    }
  }

  // {"op":"annotate","target":"<id>","type":"underline|box|circle|highlight|strike-through|crossed-off|bracket","color":"red"}
  // Hand-drawn marks in the Rough Notation style, drawn with rough.js in
  // board coordinates (Rough Notation itself measures screen pixels, which
  // breaks on a scaled board).
  op_annotate(cmd) {
    const t = this.targetBox(cmd);
    if (!t) return;
    const b = t.bbox, c = color(cmd.color || 'amber'), pad = 8;
    const o = { stroke: c, strokeWidth: 3, roughness: 1.4, bowing: 1.5 };
    const g = document.createElementNS(SVGNS, 'g');
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const add = (node) => g.appendChild(node);
    switch (cmd.type) {
      case 'box': add(this.rc.rectangle(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad, o)); break;
      case 'circle': add(this.rc.ellipse(cx, cy, b.w * 1.18 + 2 * pad, b.h * 1.5 + 2 * pad, o)); break;
      case 'highlight':
        add(this.rc.line(b.x - 4, cy, b.x + b.w + 4, cy,
          { stroke: `${c}55`, strokeWidth: Math.max(10, b.h * 0.85), roughness: 0.8, bowing: 0.5 }));
        break;
      case 'strike-through': add(this.rc.line(b.x - 4, cy, b.x + b.w + 4, cy + 2, o)); break;
      case 'crossed-off':
        add(this.rc.line(b.x, b.y, b.x + b.w, b.y + b.h, o));
        add(this.rc.line(b.x + b.w, b.y, b.x, b.y + b.h, o));
        break;
      case 'bracket': {
        const x = b.x - pad - 6;
        add(this.rc.linearPath([[x + 14, b.y - 4], [x, b.y - 4], [x, b.y + b.h + 4], [x + 14, b.y + b.h + 4]], o));
        break;
      }
      default: add(this.rc.line(b.x, b.y + b.h + 5, b.x + b.w, b.y + b.h + 7, o));
    }
    // Highlights sit behind the text; the SVG layer is already underneath
    // the HTML layer, so that's automatic.
    this.addSvg(g);
    this.register(cmd.id, { nodes: [g], bbox: b, solid: false });
  }

  // {"op":"cursor","target":"<id>","click":true}  or  {"op":"cursor","x":500,"y":300}
  // A mouse pointer glides to a spot and clicks: for walking through software.
  op_cursor(cmd) {
    let tx, ty;
    if (cmd.target) {
      const t = this.targetBox(cmd);
      if (!t) return;
      tx = t.bbox.x + t.bbox.w / 2; ty = t.bbox.y + t.bbox.h / 2;
    } else if (cmd.x != null && cmd.y != null) { tx = +cmd.x; ty = +cmd.y; } else return;
    if (!this.cursorEl || !this.cursorEl.isConnected) {
      const el = document.createElement('div');
      el.className = 'cursor';
      el.innerHTML = `<svg width="34" height="34" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.6 20.2 L11.5 13.6 L17.5 13.4 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
      Object.assign(el.style, { left: `${W - 40}px`, top: `${H - 30}px` });
      this.layer.appendChild(el);
      this.cursorEl = el;
    }
    const el = this.cursorEl, click = cmd.click !== false;
    const ripple = () => {
      if (!click) return;
      const r = document.createElement('div');
      r.className = 'ripple';
      Object.assign(r.style, { left: `${tx}px`, top: `${ty}px`, borderColor: color(cmd.color || 'amber') });
      this.layer.appendChild(r);
      setTimeout(() => r.remove(), 900);
      if (cmd.target) this.op_pulse(cmd);
    };
    if (window.gsap) {
      gsap.to(el, { left: tx, top: ty, duration: Number(cmd.duration) || 0.9, ease: 'power3.inOut',
        onComplete: () => { gsap.fromTo(el, { scale: 1 }, { scale: 0.85, duration: 0.08, yoyo: true, repeat: 1 }); ripple(); } });
    } else {
      Object.assign(el.style, { left: `${tx}px`, top: `${ty}px` });
      ripple();
    }
  }

  // {"op":"mermaid","id":"<id>","code":"flowchart LR\n A-->B","x":40,"y":95,"w":920,"h":440}
  async op_mermaid(cmd) {
    if (!window.mermaid) return;
    const code = String(cmd.code || '').replace(/\\n/g, '\n').trim();
    const w = Math.min(cmd.w || 920, 960), h = Math.min(cmd.h || 440, 520);
    const x = cmd.x ?? (W - w) / 2;
    const y = this.avoid({ x, y: cmd.y ?? this.cursorY, w, h });
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-wrap';
    Object.assign(wrap.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    this.addHtml(wrap);
    const rec = this.register(cmd.id, { nodes: [wrap], bbox: { x, y, w, h } });
    const gen = this.gen;
    let svgText;
    try {
      ({ svg: svgText } = await mermaid.render(`mm${++this.auto}`, code));
    } catch (e) {
      console.warn('mermaid failed', e);
      if (this.gen === gen) wrap.innerHTML = `<div class="nomedia">diagram didn't render</div>`;
      return;
    }
    if (this.gen !== gen || !wrap.isConnected) return;
    wrap.innerHTML = svgText;
    const svg = wrap.querySelector('svg');
    if (!svg) return;
    svg.removeAttribute('height'); svg.removeAttribute('width');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    // Draw-on: edges trace themselves, nodes fade in one after another.
    svg.querySelectorAll('path, line, polyline').forEach((p, i) => {
      try {
        const len = p.getTotalLength();
        if (!len) return;
        p.style.strokeDasharray = `${len} ${len}`;
        p.style.strokeDashoffset = `${len}`;
        p.style.transition = `stroke-dashoffset 700ms ease ${200 + Math.min(i, 30) * 60}ms`;
        requestAnimationFrame(() => { p.style.strokeDashoffset = '0'; });
      } catch { /* non-geometric path */ }
    });
    svg.querySelectorAll('.node, .actor, .mindmap-node, .section, .cluster, .label, .edgeLabel').forEach((n, i) => {
      n.style.opacity = '0';
      n.style.transition = `opacity 400ms ease ${Math.min(i, 30) * 110}ms`;
      requestAnimationFrame(() => { n.style.opacity = '1'; });
    });
    rec.bbox = { x, y, w, h };
    this.fitContent();
  }
}

window.Board = Board;
