// Library-backed board ops (simulations, live geometry, maps, notation,
// code stepping). Extends Board.prototype; loaded after board.js.
//
// Libraries load from ../node_modules the first time an op needs them.
// Model-written code (sim) and Python (trace) never run on this page: they
// run in Workers inside sandboxed iframes (sandbox.html: opaque origin, no
// network, no access to this page or the preload bridge), and a watchdog
// terminates a worker that stops responding.
(() => {
  const LIB = '../node_modules/';
  const PALETTE = ['blue', 'amber', 'green', 'purple', 'red'];

  // ------------------------------------------------------------ loaders
  const cache = new Map();
  const once = (key, make) => {
    if (!cache.has(key)) {
      const p = make();
      p.catch(() => cache.delete(key));   // a failed load can be retried later
      cache.set(key, p);
    }
    return cache.get(key);
  };
  const url = (rel) => (rel.startsWith('./') ? rel.slice(2) : LIB + rel);
  const loadScript = (rel) => once(`js:${rel}`, () => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url(rel);
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${rel}`));
    document.head.appendChild(s);
  }));
  const fetchAs = (rel, kind) => once(`${kind}:${rel}`, async () => {
    const r = await fetch(url(rel));
    if (!r.ok) throw new Error(`could not load ${rel}`);
    return kind === 'json' ? r.json() : kind === 'bin' ? r.arrayBuffer() : r.text();
  });
  const loadText = (rel) => fetchAs(rel, 'text');
  const loadJson = (rel) => fetchAs(rel, 'json');
  const loadBin = (rel) => fetchAs(rel, 'bin');

  // ------------------------------------------------------------ styles
  const css = document.createElement('style');
  css.textContent = `
  .el.sqx-box { overflow: hidden; }
  .sqx-frame { position: absolute; left: 0; top: 0; border: 0; background: transparent; pointer-events: none; }
  .sqx-note { position: absolute; left: 10px; bottom: 8px; padding: 3px 10px; border-radius: 8px; z-index: 2;
    background: rgba(13,15,22,0.85); border: 1px solid rgba(255,107,107,0.45); color: #FF6B6B;
    font-size: 16px; font-weight: 600; white-space: nowrap; max-width: calc(100% - 20px); overflow: hidden; text-overflow: ellipsis; }
  .sqx-note.mid { left: 50%; top: 50%; bottom: auto; transform: translate(-50%, -50%); }
  .el.sqx-failed { border: 2px dashed rgba(255,255,255,0.18); border-radius: 10px; }
  .sqx-note small { color: var(--muted); font-weight: 500; margin-left: 8px; font-size: 13px; }
  #board text.sqx-jt { font-family: var(--ui); font-weight: 600; paint-order: stroke; stroke: rgba(13,15,22,0.85);
    stroke-width: 4px; stroke-linejoin: round; }
  .sqx-maplabel { position: absolute; font-size: 20px; font-weight: 700; white-space: nowrap; line-height: 1.15;
    text-shadow: 0 1px 3px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9); }
  .sqx-abc { position: absolute; left: 0; top: 0; }
  .sqx-abc .sqx-abc-hl, .sqx-abc .sqx-abc-hl path { fill: #FFC857 !important; }
  .sqx-trace .tr-code { position: absolute; left: 0; top: 0; overflow: hidden; padding: 8px 0; border-radius: 10px;
    background: rgba(11,13,16,0.82); border: 1px solid rgba(255,255,255,0.12); font-family: var(--mono); line-height: 1.5;
    font-variant-ligatures: none; font-feature-settings: "calt" 0, "liga" 0; }
  .sqx-trace .tr-line { position: relative; display: flex; white-space: pre; color: #d6deeb; border-left: 4px solid transparent;
    transition: background 200ms ease, border-color 200ms ease; }
  .sqx-trace .tr-no { flex: none; width: 2.6em; padding-right: 0.8em; text-align: right; color: var(--muted); opacity: 0.7; }
  .sqx-trace .tr-src { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .sqx-trace .tr-badge { flex: none; padding: 0 10px; color: var(--green); font-weight: 700; }
  .sqx-trace .tr-line.cur { background: rgba(255,200,87,0.17); border-left-color: var(--amber); }
  .sqx-trace .tr-line.cur .tr-no { color: var(--amber); opacity: 1; }
  .sqx-trace .tr-line.err { background: rgba(255,107,107,0.18); border-left-color: var(--red); }
  .sqx-trace .tr-side { position: absolute; top: 0; display: flex; flex-direction: column; gap: 10px; overflow: hidden; }
  .sqx-trace .tr-vars { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .sqx-trace .tr-h { font-size: 15px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin: 2px 0 4px; }
  .sqx-trace table { border-collapse: collapse; width: 100%; font-family: var(--mono); margin-bottom: 8px; font-variant-ligatures: none; }
  .sqx-trace td { padding: 2px 8px; border-bottom: 1px solid rgba(255,255,255,0.1); vertical-align: top; }
  .sqx-trace td.k { color: var(--blue); font-weight: 600; width: 1%; white-space: nowrap; }
  .sqx-trace td.v { color: var(--text); word-break: break-all; }
  .sqx-trace tr.chg td { animation: sqxchg 900ms ease; }
  .sqx-trace tr.chg td.v { color: var(--amber); }
  @keyframes sqxchg { from { background: rgba(255,200,87,0.35); } to { background: transparent; } }
  .sqx-trace .tr-outwrap { flex: none; max-height: 45%; overflow: hidden; }
  .sqx-trace .tr-out { margin: 0; padding: 6px 10px; border-radius: 8px; background: rgba(11,13,16,0.82); border: 1px solid rgba(255,255,255,0.12);
    color: var(--green); font-family: var(--mono); font-size: 0.85em; white-space: pre-wrap; min-height: 1.6em; }
  .sqx-trace .tr-status { position: absolute; left: 4px; right: 4px; bottom: 0; height: 26px; font-size: 17px; font-weight: 600;
    color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sqx-trace .tr-status.ok { color: var(--green); }
  .sqx-trace .tr-status.bad { color: var(--red); }
  .sqx-cap { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; font-size: 20px;
    font-weight: 600; color: var(--text); line-height: 28px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `;
  document.head.appendChild(css);

  // ------------------------------------------------------------ helpers
  // A rectangle on the board, placed by the usual layout rules: like board.avoid, except that sitting inside something only counts as
  // fine when that something is clearly bigger (a scene's rectangle), not
  // when it's another element of about the same size.
  function placeRect(board, cmd, dw, dh) {
    const w = Math.max(80, Math.min(+cmd.w || dw, 960)), h = Math.max(60, Math.min(+cmd.h || dh, 600));
    const x = +cmd.x >= 0 ? +cmd.x : (1000 - w) / 2;
    let y = Math.max(+cmd.y >= 0 ? +cmd.y : board.cursorY, board.top);
    for (let guard = 0; guard < 30; guard++) {
      const probe = { x, y, w, h };
      let hit = null;
      for (const [id, rec] of board.els) {
        if (id === cmd.id || rec.solid === false || !board.overlaps(probe, rec.bbox)) continue;   // a reused id is replaced
        const b = rec.bbox;
        if (board.contains(b, probe) && b.w * b.h > 1.3 * w * h) continue;
        hit = rec; break;
      }
      if (!hit) break;
      y = hit.bbox.y + hit.bbox.h + 12;
    }
    return { x, y, w, h };
  }
  function boxEl(r, cls = '') {
    const el = document.createElement('div');
    el.className = `sqx-box ${cls}`;
    Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    return el;
  }
  function failNote(el, text, detail, centre = true) {
    if (!el.isConnected || el.querySelector(':scope > .sqx-note')) return;
    const n = document.createElement('div');
    n.className = `sqx-note${centre ? ' mid' : ''}`;
    if (centre) el.classList.add('sqx-failed');
    n.textContent = text;
    if (detail) {
      const s = document.createElement('small');
      s.textContent = String(detail).slice(0, 80);
      n.appendChild(s);
    }
    el.appendChild(n);
  }
  function caption(el, text) {
    if (!text) return 0;
    const c = document.createElement('div');
    c.className = 'sqx-cap';
    c.innerHTML = richText(text);
    el.appendChild(c);
    return 30;
  }
  // Device pixels per board pixel, so canvases stay crisp when framed or docked big.
  function pixelScale(board) {
    const r = board.root.getBoundingClientRect();
    const s = (r.width / 1000) * (window.devicePixelRatio || 1) * 1.25;
    return Math.min(2.5, Math.max(1, Number.isFinite(s) ? s : 1));
  }

  // ------------------------------------------------------------ sandbox
  // One iframe per sandboxed worker. Messages are only accepted from the
  // iframe we created, and whatever it says is treated as plain data.
  const hosts = new Map();   // contentWindow -> handler
  window.addEventListener('message', (e) => {
    const h = hosts.get(e.source);
    if (h) h(e.data || {});
  });
  setInterval(() => {
    for (const [win, h] of hosts) if (!h.iframe.isConnected) hosts.delete(win);
  }, 5000);

  // Starts a worker from `spec` = {src, payload, canvas:{w,h,k}?, limit, maxLimit}
  // inside `iframe` (already in the document). on(msg) gets its messages.
  // Returns {post, kill} at once; posts wait until the worker is booted.
  function sandbox(iframe, specP, on) {
    iframe.className = `${iframe.className} sqx-frame`.trim();
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('aria-hidden', 'true');
    let win = null, ready = false;
    const queue = [];
    const post = (m) => { if (ready) win.postMessage(m, '*'); else queue.push(m); };
    (async () => {
      const [html, spec] = await Promise.all([loadText('./sandbox.html'), specP]);
      if (!iframe.isConnected) return;
      const handler = (m) => {
        if (m.type !== 'ready') { on(m); return; }
        if (ready) return;
        ready = true;
        win.postMessage({ type: 'boot', ...spec }, '*');
        for (const q of queue.splice(0)) win.postMessage(q, '*');
      };
      handler.iframe = iframe;
      iframe.srcdoc = html;
      win = iframe.contentWindow;
      hosts.set(win, handler);
    })().catch((e) => on({ type: 'error', message: e.message }));
    return { post, kill: () => post({ type: 'kill' }) };
  }

  const usesMatter = (code) => /\bMatter\b|\bphysics\s*\(|\bwalls\s*\(/.test(code);

  // ------------------------------------------------------------ terms
  // Safe math terms for geo: numbers, + - * / ^, implicit multiplication,
  // named variables (x, t, slider ids), a whitelist of functions. No eval.
  // compileTerm(src, vars) -> (env) => number, reading variables from env.
  const FN = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
    atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt,
    abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2, floor: Math.floor,
    ceil: Math.ceil, round: Math.round, sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow,
    hypot: Math.hypot, sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v), cot: (v) => 1 / Math.tan(v),
  };
  const CONST = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
  function compileTerm(src, vars) {
    if (typeof src === 'number') return () => src;
    const s = String(src ?? '').replace(/\*\*/g, '^').replace(/π/g, 'pi').replace(/·|×/g, '*').replace(/−/g, '-');
    const known = (id) => vars.has(id) || id in CONST;
    // "ax" is a*x when a and x are variables (models write it that way).
    const split = (id) => {
      const out = [];
      for (let i = 0; i < id.length;) {
        let hit = null;
        for (let j = id.length; j > i; j--) if (known(id.slice(i, j))) { hit = id.slice(i, j); break; }
        if (!hit) return null;
        out.push(hit); i += hit.length;
      }
      return out;
    };
    const toks = [];
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (num) { toks.push({ t: 'n', v: parseFloat(num[0]) }); i += num[0].length; continue; }
      if (/[A-Za-z_]/.test(c)) {
        let j = i; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
        const id = s.slice(i, j), lower = id.toLowerCase();
        i = j;
        if (vars.has(id)) toks.push({ t: 'id', v: id });
        else if (lower in FN && s[i] === '(') toks.push({ t: 'id', v: lower });
        else if (lower in CONST) toks.push({ t: 'id', v: lower });
        else {
          const parts = split(id);
          if (!parts) throw new Error(`unknown name ${id}`);
          parts.forEach((p) => toks.push({ t: 'id', v: p }));
        }
        continue;
      }
      if ('+-*/^(),'.includes(c)) { toks.push({ t: c }); i++; continue; }
      throw new Error(`bad character ${c}`);
    }
    let p = 0;
    const peek = () => toks[p];
    const eat = (t) => (toks[p] && toks[p].t === t ? (p++, true) : false);
    const expr = () => {
      let a = term();
      while (peek() && (peek().t === '+' || peek().t === '-')) {
        const op = toks[p++].t, b = term(), l = a;
        a = op === '+' ? (v) => l(v) + b(v) : (v) => l(v) - b(v);
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
          a = t.t === '*' ? (v) => l(v) * b(v) : (v) => l(v) / b(v);
        } else if (t.t === 'n' || t.t === 'id' || t.t === '(') {
          const b = power(), l = a;
          a = (v) => l(v) * b(v);
        } else break;
      }
      return a;
    };
    const unary = () => {
      if (eat('-')) { const a = unary(); return (v) => -a(v); }
      if (eat('+')) return unary();
      return power();
    };
    const power = () => {
      const base = atom();
      if (eat('^')) { const ex = unary(); return (v) => Math.pow(base(v), ex(v)); }
      return base;
    };
    const atom = () => {
      const t = toks[p++];
      if (!t) throw new Error('unexpected end');
      if (t.t === 'n') return () => t.v;
      if (t.t === '(') { const a = expr(); if (!eat(')')) throw new Error('missing )'); return a; }
      if (t.t === 'id') {
        if (vars.has(t.v)) { const k = t.v; return (v) => v[k]; }
        if (t.v in CONST) { const k = CONST[t.v]; return () => k; }
        if (t.v in FN) {
          if (!eat('(')) throw new Error(`${t.v} needs (`);
          const args = [expr()];
          while (eat(',')) args.push(expr());
          if (!eat(')')) throw new Error('missing )');
          const f = FN[t.v];
          return (v) => f(...args.map((g) => g(v)));
        }
      }
      throw new Error(`unexpected ${t.t}`);
    };
    const f = expr();
    if (p !== toks.length) throw new Error('trailing input');
    return f;
  }
  const fmtNum = (v) => (Number.isFinite(v) ? String(+v.toFixed(Math.abs(v) >= 100 ? 0 : 2)) : '?');

  // JSXGraph, dark: every text is SVG text (never HTML), nothing is draggable.
  let jxgReady = null;
  function loadJXG() {
    jxgReady = jxgReady || loadScript('jsxgraph/distrib/jsxgraphcore.js').then(() => {
      const O = JXG.Options;
      const text = { display: 'internal', parse: false, useMathJax: false, useKatex: false, useASCIIMathML: false,
        fontSize: 22, strokeColor: COLORS.ink, highlightStrokeColor: COLORS.ink, cssClass: 'sqx-jt', highlightCssClass: 'sqx-jt' };
      Object.assign(O.text, text);
      Object.assign(O.label, text);
      O.elements.fixed = true;
      O.elements.highlight = false;
      O.elements.showInfobox = false;
      O.board.showInfobox = false;
    }).catch((e) => { jxgReady = null; throw e; });
    return jxgReady;
  }

  // Builds a JSXGraph board from the data-only element list. Returns {animate}.
  let geoCount = 0;
  function buildGeo(wrap, r, cmd) {
    const capH = caption(wrap, cmd.caption);
    const W = r.w, H = r.h - capH;
    const div = document.createElement('div');
    div.id = `sqxjxg${++geoCount}`;
    Object.assign(div.style, { position: 'absolute', left: '0', top: '0', width: `${W}px`, height: `${H}px` });
    wrap.appendChild(div);
    const n = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
    let [x0, x1, y0, y1] = [n(cmd.xmin, -5), n(cmd.xmax, 5), n(cmd.ymin, -5), n(cmd.ymax, 5)];
    if (!(x1 > x0)) [x0, x1] = [-5, 5];
    if (!(y1 > y0)) [y0, y1] = [-5, 5];
    const brd = JXG.JSXGraph.initBoard(div.id, {
      boundingbox: [x0, y1, x1, y0],
      keepAspectRatio: !!cmd.equal, axis: false, grid: false, showNavigation: false, showCopyright: false,
      showInfobox: false, showLogo: false, pan: { enabled: false }, zoom: { enabled: false, wheel: false },
      registerEvents: false, resize: { enabled: false },
    });
    const bb = brd.getBoundingBox();
    const usr = (px, py) => [bb[0] + (px / W) * (bb[2] - bb[0]), bb[1] - (py / H) * (bb[1] - bb[3])];
    const els = (cmd.els || cmd.elements || cmd.items || []).filter((e) => e && typeof e === 'object');
    const vals = {}, sliders = {}, pts = {}, fns = {};
    const vars = new Set(['x', 't']);
    for (const e of els) if (e.t === 'slider' && e.id != null) vars.add(String(e.id));
    const term = (src, d = 0) => {
      if (src == null || src === '') return () => d;
      if (typeof src === 'number') return () => src;
      const f = compileTerm(src, vars);
      return () => f(vals);
    };
    const fnOf = (src, v = 'x') => {
      if (typeof src === 'string' && fns[src]) return fns[src];
      const f = compileTerm(src, vars);
      return (x) => { vals[v] = x; return f(vals); };
    };
    let slot = 0, info = 0;
    const tint = (e) => color(e.color || PALETTE[slot++ % PALETTE.length]);
    const P = (ref) => {
      if (typeof ref === 'string' && pts[ref]) return pts[ref];
      if (!Array.isArray(ref)) throw new Error(`unknown point ${ref}`);
      return brd.create('point', [term(ref[0]), term(ref[1])], { visible: false, withLabel: false });
    };
    const label = (txt) => String(txt ?? '').replace(/\$/g, '');
    // Value readouts ("<label> = 1.25") stack at the top right, or under the
    // sliders when the graph is too narrow for both side by side.
    const nSliders = els.filter((e) => e.t === 'slider').length;
    const corner = (content, c, size = 22) => {
      const narrow = W < 520 && nSliders > 0;
      const pos = narrow ? usr(22, 26 + nSliders * 40 + info++ * 30) : usr(W - 18, 26 + info++ * 30);
      brd.create('text', [pos[0], pos[1], content], { anchorX: narrow ? 'left' : 'right', anchorY: 'middle', strokeColor: c, fontSize: size });
    };
    const readout = (txt, fn, c) => corner(() => `${label(txt)} = ${fmtNum(fn())}`, c);

    brd.suspendUpdate();
    // Axes and a faint grid, both at a round step about 70 px apart.
    const nice = (raw) => {
      const p10 = Math.pow(10, Math.floor(Math.log10(raw)));
      return [1, 2, 5, 10].map((m) => m * p10).find((v) => v >= raw * 0.999);
    };
    const sx = nice(((bb[2] - bb[0]) * 70) / W), sy = nice(((bb[1] - bb[3]) * 70) / H);
    if (cmd.grid !== false) {
      brd.create('grid', [], { majorStep: [sx, sy], minorElements: 0, strokeColor: '#ffffff', strokeOpacity: 0.08, strokeWidth: 1 });
    }
    if (cmd.axis !== false) {
      const ax = (step) => ({
        strokeColor: COLORS.muted, strokeWidth: 1.6, lastArrow: { type: 2, size: 7 }, firstArrow: false,
        ticks: { strokeColor: COLORS.muted, strokeOpacity: 0.7, majorHeight: 8, minorTicks: 0, drawZero: false,
          insertTicks: false, ticksDistance: step, label: { fontSize: 16, strokeColor: COLORS.muted, display: 'internal' } },
      });
      brd.create('axis', [[0, 0], [1, 0]], ax(sx));
      brd.create('axis', [[0, 0], [0, 1]], ax(sy));
    }
    const skipped = [];
    for (const e of els) {
      try {
        const c = e.t === 'slider' ? null : tint(e);
        const id = e.id != null ? String(e.id) : null;
        const lab = e.label != null ? label(e.label) : '';
        switch (e.t) {
          case 'slider': {
            const min = n(e.min, 0), max = n(e.max, 10), v0 = Math.min(max, Math.max(min, n(e.value, min)));
            const k = Object.keys(sliders).length, y = 26 + k * 40, sc = color(e.color || 'amber');
            const S = brd.create('slider', [usr(22, y), usr(22 + Math.min(200, W * 0.36), y), [min, v0, max]], {
              name: lab || id || '', snapWidth: n(e.step, -1), withTicks: false, size: 6,
              digits: Number.isInteger(n(e.step, 0.5)) && Number.isInteger(min) ? 0 : 2,
              strokeColor: sc, fillColor: sc, baseline: { strokeColor: COLORS.muted, strokeWidth: 3 },
              highline: { strokeColor: sc, strokeWidth: 4 }, label: { fontSize: 20, strokeColor: COLORS.ink },
            });
            if (id) { sliders[id] = S; Object.defineProperty(vals, id, { get: () => S.Value(), enumerable: true }); }
            break;
          }
          case 'fn': {
            const f = fnOf(e.f ?? e.fn ?? e.expr);
            const parents = [f];
            if (e.from != null || e.to != null) parents.push(term(e.from, bb[0]), term(e.to, bb[2]));
            brd.create('functiongraph', parents, { strokeColor: c, strokeWidth: n(e.width, 3), dash: e.dashed ? 2 : 0 });
            if (id) fns[id] = f;
            if (lab) {
              // The label rides the curve near the right edge, wherever it's visible.
              const yr = bb[1] - bb[3];
              const lx = () => {
                for (let i = 0; i <= 45; i++) {
                  const xx = bb[2] - (bb[2] - bb[0]) * (0.05 + i * 0.02), yy = f(xx);
                  if (yy > bb[3] + yr * 0.05 && yy < bb[1] - yr * 0.12) return xx;
                }
                return bb[2] - (bb[2] - bb[0]) * 0.05;
              };
              brd.create('text', [() => lx(), () => f(lx()) + yr * 0.03, lab],
                { anchorX: 'right', anchorY: 'bottom', strokeColor: c, fontSize: 22 });
            }
            break;
          }
          case 'curve': {
            brd.create('curve', [fnOf(e.x, 't'), fnOf(e.y, 't'), term(e.from, 0), term(e.to, 2 * Math.PI)],
              { strokeColor: c, strokeWidth: n(e.width, 3), name: lab, withLabel: !!lab, label: { strokeColor: c } });
            break;
          }
          case 'point': {
            const p = brd.create('point', [term(e.x), term(e.y)], { name: lab, withLabel: !!lab, size: 5,
              strokeColor: c, fillColor: c, label: { strokeColor: c, offset: [10, 14] } });
            if (id) pts[id] = p;
            break;
          }
          case 'line': case 'segment': case 'vector': {
            const type = e.t === 'vector' ? 'arrow' : e.t;
            brd.create(type, [P(e.from), P(e.to)], { strokeColor: c, strokeWidth: n(e.width, 3), dash: e.dashed ? 2 : 0,
              name: lab, withLabel: !!lab, label: { strokeColor: c }, lastArrow: e.t === 'vector' ? { type: 2, size: 5 } : false });
            break;
          }
          case 'circle': {
            brd.create('circle', [P(e.center), term(e.r, 1)], { strokeColor: c, strokeWidth: n(e.width, 3),
              fillColor: c, fillOpacity: e.fill === false ? 0 : 0.12, name: lab, withLabel: !!lab, label: { strokeColor: c } });
            break;
          }
          case 'polygon': {
            brd.create('polygon', (e.points || []).map(P), { fillColor: c, fillOpacity: e.fill === false ? 0 : 0.18,
              borders: { strokeColor: c, strokeWidth: n(e.width, 3) }, name: lab, withLabel: !!lab, label: { strokeColor: c } });
            break;
          }
          case 'angle': {
            const [A, B, Cp] = (e.points || []).map(P);
            const a = brd.create('nonreflexangle', [A, B, Cp], { radius: n(e.r, Math.min(1, (bb[2] - bb[0]) / 12)),
              fillColor: c, fillOpacity: 0.25, strokeColor: c, name: lab, withLabel: true, label: { strokeColor: c } });
            if (e.value) {
              const deg = () => {
                const v = Math.abs(Math.atan2(A.Y() - B.Y(), A.X() - B.X()) - Math.atan2(Cp.Y() - B.Y(), Cp.X() - B.X())) * 180 / Math.PI;
                return v > 180 ? 360 - v : v;
              };
              a.label.setText(() => `${lab ? `${lab} = ` : ''}${fmtNum(deg())}°`);
            }
            break;
          }
          case 'tangent': {
            const f = fnOf(e.fn ?? e.f), x0 = term(e.x, 0), h = 1e-4;
            const m = () => (f(x0() + h) - f(x0() - h)) / (2 * h);
            const T = brd.create('point', [x0, () => f(x0())], { size: 5, strokeColor: c, fillColor: c,
              name: '', withLabel: !!lab, label: { strokeColor: c, offset: [10, 16] } });
            const T2 = brd.create('point', [() => x0() + 1, () => f(x0()) + m()], { visible: false, withLabel: false });
            brd.create('line', [T, T2], { strokeColor: c, strokeWidth: n(e.width, 2.5) });
            if (lab) T.label.setText(() => `${lab} = ${fmtNum(m())}`);
            break;
          }
          case 'riemann': case 'area': {
            const f = fnOf(e.fn ?? e.f);
            const N = e.t === 'area' ? () => 200 : (() => { const k = term(e.n, 4); return () => Math.max(1, Math.min(400, Math.round(k()))); })();
            const R = brd.create('riemannsum', [f, N, e.t === 'area' ? 'trapezoidal' : (e.type || 'left'), term(e.from, 0), term(e.to, 1)], {
              fillColor: c, fillOpacity: e.t === 'area' ? 0.3 : 0.28, strokeColor: c, strokeWidth: e.t === 'area' ? 0 : 1.5 });
            if (lab) readout(lab, () => R.Value(), c);
            break;
          }
          case 'text': {
            const parts = String(e.text ?? '').split(/(\{[^}]+\})/g).map((s) => {
              if (!/^\{.*\}$/.test(s)) return () => s;
              const f = term(s.slice(1, -1));
              return () => fmtNum(f());
            });
            const content = () => parts.map((p) => p()).join('').replace(/\$/g, '');
            if (e.x == null || e.y == null) {
              corner(content, c, n(e.size, 22));
            } else {
              brd.create('text', [term(e.x), term(e.y), content], { anchorX: e.align || 'left', anchorY: 'middle', strokeColor: c, fontSize: n(e.size, 22) });
            }
            break;
          }
          default: console.warn('geo: unknown element', e);
        }
      } catch (err) {
        console.warn('geo element skipped', e, err.message);
        skipped.push(String(e.f ?? e.fn ?? e.t ?? '?'));
      }
    }
    brd.unsuspendUpdate();
    if (skipped.length) failNote(wrap, `couldn't draw ${skipped.length} item${skipped.length > 1 ? 's' : ''}`, skipped.join(', '), false);

    const tweens = {};
    function animate(c) {
      const key = String(c.slider ?? Object.keys(sliders)[0]);
      const S = sliders[key];
      if (!S) return;
      const from = c.from != null ? +c.from : S.Value(), to = c.to != null ? +c.to : from;
      const ms = Math.min(30000, Math.max(50, n(c.ms, 1500)));
      const token = {};
      tweens[key] = token;
      const t0 = performance.now();
      const step = (now) => {
        if (tweens[key] !== token || !div.isConnected) return;
        const el = now - t0;
        let p = Math.min(1, el / ms);
        if (c.loop) { p = (el % ms) / ms; if (Math.floor(el / ms) % 2) p = 1 - p; }
        S.setValue(from + (to - from) * (0.5 - Math.cos(Math.PI * p) / 2));
        brd.update();
        if (c.loop || p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    return { animate };
  }

  // ------------------------------------------------------------ maps
  // World map data: world-atlas (Natural Earth, public domain) as TopoJSON.
  // Countries resolve by English name, common alias, or ISO alpha-2/alpha-3.
  const ISO = ('AF AFG 4,AX ALA 248,AL ALB 8,DZ DZA 12,AS ASM 16,AD AND 20,AO AGO 24,AI AIA 660,AQ ATA 10,' +
    'AG ATG 28,AR ARG 32,AM ARM 51,AW ABW 533,AU AUS 36,AT AUT 40,AZ AZE 31,BS BHS 44,BH BHR 48,BD BGD 50,' +
    'BB BRB 52,BY BLR 112,BE BEL 56,BZ BLZ 84,BJ BEN 204,BM BMU 60,BT BTN 64,BO BOL 68,BA BIH 70,BW BWA 72,' +
    'BR BRA 76,IO IOT 86,VG VGB 92,BN BRN 96,BG BGR 100,BF BFA 854,BI BDI 108,CV CPV 132,KH KHM 116,CM CMR 120,' +
    'CA CAN 124,KY CYM 136,CF CAF 140,TD TCD 148,CL CHL 152,CN CHN 156,CO COL 170,KM COM 174,CG COG 178,' +
    'CD COD 180,CK COK 184,CR CRI 188,CI CIV 384,HR HRV 191,CU CUB 192,CW CUW 531,CY CYP 196,CZ CZE 203,' +
    'DK DNK 208,DJ DJI 262,DM DMA 212,DO DOM 214,EC ECU 218,EG EGY 818,SV SLV 222,GQ GNQ 226,ER ERI 232,' +
    'EE EST 233,SZ SWZ 748,ET ETH 231,FK FLK 238,FO FRO 234,FJ FJI 242,FI FIN 246,FR FRA 250,PF PYF 258,' +
    'TF ATF 260,GA GAB 266,GM GMB 270,GE GEO 268,DE DEU 276,GH GHA 288,GR GRC 300,GL GRL 304,GD GRD 308,' +
    'GU GUM 316,GT GTM 320,GG GGY 831,GN GIN 324,GW GNB 624,GY GUY 328,HT HTI 332,HM HMD 334,VA VAT 336,' +
    'HN HND 340,HK HKG 344,HU HUN 348,IS ISL 352,IN IND 356,ID IDN 360,IR IRN 364,IQ IRQ 368,IE IRL 372,' +
    'IM IMN 833,IL ISR 376,IT ITA 380,JM JAM 388,JP JPN 392,JE JEY 832,JO JOR 400,KZ KAZ 398,KE KEN 404,' +
    'KI KIR 296,KP PRK 408,KR KOR 410,KW KWT 414,KG KGZ 417,LA LAO 418,LV LVA 428,LB LBN 422,LS LSO 426,' +
    'LR LBR 430,LY LBY 434,LI LIE 438,LT LTU 440,LU LUX 442,MO MAC 446,MG MDG 450,MW MWI 454,MY MYS 458,' +
    'MV MDV 462,ML MLI 466,MT MLT 470,MH MHL 584,MR MRT 478,MU MUS 480,MX MEX 484,FM FSM 583,MD MDA 498,' +
    'MC MCO 492,MN MNG 496,ME MNE 499,MS MSR 500,MA MAR 504,MZ MOZ 508,MM MMR 104,NA NAM 516,NR NRU 520,' +
    'NP NPL 524,NL NLD 528,NC NCL 540,NZ NZL 554,NI NIC 558,NE NER 562,NG NGA 566,NU NIU 570,NF NFK 574,' +
    'MK MKD 807,MP MNP 580,NO NOR 578,OM OMN 512,PK PAK 586,PW PLW 585,PS PSE 275,PA PAN 591,PG PNG 598,' +
    'PY PRY 600,PE PER 604,PH PHL 608,PN PCN 612,PL POL 616,PT PRT 620,PR PRI 630,QA QAT 634,RO ROU 642,' +
    'RU RUS 643,RW RWA 646,BL BLM 652,SH SHN 654,KN KNA 659,LC LCA 662,MF MAF 663,PM SPM 666,VC VCT 670,' +
    'WS WSM 882,SM SMR 674,ST STP 678,SA SAU 682,SN SEN 686,RS SRB 688,SC SYC 690,SL SLE 694,SG SGP 702,' +
    'SX SXM 534,SK SVK 703,SI SVN 705,SB SLB 90,SO SOM 706,ZA ZAF 710,GS SGS 239,SS SSD 728,ES ESP 724,' +
    'LK LKA 144,SD SDN 729,SR SUR 740,SE SWE 752,CH CHE 756,SY SYR 760,TW TWN 158,TJ TJK 762,TZ TZA 834,' +
    'TH THA 764,TL TLS 626,TG TGO 768,TO TON 776,TT TTO 780,TN TUN 788,TR TUR 792,TM TKM 795,TC TCA 796,' +
    'UG UGA 800,UA UKR 804,AE ARE 784,GB GBR 826,US USA 840,UY URY 858,UZ UZB 860,VU VUT 548,VE VEN 862,' +
    'VN VNM 704,VI VIR 850,WF WLF 876,EH ESH 732,YE YEM 887,ZM ZMB 894,ZW ZWE 716').split(',').reduce((m, row) => {
    const [a2, a3, num] = row.split(' ');
    const id = num.padStart(3, '0');
    m[a2] = id; m[a3] = id;
    return m;
  }, { XK: 'Kosovo', XKX: 'Kosovo' });
  const ALIASES = {
    'United States of America': 'usa,us,united states,america,the united states',
    'United Kingdom': 'uk,britain,great britain,england,scotland,wales,northern ireland',
    'Russia': 'russian federation', 'Czechia': 'czech republic', 'eSwatini': 'swaziland,eswatini',
    'Dem. Rep. Congo': 'dr congo,drc,democratic republic of the congo,congo kinshasa,zaire',
    'Congo': 'republic of the congo,congo brazzaville', "Côte d'Ivoire": 'ivory coast',
    'South Korea': 'korea,republic of korea', 'North Korea': 'dprk', 'Macedonia': 'north macedonia',
    'Myanmar': 'burma', 'United Arab Emirates': 'uae,emirates', 'Bosnia and Herz.': 'bosnia,bosnia and herzegovina',
    'Timor-Leste': 'east timor', 'Central African Rep.': 'car,central african republic',
    'Dominican Rep.': 'dominican republic', 'Eq. Guinea': 'equatorial guinea', 'S. Sudan': 'south sudan',
    'W. Sahara': 'western sahara', 'Falkland Is.': 'falklands,falkland islands', 'Solomon Is.': 'solomon islands',
    'Palestine': 'state of palestine,palestinian territories,west bank,gaza', 'Vatican': 'vatican city,holy see',
    'Cabo Verde': 'cape verde', 'Netherlands': 'holland', 'Iran': 'persia', 'Turkey': 'turkiye',
    'Laos': 'lao pdr', 'Vietnam': 'viet nam', 'Macao': 'macau', 'Saudi Arabia': 'ksa,kingdom of saudi arabia',
    'Taiwan': 'republic of china', 'China': "people's republic of china,prc",
  };
  const SHORT = { 'United States of America': 'United States', 'Dem. Rep. Congo': 'DR Congo', 'Bosnia and Herz.': 'Bosnia' };
  const REGIONS = {
    world: null, europe: [-25, 34, 45, 71], africa: [-19, -36, 53, 38], asia: [26, -11, 146, 56],
    'middle east': [25, 12, 63, 42], 'arabian peninsula': [34, 12, 60, 33], gulf: [44, 21, 60, 31],
    levant: [33, 29, 43, 38], 'north africa': [-18, 15, 37, 38], 'north america': [-170, 7, -50, 75],
    'central america': [-93, 7, -77, 19], caribbean: [-86, 9, -59, 27], 'south america': [-82, -56, -34, 13],
    oceania: [110, -48, 180, 0], 'east asia': [95, 18, 146, 54], 'south asia': [60, 5, 98, 37],
    'southeast asia': [92, -11, 142, 24], 'central asia': [46, 35, 88, 56], mediterranean: [-7, 29, 37, 47],
    scandinavia: [4, 54, 32, 71], balkans: [13, 39, 30, 47], 'indian ocean': [30, -40, 115, 25],
  };
  const ABBR = { 'rep.': 'republic', 'dem.': 'democratic', 'is.': 'islands', 'i.': 'island', 'eq.': 'equatorial',
    's.': 'south', 'n.': 'north', 'w.': 'western', 'fr.': 'french', 'st.': 'saint', 'herz.': 'herzegovina',
    'br.': 'british', 'ter.': 'territory', 'geo.': 'georgia', 'u.s.': 'us', 'st-': 'saint ' };
  const keyOf = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').split(/\s+/).map((w) => ABBR[w] || w).join(' ')
    .replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');

  const loadMapLib = () => once('maplib', async () => {
    await loadScript('d3-array/dist/d3-array.min.js');
    await loadScript('d3-geo/dist/d3-geo.min.js');
    await loadScript('topojson-client/dist/topojson-client.min.js');
  });
  const loadWorld = (res) => once(`world:${res}`, async () => {
    await loadMapLib();
    const topo = await loadJson(`world-atlas/countries-${res}.json`);
    const features = topojson.feature(topo, topo.objects.countries).features;
    const byKey = new Map();
    const add = (k, f) => { if (!k) return; if (!byKey.has(k)) byKey.set(k, []); if (!byKey.get(k).includes(f)) byKey.get(k).push(f); };
    for (const f of features) {
      const name = f.properties.name;
      add(keyOf(name), f);
      add(`#${f.id}`, f);
      for (const a of (ALIASES[name] || '').split(',')) add(keyOf(a), f);
    }
    return { features, byKey, res };
  });
  function findCountry(world, q) {
    const s = String(q || '').trim();
    if (!s) return [];
    const code = ISO[s.toUpperCase()];
    if (/^[A-Za-z]{2,3}$/.test(s) && code) {
      const hit = world.byKey.get(/^\d+$/.test(code) ? `#${code}` : keyOf(code));
      if (hit) return hit;
    }
    const k = keyOf(s);
    if (world.byKey.has(k)) return world.byKey.get(k);
    const near = world.features.filter((f) => keyOf(f.properties.name).startsWith(k) && k.length >= 4);
    return near.length ? [near.sort((a, b) => a.properties.name.length - b.properties.name.length)[0]] : [];
  }
  // The parts of a country that matter for framing it: its biggest polygon
  // and the ones near it (France without French Guiana, the US without Alaska).
  function mainParts(f) {
    const g = f.geometry;
    if (!g || g.type !== 'MultiPolygon') return g;
    const polys = g.coordinates.map((c) => ({ c, f: { type: 'Polygon', coordinates: c } }));
    polys.forEach((p) => { p.a = d3.geoArea(p.f); p.ctr = d3.geoCentroid(p.f); });
    const big = polys.reduce((a, b) => (b.a > a.a ? b : a));
    const keep = polys.filter((p) => p === big || (p.a > big.a * 0.04 && d3.geoDistance(p.ctr, big.ctr) < 0.45));
    return { type: 'MultiPolygon', coordinates: keep.map((p) => p.c) };
  }
  const isLonLat = (v) => Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
  const isBBox = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number');
  function bboxPoints([w, s, e, n]) {
    if (e < w) e += 360;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
      const lon = w + ((e - w) * i) / 8, lat = s + ((n - s) * i) / 8;
      pts.push([lon, s], [lon, n], [w, lat], [e, lat]);
    }
    return { type: 'MultiPoint', coordinates: pts.map(([lo, la]) => [lo > 180 ? lo - 360 : lo, la]) };
  }

  // ------------------------------------------------------------ music
  // Playback without a soundfont download: abcjs times the notes and
  // highlights them; a small WebAudio voice sounds each pitch.
  function playAbc(visual, inner) {
    visual.setUpAudio();   // fills in each note's midiPitches
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = AC ? new AC() : null;
    const out = ac && ac.createGain();
    if (out) { out.gain.value = 0.16; out.connect(ac.destination); }
    const meter = (visual.getMeterFraction && visual.getMeterFraction()) || { num: 4, den: 4 };
    const tone = (pitch, sec) => {
      if (!ac || ac.state === 'closed' || !Number.isFinite(pitch)) return;
      const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = 440 * Math.pow(2, (pitch - 69) / 12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.12, sec * 0.95));
      o.connect(g); g.connect(out);
      o.start(t); o.stop(t + Math.max(0.15, sec) + 0.05);
    };
    let lit = [];
    const unlight = () => { for (const el of lit) el.classList.remove('sqx-abc-hl'); lit = []; };
    const timer = new ABCJS.TimingCallbacks(visual, {
      eventCallback: (ev) => {
        unlight();
        if (!ev || !inner.isConnected) return;
        lit = (ev.elements || []).flat().filter(Boolean);
        for (const el of lit) el.classList.add('sqx-abc-hl');
        const whole = (ev.millisecondsPerMeasure || 2000) / ((meter.num / meter.den) || 1);
        try { for (const p of ev.midiPitches || []) tone(p.pitch, (p.duration * whole) / 1000); } catch { /* no audio device */ }
      },
    });
    timer.start();
    const stop = () => { try { timer.stop(); } catch { /* done */ } unlight(); if (ac) ac.close(); clearInterval(watch); };
    const watch = setInterval(() => { if (!inner.isConnected) stop(); }, 400);
    return { stop };
  }

  // ------------------------------------------------------------ python
  // One warm Pyodide worker, shared by every trace, in a hidden sandbox
  // iframe outside the board. It's dropped when a job runs too long (and
  // restarted on the next trace), and after 10 idle minutes to free memory.
  let pyHost = null, pyJob = 0;
  function pythonHost() {
    if (pyHost && !pyHost.dead) return pyHost;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
    document.body.appendChild(iframe);
    const host = { jobs: new Map(), dead: false, idle: null };
    const spec = Promise.all([
      loadText('./py_worker.js'), loadText('pyodide/pyodide.js'), loadText('pyodide/pyodide.asm.mjs'),
      loadBin('pyodide/pyodide.asm.wasm'), loadBin('pyodide/python_stdlib.zip'), loadJson('pyodide/pyodide-lock.json'),
    ]).then(([src, loader, asm, wasm, stdlib, lock]) => ({
      src, limit: 60000, maxLimit: 60000,
      payload: { loader, asm, wasm, stdlib, lock: { info: lock.info, packages: {} } },
    }));
    const die = (why) => {
      host.dead = true;
      for (const j of host.jobs.values()) j.reject(new Error(why));
      host.jobs.clear();
      setTimeout(() => iframe.remove(), 0);
    };
    host.sb = sandbox(iframe, spec, (m) => {
      if (m.type === 'result') {
        const j = host.jobs.get(m.job);
        if (j) { host.jobs.delete(m.job); j.resolve(m); }
      } else if (m.type === 'error') die(String(m.message || 'python failed'));
      else if (m.type === 'dead') die(m.why === 'timeout' ? 'it ran too long' : String(m.why));
    });
    host.kill = () => { host.sb.kill(); die('stopped'); };
    pyHost = host;
    return host;
  }
  function runPython(job) {
    const host = pythonHost();
    clearTimeout(host.idle);
    host.idle = setTimeout(() => { if (!host.jobs.size) host.kill(); }, 10 * 60 * 1000);
    return new Promise((resolve, reject) => {
      const id = ++pyJob;
      host.jobs.set(id, { resolve, reject });
      host.sb.post({ type: 'msg', data: { ...job, job: id } });
    });
  }

  // The trace view: code with the current line marked, the variables, the output.
  function traceView(wrap, r, code) {
    const lines = code.replace(/\t/g, '    ').replace(/\s+$/, '').split('\n');
    const W = r.w, H = r.h, statusH = 30, gap = 12;
    const codeW = Math.round(W * 0.6), sideW = W - codeW - gap;
    const longest = Math.max(8, ...lines.map((l) => l.length));
    const size = Math.max(13, Math.min(24, Math.floor((H - statusH - 16) / (lines.length * 1.5)), Math.floor((codeW - 64) / (longest * 0.6))));
    wrap.innerHTML = '';
    const codeEl = document.createElement('div');
    codeEl.className = 'tr-code';
    Object.assign(codeEl.style, { width: `${codeW}px`, height: `${H - statusH}px`, fontSize: `${size}px` });
    const lineEls = lines.map((l, i) => {
      const row = document.createElement('div');
      row.className = 'tr-line';
      row.innerHTML = `<span class="tr-no">${i + 1}</span><span class="tr-src">${escapeHtml(l) || ' '}</span><span class="tr-badge"></span>`;
      codeEl.appendChild(row);
      return row;
    });
    const side = document.createElement('div');
    side.className = 'tr-side';
    Object.assign(side.style, { left: `${codeW + gap}px`, width: `${sideW}px`, height: `${H - statusH}px`,
      fontSize: `${Math.max(16, Math.min(21, size))}px` });
    side.innerHTML = '<div class="tr-vars"></div><div class="tr-outwrap" style="display:none"><div class="tr-h">output</div><pre class="tr-out"></pre></div>';
    const status = document.createElement('div');
    status.className = 'tr-status';
    status.textContent = 'running the code…';
    wrap.append(codeEl, side, status);
    return { codeEl, lineEls, vars: side.querySelector('.tr-vars'), out: side.querySelector('.tr-out'),
      outWrap: side.querySelector('.tr-outwrap'), status, H: H - statusH };
  }

  Object.assign(Board.prototype, {
    // {"op":"sim","id":"<id>","x":40,"y":95,"w":920,"h":440,"code":"<JS>","caption":"<text>"}
    op_sim(cmd) {
      const r = placeRect(this, cmd, 920, 440);
      const wrap = boxEl(r, 'sqx-sim');
      this.addHtml(wrap);
      const rec = this.register(cmd.id, { nodes: [wrap], bbox: r });
      const capH = caption(wrap, cmd.caption);
      const w = r.w, h = r.h - capH, k = pixelScale(this);
      const code = String(cmd.code || '');
      const iframe = document.createElement('iframe');
      Object.assign(iframe.style, { width: `${w}px`, height: `${h}px` });
      wrap.appendChild(iframe);
      let drew = false;
      const fail = (why) => {
        console.warn('sim failed', cmd.id, why);
        failNote(wrap, 'simulation failed', why, !drew);
      };
      const spec = Promise.all([
        loadText('./sim_worker.js'),
        usesMatter(code) ? loadText('matter-js/build/matter.min.js') : null,
      ]).then(([src, matter]) => ({
        src, canvas: { w, h, k }, limit: 3000, maxLimit: 3000, payload: { code, w, h, k, matter },
      }));
      rec.sim = sandbox(iframe, spec, (m) => {
        if (m.type === 'drew') drew = true;
        else if (m.type === 'error') fail(String(m.message || 'error'));
        else if (m.type === 'dead' && m.why === 'timeout') fail('it stopped responding (an endless loop?)');
      });
    },

    // {"op":"simsend","id":"<id>","data":<any>}: on(fn) / await next() in the sim receive it.
    op_simsend(cmd) {
      const rec = this.els.get(cmd.id || cmd.target);
      if (rec && rec.sim) rec.sim.post({ type: 'msg', data: cmd.data ?? null });
    },

    // {"op":"geo","id":"<id>","x":..,"y":..,"w":..,"h":..,"xmin":-5,"xmax":5,"ymin":-5,"ymax":5,
    //  "els":[{"t":"slider","id":"a","min":-2,"max":2,"value":1},{"t":"fn","id":"f","f":"a*x^2"},...]}
    op_geo(cmd) {
      const r = placeRect(this, cmd, 560, 420);
      const wrap = boxEl(r, 'sqx-geo');
      this.addHtml(wrap);
      const rec = this.register(cmd.id, { nodes: [wrap], bbox: r });
      const pending = [];
      rec.geo = { pending, ready: null };
      rec.geo.ready = loadJXG().then(() => {
        if (!wrap.isConnected) return;
        const g = buildGeo(wrap, r, cmd);
        rec.geo.anim = g.animate;
        for (const c of pending.splice(0)) g.animate(c);
      }).catch((e) => { console.warn('geo failed', e); failNote(wrap, 'graph failed', e.message); });
    },

    // {"op":"map","id":"<id>","x":..,"y":..,"w":..,"h":..,"fit":"<region|country|[w,s,e,n]|[names]>",
    //  "countries":{"<name or ISO>":"<colour>"},"labels":true,"points":[[lon,lat,"<label>"]],
    //  "routes":[{"from":[lon,lat],"to":"<country>","animate":true}]}
    op_map(cmd) {
      const r = placeRect(this, cmd, 920, 460);
      const outer = document.createElementNS(SVGNS, 'g');
      outer.setAttribute('clip-path', this.rectClip(r));
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${r.x},${r.y})`);
      outer.appendChild(g);
      this.svg.appendChild(outer);
      const holder = boxEl(r, 'sqx-map');
      this.addHtml(holder);
      const rec = this.register(cmd.id, { nodes: [outer, holder], bbox: r });
      const m = { pending: [], add: null };
      rec.map = m;
      const W = r.w, H = r.h;
      const board = this;
      (async () => {
        let world = await loadWorld('110m');
        const fitSpec = cmd.fit ?? cmd.region ?? null;
        const names = [
          ...Object.keys(cmd.countries || {}),
          ...(typeof fitSpec === 'string' ? [fitSpec] : Array.isArray(fitSpec) && !isBBox(fitSpec) ? fitSpec : []),
        ].filter((s) => typeof s === 'string' && !(s.toLowerCase() in REGIONS));
        // Frame: a bbox, a named region, one or more countries, or the world.
        const fitOf = (wd) => {
          if (isBBox(fitSpec)) return bboxPoints(fitSpec);
          const list = typeof fitSpec === 'string' ? [fitSpec] : Array.isArray(fitSpec) ? fitSpec : [];
          if (list.length === 1 && String(list[0]).toLowerCase() in REGIONS) {
            const b = REGIONS[String(list[0]).toLowerCase()];
            return b ? bboxPoints(b) : null;
          }
          const geoms = list.flatMap((q) => findCountry(wd, q)).map(mainParts).filter(Boolean);
          return geoms.length ? { type: 'GeometryCollection', geometries: geoms } : null;
        };
        let fit = fitOf(world);
        const span = (b) => { let s = b[1][0] - b[0][0]; if (s < 0) s += 360; return [s, b[1][1] - b[0][1]]; };
        let bounds = fit ? d3.geoBounds(fit) : null;
        const small = bounds && span(bounds)[0] < 50 && span(bounds)[1] < 40;
        if (small || names.some((q) => !findCountry(world, q).length)) {
          world = await loadWorld('50m');
          fit = fitOf(world);
          bounds = fit ? d3.geoBounds(fit) : null;
        }
        if (!holder.isConnected) return;
        const regional = bounds && span(bounds)[0] <= 150;
        const proj = regional ? d3.geoMercator() : d3.geoNaturalEarth1();
        if (regional) {
          let c = (bounds[0][0] + bounds[1][0]) / 2;
          if (bounds[1][0] < bounds[0][0]) c += 180;
          proj.rotate([-c, 0]);
        }
        const pad = 14;
        proj.fitExtent([[pad, pad], [W - pad, H - pad]], regional ? fit : bboxPoints([-179.9, -57, 179.9, 83]));
        proj.clipExtent([[-40, -40], [W + 40, H + 40]]);
        const path = d3.geoPath(proj);
        const mk = (tag, attrs, parent) => {
          const n = document.createElementNS(SVGNS, tag);
          for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
          if (parent) parent.appendChild(n);
          return n;
        };
        // Base: sea, graticule, every country's outline. Static (fades in).
        const base = mk('g', {});
        if (regional) mk('rect', { x: 0, y: 0, width: W, height: H, rx: 10, fill: '#6CB6FF', 'fill-opacity': 0.05, stroke: 'none' }, base);
        else mk('path', { d: path({ type: 'Sphere' }) || '', fill: '#6CB6FF', 'fill-opacity': 0.05, stroke: '#8B93A7', 'stroke-opacity': 0.35, 'stroke-width': 1 }, base);
        mk('path', { d: path(d3.geoGraticule10()) || '', fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.05, 'stroke-width': 1 }, base);
        let land = '';
        for (const f of world.features) land += path(f) || '';
        mk('path', { d: land, fill: '#EEF1F7', 'fill-opacity': 0.08, stroke: '#8B93A7', 'stroke-opacity': 0.6, 'stroke-width': 0.8, 'stroke-linejoin': 'round' }, base);
        for (const n of base.querySelectorAll('path')) n.dataset.static = '1';
        g.appendChild(base);
        board.animate(base);

        let routeN = 0;
        const placed = [];
        // Labels never sit on each other: each tries a few nudges up and down.
        const label = (text, x, y, c, centred) => {
          const el = document.createElement('div');
          el.className = 'sqx-maplabel';
          el.innerHTML = richText(text);
          el.style.color = color(c || 'ink');
          holder.appendChild(el);
          const w = el.offsetWidth, h = el.offsetHeight;
          let left = centred ? x - w / 2 : x + 12 + w > W - 6 ? x - 12 - w : x + 12;
          left = Math.max(4, Math.min(W - w - 4, left));
          let top = y - h / 2;
          for (const dy of [0, -h, h, -2 * h, 2 * h, -3 * h, 3 * h]) {
            const box = { x: left, y: y - h / 2 + dy, w, h };
            if (!placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) { top = box.y; break; }
          }
          placed.push({ x: left, y: top, w, h });
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          return el;
        };
        const center = (q) => {
          if (isLonLat(q)) return q;
          const f = findCountry(world, q)[0];
          return f ? d3.geoCentroid({ type: 'Feature', geometry: mainParts(f) }) : null;
        };
        const missing = [];
        const draw = (c) => {
          const layer = mk('g', {});
          const labels = [];
          // Highlighted countries: a hand-drawn outline over a tinted fill.
          for (const [q, v] of Object.entries(c.countries || {})) {
            const feats = findCountry(world, q);
            if (!feats.length) { missing.push(q); continue; }
            const col = color(typeof v === 'string' ? v : (v && v.color) || 'amber');
            for (const f of feats) {
              const d = path(f);
              if (d) layer.appendChild(board.rc.path(d, { stroke: col, strokeWidth: 2.2, roughness: 0.35, bowing: 0.3,
                fill: `${col}59`, fillStyle: 'solid', disableMultiStroke: true }));
            }
            const main = { type: 'Feature', geometry: mainParts(feats[0]) };
            const ctr = path.centroid(main);
            // A country too small to see at this zoom gets a ring around it.
            if (ctr.every(Number.isFinite) && path.area(main) < 90) {
              layer.appendChild(board.rc.circle(ctr[0], ctr[1], 22, { stroke: col, strokeWidth: 2.5, roughness: 0.5 }));
            }
            // Codes are labelled with the country's name.
            const named = /^[A-Z]{2,3}$/.test(q) ? SHORT[feats[0].properties.name] || feats[0].properties.name : q;
            const text = v && typeof v === 'object' && v.label != null ? v.label : c.labels ? named : null;
            if (text && ctr.every(Number.isFinite)) labels.push([text, ctr[0], ctr[1], 'ink', true]);
          }
          // Routes: great-circle lines that draw themselves; a dot can travel them.
          for (const rt of [].concat(c.routes || [])) {
            const stops = (Array.isArray(rt) ? rt : [rt.from, ...(rt.via || []), rt.to]).map(center).filter(Boolean);
            if (stops.length < 2) continue;
            const col = color(rt.color || 'amber');
            const d = path({ type: 'LineString', coordinates: stops });
            if (!d) continue;
            const id = `sqxroute${++routeN}_${Math.random().toString(36).slice(2, 7)}`;
            const line = mk('path', { id, d, fill: 'none', stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round' }, layer);
            if (rt.dashed) { line.setAttribute('stroke-dasharray', '9 8'); line.dataset.static = '1'; }
            const a = stops[stops.length - 2], b = stops[stops.length - 1];
            const p1 = proj(d3.geoInterpolate(a, b)(0.97)), p2 = proj(b);
            if (p1 && p2) {
              const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), L = 14;
              mk('polygon', { points: [p2, [p2[0] - L * Math.cos(ang - 0.45), p2[1] - L * Math.sin(ang - 0.45)],
                [p2[0] - L * Math.cos(ang + 0.45), p2[1] - L * Math.sin(ang + 0.45)]].map((p) => p.join(',')).join(' '),
              fill: col, stroke: 'none' }, layer);
            }
            if (rt.animate) {
              const once = rt.animate === 'once';
              const dot = mk('circle', { r: 7, fill: col, stroke: '#0d0f16', 'stroke-width': 2, opacity: 0 }, layer);
              dot.dataset.static = '1';
              const len = (() => { try { return line.getTotalLength(); } catch { return 300; } })();
              const am = mk('animateMotion', { dur: `${Math.min(7, Math.max(1.4, len / 160))}s`, repeatCount: once ? '1' : 'indefinite',
                fill: 'freeze', begin: 'indefinite' }, dot);
              mk('mpath', {}, am).setAttribute('href', `#${id}`);
              // Starts once the line has drawn itself (begin times are relative to page load).
              setTimeout(() => { if (dot.isConnected) { dot.setAttribute('opacity', 1); am.beginElement(); } }, 800);
            }
            if (rt.label) {
              const mid = proj(d3.geoInterpolate(stops[0], stops[stops.length - 1])(0.5));
              if (mid) labels.push([rt.label, mid[0], mid[1] - 30, rt.color || 'amber', true]);
            }
          }
          // Points with labels.
          for (const p of [].concat(c.points || [])) {
            const o = isLonLat(p) ? { lon: p[0], lat: p[1], label: p[2], color: p[3] } : p && typeof p === 'object' ? p : null;
            const xy = o && proj([+o.lon, +o.lat]);
            if (!xy || !xy.every(Number.isFinite)) continue;
            const col = color(o.color || 'red');
            layer.appendChild(board.rc.circle(xy[0], xy[1], 13, { stroke: col, fill: col, fillStyle: 'solid', roughness: 0.3 }));
            if (o.label) labels.push([o.label, xy[0], xy[1] - 14, o.color || 'ink', false]);
          }
          g.appendChild(layer);
          board.animate(layer);
          for (const l of labels) label(...l);
          if (missing.length) failNote(holder, 'not on the map:', missing.join(', '), false);
        };
        draw(cmd);
        m.add = draw;
        for (const c of m.pending.splice(0)) draw(c);
      })().catch((e) => { console.warn('map failed', e); failNote(holder, 'map failed', e.message); });
    },

    // {"op":"mapadd","id":"<map id>","countries":{...},"points":[...],"routes":[...]}: build a map up.
    op_mapadd(cmd) {
      const m = this.els.get(cmd.id || cmd.target)?.map;
      if (!m) return;
      if (m.add) m.add(cmd); else m.pending.push(cmd);
    },

    // {"op":"music","id":"<id>","abc":"X:1\nM:4/4\nL:1/4\nK:C\nC D E F|G2 G2|]","play":true,"caption":"<text>"}
    op_music(cmd) {
      const r = placeRect(this, cmd, 920, 240);
      const wrap = boxEl(r, 'sqx-music');
      this.addHtml(wrap);
      const rec = this.register(cmd.id, { nodes: [wrap], bbox: r });
      const capH = caption(wrap, cmd.caption);
      const W = r.w, H = r.h - capH;
      const inner = document.createElement('div');
      inner.className = 'sqx-abc';
      Object.assign(inner.style, { width: `${W}px`, height: `${H}px` });
      wrap.appendChild(inner);
      loadScript('abcjs/dist/abcjs-basic-min.js').then(() => {
        if (!wrap.isConnected) return;
        const abc = String(cmd.abc || cmd.notation || '').replace(/\\n/g, '\n');
        const font = (n, extra = '') => `"Segoe UI" ${n}${extra}`;
        const format = { titlefont: font(22, ' bold'), subtitlefont: font(18), composerfont: font(15), tempofont: font(15, ' bold'),
          gchordfont: font(17), annotationfont: font(15), vocalfont: font(16), wordsfont: font(16), partsfont: font(15),
          voicefont: font(15, ' bold'), infofont: font(14) };
        // Render, see how tall the music is, then re-render with a staff width
        // that lets it fill the box (notes at most 2.2x their normal size).
        const render = (sw) => {
          const [v] = ABCJS.renderAbc(inner, abc, { add_classes: true, responsive: 'resize', staffwidth: sw,
            paddingtop: 6, paddingbottom: 6, paddingleft: 10, paddingright: 10, foregroundColor: COLORS.ink,
            selectionColor: COLORS.amber, format });
          const svg = inner.querySelector('svg');
          const vb = svg && svg.viewBox && svg.viewBox.baseVal;
          return { v, svg, vw: vb ? vb.width : 0, vh: vb ? vb.height : 0 };
        };
        let out = render(500);
        if (!out.svg || !out.vh || !out.v || !out.v.lines || !out.v.lines.length) throw new Error('nothing to draw');
        out = render(Math.max(150, W / Math.min(2.2, H / out.vh) - 20));
        const sc = Math.min(W / out.vw, H / out.vh);
        Object.assign(inner.style, { display: 'block', paddingBottom: '0', width: `${W}px`, height: `${H}px`, position: 'absolute' });
        Object.assign(out.svg.style, { position: 'absolute', width: `${out.vw * sc}px`, height: `${out.vh * sc}px`,
          left: `${(W - out.vw * sc) / 2}px`, top: `${(H - out.vh * sc) / 2}px` });
        const visual = out.v;
        if (visual.warnings && visual.warnings.length) console.warn('abc warnings', visual.warnings);
        if (cmd.play) rec.music = playAbc(visual, inner);
      }).catch((e) => { console.warn('music failed', e); failNote(wrap, "couldn't draw the music", e.message); });
    },

    // {"op":"molecule","id":"<id>","smiles":"CN1C=NC2=C1C(=O)N(C(=O)N2C)C","caption":"<text>"}
    op_molecule(cmd) {
      const r = placeRect(this, cmd, 420, 320);
      const wrap = boxEl(r, 'sqx-mol');
      this.addHtml(wrap);
      this.register(cmd.id, { nodes: [wrap], bbox: r });
      const capH = caption(wrap, cmd.caption);
      const W = r.w, H = r.h - capH;
      loadScript('smiles-drawer/dist/smiles-drawer.min.js').then(() => new Promise((resolve, reject) => {
        if (!wrap.isConnected) { resolve(); return; }
        const svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('width', W);
        svg.setAttribute('height', H);
        svg.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:visible`;
        wrap.appendChild(svg);
        const drawer = new SmilesDrawer.SvgDrawer({
          width: W, height: H, bondThickness: 1.4, bondLength: 30, fontSizeLarge: 9, fontSizeSmall: 6, padding: 6,
          fontFamily: '"Segoe UI", system-ui, sans-serif', compactDrawing: false,
          themes: { sq: { C: COLORS.ink, O: COLORS.red, N: COLORS.blue, F: COLORS.green, CL: COLORS.green,
            BR: '#E0925A', I: COLORS.purple, P: COLORS.amber, S: COLORS.amber, B: COLORS.amber, SI: COLORS.amber,
            H: COLORS.muted, BACKGROUND: 'transparent' } },
        });
        const smiles = String(cmd.smiles || '').trim();
        // Layout runs on this page's thread, so keep it to molecules a board can show.
        if (smiles.length > 300) { reject(new Error('too big for the board')); return; }
        SmilesDrawer.parse(smiles, (tree) => {
          try {
            drawer.draw(tree, svg, 'sq');
            // Frame the drawing tightly, never blown up past 3x.
            const b = svg.getBBox();
            const pad = 8, s = Math.min(3, (W - 2 * pad) / b.width, (H - 2 * pad) / b.height);
            const vw = W / s, vh = H / s;
            svg.setAttribute('viewBox', `${b.x + b.width / 2 - vw / 2} ${b.y + b.height / 2 - vh / 2} ${vw} ${vh}`);
            svg.style.width = `${W}px`; svg.style.height = `${H}px`;
            resolve();
          } catch (e) { reject(e); }
        }, (err) => reject(new Error(String(err && err.message || err))));
      })).catch((e) => { console.warn('molecule failed', e); failNote(wrap, "couldn't draw that molecule", e.message); });
    },

    // {"op":"trace","id":"<id>","x":..,"y":..,"w":..,"h":..,"code":"<python>","play":900,"input":["<line>"]}
    // Real execution (Pyodide, sandboxed); or "steps":[{"line":n,"vars":{...},"out":"..."}] for any language.
    op_trace(cmd) {
      const r = placeRect(this, cmd, 920, 420);
      const wrap = boxEl(r, 'sqx-trace');
      this.addHtml(wrap);
      const rec = this.register(cmd.id, { nodes: [wrap], bbox: r });
      const v = traceView(wrap, r, String(cmd.code || ''));
      const st = { steps: null, output: '', i: -1, queue: [], timer: null, error: null, errline: null };
      rec.trace = st;
      const fmtVars = (step, prev) => {
        const sec = (title, vars, old) => {
          const keys = Object.keys(vars || {});
          if (!keys.length) return '';
          return `<div class="tr-h">${escapeHtml(title)}</div><table>${keys.map((k) => {
            const changed = old && old[k] !== vars[k];
            return `<tr class="${changed ? 'chg' : ''}"><td class="k">${escapeHtml(k)}</td><td class="v">${escapeHtml(vars[k])}</td></tr>`;
          }).join('')}</table>`;
        };
        const inFn = step.fn ? sec(`in ${step.fn}()`, step.l, prev && prev.fn === step.fn ? prev.l : null) : '';
        return inFn + sec(step.fn ? 'globals' : 'variables', step.g, prev ? prev.g : null) || '<div class="tr-h">no variables yet</div>';
      };
      const show = (i) => {
        if (!st.steps || !st.steps.length || !wrap.isConnected) return;
        i = Math.max(0, Math.min(st.steps.length - 1, i));
        const step = st.steps[i], prev = i > 0 ? st.steps[i - 1] : null;
        st.i = i;
        v.lineEls.forEach((el) => { el.classList.remove('cur', 'err', 'ret'); el.querySelector('.tr-badge').textContent = ''; });
        const el = step.line ? v.lineEls[step.line - 1] : null;
        if (el) {
          el.classList.add(step.end && st.error ? 'err' : 'cur');
          if (step.ret != null) { el.classList.add('ret'); el.querySelector('.tr-badge').textContent = `↩ ${step.ret}`; }
          const top = el.offsetTop - v.H / 2 + el.offsetHeight / 2;
          v.codeEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }
        v.vars.innerHTML = fmtVars(step, prev);
        const out = step.out != null ? String(step.out) : st.output.slice(0, step.o || 0);
        v.out.textContent = out.split('\n').slice(-10).join('\n');
        v.outWrap.style.display = out || st.output ? '' : 'none';
        v.status.className = `tr-status${step.end && st.error ? ' bad' : step.end ? ' ok' : ''}`;
        v.status.textContent = step.end
          ? (st.error ? st.error : `finished${st.truncated ? ' (stopped after the step limit)' : ''}`)
          : `step ${i + 1} of ${st.steps.length - (st.steps[st.steps.length - 1].end ? 1 : 0)}`;
      };
      const stopPlay = () => { clearInterval(st.timer); st.timer = null; };
      const play = (ms) => {
        stopPlay();
        if (!(+ms > 0)) return;
        st.timer = setInterval(() => {
          if (!wrap.isConnected || st.i >= st.steps.length - 1) { stopPlay(); return; }
          show(st.i + 1);
        }, Math.max(150, +ms));
      };
      st.go = (c) => {
        if (!st.steps) { st.queue.push(c); return; }
        if (c.play != null) play(c.play);
        if (c.step != null) show(Math.round(+c.step) - 1);
        else if (c.line != null) {
          const j = st.steps.findIndex((s, k) => k > st.i && s.line === +c.line);
          show(j >= 0 ? j : st.i + 1);
        } else if (c.play == null) show(st.i + 1);
      };
      const ready = (res) => {
        if (!wrap.isConnected) return;
        st.steps = res.steps || [];
        st.output = res.output || '';
        st.error = res.error || null;
        st.errline = res.errline || null;
        st.truncated = !!res.truncated;
        if (!st.steps.length) {
          if (st.errline && v.lineEls[st.errline - 1]) v.lineEls[st.errline - 1].classList.add('err');
          v.status.className = 'tr-status bad';
          v.status.textContent = st.error || 'nothing ran';
          return;
        }
        show(0);
        if (cmd.play) play(cmd.play);
        for (const c of st.queue.splice(0)) st.go(c);
      };
      if (Array.isArray(cmd.steps)) {
        ready({ steps: cmd.steps.filter((s) => s && typeof s === 'object').map((s) => ({
          line: +s.line || null, g: s.vars || s.g || {}, out: s.out, ret: s.ret, fn: s.fn, l: s.locals })) });
        return;
      }
      runPython({ code: String(cmd.code || ''), stdin: [].concat(cmd.input || []), maxSteps: +cmd.max || 400, ms: 6000 })
        .then(ready)
        .catch((e) => {
          console.warn('trace failed', e);
          if (!wrap.isConnected) return;
          v.status.className = 'tr-status bad';
          v.status.textContent = `couldn't run it: ${e.message}`;
        });
    },

    // {"op":"tstep","id":"<trace id>","step":3} or "line":4 (next time it reaches line 4), nothing = next step, "play":<ms>
    op_tstep(cmd) {
      const st = this.els.get(cmd.id || cmd.target)?.trace;
      if (st && st.go) st.go(cmd);
    },

    // {"op":"geoset","id":"<geo id>","slider":"<slider id>","to":2,"ms":2000} (+ "from", "loop":true)
    op_geoset(cmd) {
      const g = this.els.get(cmd.id || cmd.target)?.geo;
      if (!g) return;
      if (g.anim) g.anim(cmd); else g.pending.push(cmd);
    },
  });
})();
