// Kids props: a library of ready-made, hand-built SVG pictures the tutor
// calls by name with a few parameters, instead of having an illustrator draw
// a teacher or a place-value chart from scratch on every turn (slow, and the
// faces came out odd). Same world as board_kids.js: the mascot's candy
// palette, ink #2A2140 for faces and lines, die-cut white outlines.
//
//   {"op":"prop","id":"<id>","name":"<prop>",...params,"x":..,"y":..,"w":..}
//   {"op":"propset","id":"<id>",...}   animates a change (hands move, a ten
//                                      is carried, a coin drops, a slice fills)
//
// Every prop renders at once from local code (no network), so the voice can
// start the moment it lands. Motion always shows the idea; nothing idles.
// Arabic boards: labels in Arabic, Eastern Arabic digits, reading order
// right to left where order means something (numbers themselves stay
// most-significant-digit first, as in Saudi textbooks).
// Extends Board.prototype; loaded after board_kids.js.
(() => {
  const isKids = () => document.body.classList.contains('kids');
  const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
  const num = (v, d) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : d);
  const int = (v, d) => Math.round(num(v, d));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => escapeHtml(s ?? '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const AR = '٠١٢٣٤٥٦٧٨٩';
  const dig = (n, rtl) => (rtl ? String(n).replace(/\d/g, (d) => AR[d]) : String(n));
  const INK = '#2A2140';
  const C = {
    red: '#FF6B8B', yellow: '#FFC857', green: '#5BE49B', blue: '#6CB6FF', purple: '#C79BFF',
    orange: '#FF9F5A', cyan: '#7FE3FF', pink: '#FF8FB8', white: '#FFFFFF', ink: INK,
    amber: '#FFC857', brown: '#B9784A',
  };
  const col = (c, d) => C[c] || (/^#[0-9a-f]{6}$/i.test(c || '') ? c : d || C.blue);
  const shade = (hex, k) => {   // k < 0 darkens, k > 0 lightens
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  };
  const FONT = '"Baloo Bhaijaan 2", "Segoe UI", Tahoma, sans-serif';
  const EMOJI = '"Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  try { document.fonts.load('800 40px "Baloo Bhaijaan 2"', 'Aa٣ب'); } catch { /* no font API */ }

  // Labels, English and Arabic.
  const T = {
    hundreds: ['Hundreds', 'مئات'], tens: ['Tens', 'عشرات'], ones: ['Ones', 'آحاد'],
    riyal: ['riyal', 'ريال'], riyals: ['riyals', 'ريال'], halala: ['halala', 'هللة'], total: ['Total', 'المجموع'],
    cm: ['cm', 'سم'], shop: ['Shop', 'بقالة'],
    circle: ['circle', 'دائرة'], square: ['square', 'مربع'], triangle: ['triangle', 'مثلث'], rectangle: ['rectangle', 'مستطيل'],
    oval: ['oval', 'بيضاوي'], star: ['star', 'نجمة'], heart: ['heart', 'قلب'], hexagon: ['hexagon', 'سداسي'],
    pentagon: ['pentagon', 'خماسي'], diamond: ['rhombus', 'معيّن'],
    sides: ['sides', 'أضلاع'], side: ['side', 'ضلع'], corners: ['corners', 'رؤوس'],
    seed: ['seed', 'بذرة'], sprout: ['sprout', 'إنبات'], seedling: ['seedling', 'نبتة'], plant: ['plant', 'نبات'], flower: ['flower', 'زهرة'],
    evaporation: ['evaporation', 'تبخّر'], condensation: ['condensation', 'تكاثف'], rain: ['rain', 'هطول'], collection: ['collection', 'تجمّع'],
    day: ['day', 'نهار'], night: ['night', 'ليل'],
    sun: ['Sun', 'الشمس'], mercury: ['Mercury', 'عطارد'], venus: ['Venus', 'الزهرة'], earth: ['Earth', 'الأرض'], mars: ['Mars', 'المريخ'],
    jupiter: ['Jupiter', 'المشتري'], saturn: ['Saturn', 'زحل'], uranus: ['Uranus', 'أورانوس'], neptune: ['Neptune', 'نبتون'], moon: ['Moon', 'القمر'],
    legs: ['legs', 'أرجل'], wings: ['wings', 'أجنحة'], fins: ['fins', 'زعانف'], tail: ['tail', 'ذيل'], hump: ['hump', 'سنام'],
    shell: ['shell', 'صدفة'], beak: ['beak', 'منقار'], wool: ['wool', 'صوف'], whiskers: ['whiskers', 'شوارب'], ears: ['ears', 'أذنان'],
    solid: ['solid', 'صلب'], liquid: ['liquid', 'سائل'], gas: ['gas', 'غاز'],
  };
  const tr = (k, rtl) => (T[k] ? T[k][rtl ? 1 : 0] : String(k));

  // Arabic board? An explicit "lang", else the prop's own words, else the board title.
  // Option values ("woman", "pizza", "day") don't count; only words meant to be read.
  const TEXT_KEYS = /^(say|write|add|text|label|labels|word|title|q|caption)$/;
  function langOf(b, cmd) {
    if (cmd.lang) return /^ar/i.test(cmd.lang);
    const words = [];
    const walk = (v, key) => {
      if (typeof v === 'string') { if (RTL_RE.test(v) || TEXT_KEYS.test(key || '')) words.push(v); }
      else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
      else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
    };
    walk(cmd, '');
    const d = textDir(words.join(' '));
    return d ? d === 'rtl' : !!(b._kd && b._kd.rtl);
  }

  // ------------------------------------------------------------ motion
  // transform-origin at the element's own centre (or a given point).
  const O = (el, origin = 'center') => {
    if (el) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = origin; }
    return el;
  };
  const EASE = 'cubic-bezier(.2,.7,.3,1)';
  const BOUNCE = 'cubic-bezier(.3,1.6,.5,1)';
  // A one-off animation that leaves the element where it ends.
  function go(el, frames, o = {}) {
    if (!el) return Promise.resolve();
    const a = el.animate(frames, { duration: 500, easing: EASE, fill: 'forwards', ...o });
    return a.finished.then(() => { try { a.commitStyles(); a.cancel(); } catch { /* detached */ } }, () => {});
  }
  // Appear: hidden until its moment, then pop / drop / fade in.
  function pop(el, delay = 0, ms = 520) {
    if (!el) return Promise.resolve();
    O(el);
    el.style.opacity = '';
    return el.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.14)', opacity: 1, offset: 0.6 },
      { transform: 'scale(.97)', offset: 0.82 }, { transform: 'scale(1)', opacity: 1 }],
    { duration: ms, delay, easing: EASE, fill: 'backwards' }).finished.catch(() => {});
  }
  function drop(el, delay = 0, dy = 120, ms = 560) {
    if (!el) return Promise.resolve();
    el.style.opacity = '';
    return el.animate([{ transform: `translateY(${-dy}px)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1, offset: 0.62 },
      { transform: 'translateY(-10px)', offset: 0.8 }, { transform: 'translateY(0)', opacity: 1 }],
    { duration: ms, delay, easing: 'ease-in', fill: 'backwards' }).finished.catch(() => {});
  }
  function fade(el, delay = 0, ms = 380) {
    if (!el) return Promise.resolve();
    el.style.opacity = '';
    return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay, fill: 'backwards' }).finished.catch(() => {});
  }
  const hide = (...els) => els.flat().forEach((e) => e && (e.style.opacity = '0'));
  function bump(el, k = 1.18, ms = 420) {
    if (!el) return Promise.resolve();
    O(el);
    return el.animate([{ transform: 'scale(1)' }, { transform: `scale(${k})` }, { transform: 'scale(1)' }], { duration: ms, easing: 'ease-out' }).finished.catch(() => {});
  }
  // Numeric attribute tweens (clip rectangles, lengths): requestAnimationFrame.
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const tween = (ms, f, ease = easeOut) => new Promise((res) => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      f(ease(p));
      if (p < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });

  const STOP = Symbol('stop');
  let UID = 0;

  // --------------------------------------------------------- svg bits
  // Text: kid font, centred, its own direction (Arabic shapes and orders
  // right to left; digits and Latin stay left to right).
  function txt(x, y, s, size, o = {}) {
    const str = String(s ?? '');
    const dir = o.dir || (textDir(str) === 'rtl' ? 'rtl' : 'ltr');
    const attrs = [
      `x="${x}"`, `y="${y}"`, `font-size="${size}"`, `text-anchor="${o.anchor || 'middle'}"`,
      `dominant-baseline="${o.base || 'central'}"`, `direction="${dir}"`, `unicode-bidi="embed"`,
      `fill="${o.fill || INK}"`, `font-weight="${o.weight || 800}"`,
      `style="font-family:${FONT}${o.style ? `;${o.style}` : ''}"`,
    ];
    if (o.fit) attrs.push(`data-fit="${o.fit}"`);
    if (o.cls) attrs.push(`class="${o.cls}"`);
    if (o.part) attrs.push(`data-part="${o.part}"`);
    if (o.stroke) attrs.push(`stroke="${o.stroke}"`, `stroke-width="${o.sw || 6}"`, 'paint-order="stroke"', 'stroke-linejoin="round"');
    if (o.extra) attrs.push(o.extra);
    return `<text ${attrs.join(' ')}>${esc(str)}</text>`;
  }
  // An emoji picture inside an svg (Windows' colour emoji font; instant, offline).
  const emo = (e, x, y, size, cls = '') =>
    `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="central" class="${cls}" style="font-family:${EMOJI}">${esc(e || '⭐')}</text>`;
  // A sparkle (same shape as the mascot's).
  const sparkle = (x, y, r, fill = '#FFE07A') => `<path fill="${fill}" d="M${x} ${y - r} Q${x + r * 0.2} ${y - r * 0.2} ${x + r} ${y} Q${x + r * 0.2} ${y + r * 0.2} ${x} ${y + r} Q${x - r * 0.2} ${y + r * 0.2} ${x - r} ${y} Q${x - r * 0.2} ${y - r * 0.2} ${x} ${y - r}Z"/>`;
  // A candy pill label: white text on a coloured rounded bar.
  function pill(x, y, s, o = {}) {
    const size = o.size || 30, w = o.w || Math.max(80, String(s).length * size * 0.62 + 40), h = size * 1.45;
    return `<g class="${o.cls || ''}"${o.part ? ` data-part="${o.part}"` : ''}><rect x="${x - w / 2}" y="${y - h / 2 + 4}" width="${w}" height="${h}" rx="${h / 2}" fill="${shade(o.fill || C.purple, -0.35)}"/>` +
      `<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${o.fill || C.purple}"/>` +
      txt(x, y + 2, s, size, { fill: o.ink || '#fff', fit: w - 24 }) + '</g>';
  }

  // =========================================================== the kit
  // One placed prop: its svg, its params, helpers, and a queue so that
  // propsets play one after another.
  class Kit {
    constructor(b, cmd, name, spec) {
      this.b = b; this.name = name; this.spec = spec;
      this.p = { ...cmd };
      this.uid = `kp${++UID}`;
      this.rtl = langOf(b, cmd);
      this.gen = b.gen;
      this.chain = Promise.resolve();
      this.s = {};
    }
    d(n) { return dig(n, this.rtl); }
    t(k) { return tr(k, this.rtl); }
    alive() { return !!this.el && this.el.isConnected && this.b.gen === this.gen; }
    $(sel) { return this.svg.querySelector(sel); }
    $$(sel) { return [...this.svg.querySelectorAll(sel)]; }
    id(s) { return `${this.uid}${s}`; }
    // Append svg markup to a group (default: the prop's root) -> the new element.
    add(markup, parent = this.root) {
      parent.insertAdjacentHTML('beforeend', markup);
      return parent.lastElementChild;
    }
    async wait(ms) { await sleep(ms); if (!this.alive()) throw STOP; }
    run(fn) {
      this.chain = this.chain.then(() => (this.alive() ? fn() : null)).catch((e) => { if (e !== STOP) console.error('prop', this.name, e); });
      return this.chain;
    }
    // Shrink any text marked data-fit="<max width>" until it fits.
    fit(root = this.svg) {
      for (const t of root.querySelectorAll('text[data-fit]')) {
        const max = Number(t.dataset.fit);
        if (!t.dataset.size0) t.dataset.size0 = t.getAttribute('font-size');
        const s0 = Number(t.dataset.size0);
        t.setAttribute('font-size', s0);
        let len = 0;
        try { len = t.getComputedTextLength(); } catch { /* not rendered */ }
        if (len > max && len > 0) t.setAttribute('font-size', Math.max(10, Math.floor(s0 * max / len)));
      }
    }
    // The die-cut sticker look: a white outline and a soft shadow.
    cutDef() {
      return `<filter id="${this.id('cut')}" x="-15%" y="-15%" width="130%" height="140%" color-interpolation-filters="sRGB">
        <feMorphology in="SourceAlpha" operator="dilate" radius="4" result="d"/>
        <feFlood flood-color="#fff"/><feComposite in2="d" operator="in" result="o"/>
        <feGaussianBlur in="d" stdDeviation="5" result="bl"/><feOffset in="bl" dy="7" result="sh"/>
        <feFlood flood-color="#0a0628" flood-opacity=".42"/><feComposite in2="sh" operator="in" result="s"/>
        <feMerge><feMergeNode in="s"/><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <filter id="${this.id('sh')}" x="-15%" y="-15%" width="130%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="5" flood-color="#0a0628" flood-opacity=".4"/></filter>
        <filter id="${this.id('glow')}" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#FFE07A" flood-opacity="1"/></filter>`;
    }
    get cut() { return `filter="url(#${this.id('cut')})"`; }
    // A new viewBox (same width on the board): the box grows and the camera reframes.
    resize(vb) {
      this.vb = vb;
      this.svg.setAttribute('viewBox', vb.join(' '));
      const rec = this.b.els.get(this.key);
      if (!rec) return;
      const h = rec.bbox.w * vb[3] / vb[2];
      rec.bbox.h = h;
      this.el.style.height = `${h}px`;
      this.b.fitContent();
    }
    get shadow() { return `filter="url(#${this.id('sh')})"`; }
    // Glow one part (by data-part) and soften the others in its group.
    focus(part, dimSel) {
      for (const e of this.$$('[data-part]')) e.classList.remove('kp-glow');
      if (dimSel) for (const e of this.$$(dimSel)) e.classList.toggle('kp-soft', !!part && e.dataset.part !== part);
      if (!part) return null;
      const hit = this.$$(`[data-part="${part}"]`);
      hit.forEach((e) => { e.classList.add('kp-glow'); bump(e, 1.08, 500); });
      return hit[0] || null;
    }
  }

  // =========================================================== people
  // One person builder for the teachers and the kids: flat shapes, a simple
  // friendly face (dot eyes with a highlight, rosy cheeks, a small smile),
  // modest Saudi dress. Drawn in a 200 x 300 frame, feet at y 290.
  const SKIN = { light: '#F6CFAE', tan: '#E9B48A', brown: '#C98A5E' };
  const PEOPLE = {
    woman: { kid: false, scarf: '#8FD6C9', dress: '#33365E', trim: '#FFC857' },
    man: { kid: false, dress: '#F4F6FB', trim: '#D3DBEA' },
    girl: { kid: true, scarf: '#F4F6FF', dress: '#2FA88A', trim: '#FFFFFF' },
    boy: { kid: true, dress: '#F4F6FB', trim: '#D3DBEA' },
  };
  const WHO_ALIAS = { female: 'woman', lady: 'woman', she: 'woman', teacher: 'woman', male: 'man', he: 'man', sister: 'girl', brother: 'boy', f: 'woman', m: 'man' };
  const whoOf = (w, kid) => {
    const k = String(w || '').toLowerCase();
    const n = PEOPLE[k] ? k : WHO_ALIAS[k] || (kid ? 'girl' : 'woman');
    return kid && !PEOPLE[n].kid ? (n === 'man' ? 'boy' : 'girl') : n;
  };
  const MOOD_ALIAS = { talking: 'talk', speak: 'talk', pointing: 'point', show: 'point', cheering: 'cheer', celebrate: 'cheer', yay: 'cheer',
    thinking: 'think', wonder: 'think', waving: 'wave', hello: 'wave', hi: 'wave', smile: 'happy', wow: 'wow', surprised: 'wow',
    sad: 'oops', oops: 'oops', confused: 'oops', proud: 'happy' };
  const moodOf = (m, d) => { const k = String(m || '').toLowerCase(); return ['talk', 'point', 'cheer', 'think', 'wave', 'happy', 'wow', 'oops'].includes(k) ? k : MOOD_ALIAS[k] || d; };
  // Arm angles (deg, from hanging down; the left arm's + swings outward).
  const POSE = {
    talk: [10, -62], point: [10, -128], cheer: [152, -152], think: [12, -150], wave: [10, -150],
    happy: [14, -14], wow: [48, -48], oops: [6, -6],
  };
  const MOUTH = {
    smile: ['M-8 -2 Q0 6 8 -2', false],
    grin: ['M-9 -3 Q0 10 9 -3 Q0 0 -9 -3Z', true],
    o: ['M0 -5 C4.5 -5 5.5 -1 5.5 2 C5.5 6 3 7.5 0 7.5 C-3 7.5 -5.5 6 -5.5 2 C-5.5 -1 -4.5 -5 0 -5Z', true],
    flat: ['M-5 1.5 Q1 -1 6 0', false],
    wobble: ['M-8 2 Q-4 -2 0 2 Q4 6 8 2', false],
    t1: ['M-7 -2 Q0 6 7 -2 Q0 0 -7 -2Z', true],
    t2: ['M-8 -3 Q0 9 8 -3 Q0 -1 -8 -3Z', true],
    t3: ['M-5 -3 Q0 -5 5 -3 Q6 4 0 6 Q-6 4 -5 -3Z', true],
  };
  const FACE = { talk: 'smile', point: 'smile', cheer: 'grin', think: 'flat', wave: 'grin', happy: 'smile', wow: 'o', oops: 'wobble' };

  function mouthD(key) { return MOUTH[key] || MOUTH.smile; }

  // The head, drawn around (0,0) = the middle of the face.
  function head(who, mood, o) {
    const skin = o.skin, sk2 = shade(skin, -0.12);
    const happyEyes = mood === 'cheer';
    const look = mood === 'think' ? 'translate(2px,-2.5px)' : '';
    const [md, open] = mouthD(FACE[mood]);
    const browL = mood === 'wow' ? 'M-16 -6 Q-11 -10 -6 -6' : mood === 'oops' ? 'M-16 -1 Q-11 -2 -6 -5' : mood === 'think' ? 'M-16 -3 Q-11 -6 -6 -3' : 'M-16 -2 Q-11 -5 -6 -2';
    const browR = mood === 'wow' ? 'M6 -6 Q11 -10 16 -6' : mood === 'oops' ? 'M6 -5 Q11 -2 16 -1' : mood === 'think' ? 'M6 -6 Q11 -9 16 -6' : 'M6 -2 Q11 -5 16 -2';
    const eye = (x) => `<g transform="translate(${x} 9)"><g class="kp-eye">` +
      `<g class="kp-pupil" style="transform:${look}"><ellipse rx="3.9" ry="4.9" fill="${INK}"/><circle cx="1.3" cy="-1.9" r="1.5" fill="#fff"/></g></g>` +
      `<path class="kp-eye-happy" d="M-5 2 Q0 -5 5 2" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/></g>`;
    const face = `<ellipse cx="0" cy="8" rx="30" ry="33" fill="${skin}"/>
      <ellipse cx="-18" cy="21" rx="6.5" ry="3.8" fill="#FF7FA8" opacity=".5"/><ellipse cx="18" cy="21" rx="6.5" ry="3.8" fill="#FF7FA8" opacity=".5"/>
      <g class="kp-eyes${happyEyes ? ' kp-happyeyes' : ''}">${eye(-11)}${eye(11)}</g>
      <path d="${browL}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
      <path d="${browR}" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
      <path d="M-2.2 16 Q0 18.6 2.2 16" fill="none" stroke="${shade(skin, -0.32)}" stroke-width="2" stroke-linecap="round"/>`;
    const mouth = `<g transform="translate(0 28)"><path class="kp-mouth${open ? ' kp-open' : ''}" d="${md}"/></g>`;
    if (who === 'woman' || (who === 'girl' && o.hijab !== false)) {
      const sc = o.scarf, sc2 = shade(sc, -0.14), sc3 = shade(sc, -0.26);
      // Back of the scarf, the face, the band framing the face, the drape.
      return `<path d="M0 -50 C34 -50 52 -24 52 6 C52 30 46 44 56 64 Q0 90 -56 64 C-46 44 -52 30 -52 6 C-52 -24 -34 -50 0 -50Z" fill="${sc2}"/>
        <path d="M0 -50 C34 -50 52 -24 52 6 C52 22 48 34 52 44 Q30 30 0 30 Q-30 30 -52 44 C-48 34 -52 22 -52 6 C-52 -24 -34 -50 0 -50Z" fill="${sc}"/>
        ${face}${mouth}
        <path d="M-31 6 C-33 -24 -16 -32 0 -32 C16 -32 33 -24 31 6 C27 -9 16 -14 0 -14 C-16 -14 -27 -9 -31 6Z" fill="${sc}"/>
        <ellipse cx="0" cy="8" rx="31.5" ry="34.5" fill="none" stroke="${sc3}" stroke-width="3" opacity=".55"/>
        <path d="M-30 30 Q-20 46 0 46 Q20 46 30 30 Q36 44 40 58 Q0 74 -40 58 Q-36 44 -30 30Z" fill="${sc}"/>
        <path d="M-14 -38 Q0 -44 14 -38" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".35"/>`;
    }
    if (who === 'man') {
      const chk = `url(#${o.uid}chk)`;
      return `<path d="M0 -52 C36 -52 50 -26 50 2 C50 34 56 60 66 82 Q40 94 30 74 C24 60 22 50 0 50 C-22 50 -24 60 -30 74 Q-40 94 -66 82 C-56 60 -50 34 -50 2 C-50 -26 -36 -52 0 -52Z" fill="${chk}"/>
        <path d="M0 -52 C36 -52 50 -26 50 2 C50 34 56 60 66 82 Q40 94 30 74 C24 60 22 50 0 50 C-22 50 -24 60 -30 74 Q-40 94 -66 82 C-56 60 -50 34 -50 2 C-50 -26 -36 -52 0 -52Z" fill="none" stroke="#C93A45" stroke-width="2.5" opacity=".6"/>
        <ellipse cx="-31" cy="10" rx="5" ry="8" fill="${sk2}"/><ellipse cx="31" cy="10" rx="5" ry="8" fill="${sk2}"/>
        ${face}
        <path d="M-29 8 C-30 34 -16 47 0 47 C16 47 30 34 29 8 C26 24 18 33 0 33 C-18 33 -26 24 -29 8Z" fill="#3A2A2E"/>
        <path d="M-10 23.5 Q0 19 10 23.5 Q0 27 -10 23.5Z" fill="#3A2A2E"/>
        ${mouth}
        <path d="M-32 4 C-34 -26 -16 -34 0 -34 C16 -34 34 -26 32 4 C28 -10 16 -15 0 -15 C-16 -15 -28 -10 -32 4Z" fill="${chk}"/>
        <path d="M-32 4 C-28 -10 -16 -15 0 -15 C16 -15 28 -10 32 4" fill="none" stroke="#C93A45" stroke-width="2.5" opacity=".6"/>
        <ellipse cx="0" cy="-40" rx="33" ry="9" fill="none" stroke="#232033" stroke-width="5.5"/>
        <ellipse cx="0" cy="-33" rx="35" ry="9.5" fill="none" stroke="#232033" stroke-width="5.5"/>`;
    }
    if (who === 'girl') {   // hijab:false: dark hair, a headband, a ponytail
      const hair = '#3B2622';
      return `<path d="M30 -6 C58 0 62 40 46 60 C42 40 38 24 28 14Z" fill="${hair}"/>
        <ellipse cx="-31" cy="10" rx="5" ry="8" fill="${sk2}"/><ellipse cx="31" cy="10" rx="5" ry="8" fill="${sk2}"/>
        ${face}${mouth}
        <path d="M-32 8 C-36 -28 -14 -38 2 -38 C22 -38 36 -24 32 8 C30 -4 26 -12 18 -16 C6 -8 -14 -8 -24 -14 C-28 -6 -31 0 -32 8Z" fill="${hair}"/>
        <path d="M-27 -16 Q0 -36 27 -16" fill="none" stroke="#FF6B8B" stroke-width="6" stroke-linecap="round"/>`;
    }
    // boy: short black hair with a fringe, ears
    const hair = '#26202A';
    return `<ellipse cx="-31" cy="10" rx="5.5" ry="8.5" fill="${sk2}"/><ellipse cx="31" cy="10" rx="5.5" ry="8.5" fill="${sk2}"/>
      ${face}${mouth}
      <path d="M-31 6 C-35 -26 -14 -38 4 -37 C22 -36 35 -22 31 6 C29 -6 24 -12 16 -15 C8 -9 -10 -8 -22 -14 C-27 -7 -30 -1 -31 6Z" fill="${hair}"/>
      <path d="M-6 -33 Q6 -38 16 -32" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".18"/>`;
  }

  function arm(x, y, len, deg, sleeve, cuff, skin, side, pointing) {
    const finger = pointing ? `<rect x="-3.5" y="${len + 4}" width="7" height="16" rx="3.5" fill="${skin}"/>` : '';
    const edge = /^#f/i.test(sleeve) ? ' stroke="#BFC9DD" stroke-width="2.5"' : '';
    return `<g transform="translate(${x} ${y})"><g class="kp-arm kp-arm-${side}" style="transform:rotate(${deg}deg)">
      <rect x="-12" y="-8" width="24" height="${len}" rx="12" fill="${sleeve}"${edge}/>
      <rect x="-12" y="${len - 20}" width="24" height="10" rx="4" fill="${cuff}"/>
      ${finger}<circle cx="0" cy="${len}" r="10" fill="${skin}"/></g></g>`;
  }

  // -> svg markup for a person; o: {who, mood, skin, scarf, hijab, uid}
  function person(o) {
    const who = o.who, P = PEOPLE[who], mood = o.mood;
    const skin = SKIN[o.skin] || o.skin || (who === 'man' || who === 'boy' ? SKIN.tan : SKIN.light);
    const hp = { ...o, skin, scarf: o.scarf ? col(o.scarf) : P.scarf };
    const [aL, aR] = POSE[mood] || POSE.happy;
    const defs = who === 'man' ? `<defs><pattern id="${o.uid}chk" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="#FFFFFF"/><path d="M0 4.5H9M4.5 0V9" stroke="#E2434F" stroke-width="2.6"/><rect x="3" y="3" width="3" height="3" fill="#B92A36"/></pattern></defs>` : '';
    let body, hx, hy, hs, arms;
    if (!P.kid) {
      hx = 100; hy = 70; hs = 1;
      if (who === 'woman') {
        const d = o.dress ? col(o.dress) : P.dress, d2 = shade(d, -0.25);
        body = `<path d="M70 122 Q100 112 130 122 Q148 132 151 162 L162 282 Q100 292 38 282 L49 162 Q52 132 70 122Z" fill="${d}"/>
          <path d="M130 122 Q148 132 151 162 L162 282 Q150 286 138 287 L132 170Z" fill="${d2}" opacity=".7"/>
          <path d="M100 150 L100 286" stroke="${shade(d, 0.18)}" stroke-width="2.5"/>
          <path d="M40 272 Q100 282 160 272 L162 282 Q100 292 38 282Z" fill="${P.trim}" opacity=".9"/>`;
        arms = [arm(66, 140, 76, aL, d, P.trim, skin, 'l', false), arm(134, 140, 76, aR, d, P.trim, skin, 'r', mood === 'point')];
      } else {
        const d = P.dress, d2 = '#D9E0EE';
        body = `<ellipse cx="78" cy="287" rx="15" ry="6" fill="#4A3B36"/><ellipse cx="122" cy="287" rx="15" ry="6" fill="#4A3B36"/>
          <path d="M70 122 Q100 112 130 122 Q146 130 148 158 L156 282 Q100 290 44 282 L52 158 Q54 130 70 122Z" fill="${d}"/>
          <path d="M130 122 Q146 130 148 158 L156 282 Q146 285 136 286 L130 168Z" fill="${d2}"/>
          <path d="M100 124 L100 190" stroke="${d2}" stroke-width="3"/>
          <circle cx="100" cy="140" r="2.6" fill="#B8C2D6"/><circle cx="100" cy="156" r="2.6" fill="#B8C2D6"/><circle cx="100" cy="172" r="2.6" fill="#B8C2D6"/>`;
        arms = [arm(66, 138, 76, aL, d, P.trim, skin, 'l', false), arm(134, 138, 76, aR, d, P.trim, skin, 'r', mood === 'point')];
      }
    } else {
      hx = 100; hy = 92; hs = 1.18;
      if (who === 'girl') {
        const d = o.dress ? col(o.dress) : P.dress;
        body = `<ellipse cx="84" cy="287" rx="13" ry="6" fill="#2A2140"/><ellipse cx="116" cy="287" rx="13" ry="6" fill="#2A2140"/>
          <path d="M74 150 Q100 142 126 150 Q138 156 140 176 L146 282 Q100 290 54 282 L60 176 Q62 156 74 150Z" fill="${d}"/>
          <path d="M126 150 Q138 156 140 176 L146 282 Q138 285 130 286 L122 186Z" fill="${shade(d, -0.2)}" opacity=".7"/>
          <path d="M60 236 Q100 244 141 236" fill="none" stroke="${shade(d, 0.25)}" stroke-width="3" opacity=".7"/>
          <rect x="86" y="196" width="28" height="18" rx="5" fill="${shade(d, 0.22)}"/>`;
      } else {
        const d = P.dress, d2 = '#D9E0EE';
        body = `<ellipse cx="84" cy="287" rx="13" ry="6" fill="#4A3B36"/><ellipse cx="116" cy="287" rx="13" ry="6" fill="#4A3B36"/>
          <path d="M74 150 Q100 142 126 150 Q138 156 140 176 L146 282 Q100 290 54 282 L60 176 Q62 156 74 150Z" fill="${d}"/>
          <path d="M126 150 Q138 156 140 176 L146 282 Q138 285 130 286 L124 186Z" fill="${d2}"/>
          <path d="M100 152 L100 196" stroke="${d2}" stroke-width="3"/><circle cx="100" cy="166" r="2.4" fill="#B8C2D6"/><circle cx="100" cy="180" r="2.4" fill="#B8C2D6"/>`;
      }
      const sl = who === 'girl' ? (o.dress ? col(o.dress) : P.dress) : P.dress;
      const cf = who === 'girl' ? '#FFFFFF' : P.trim;
      const kidPose = { cheer: [140, -140], think: [12, -150], wave: [14, -150] }[mood] || [aL, aR];
      arms = [arm(70, 164, 64, kidPose[0], sl, cf, skin, 'l', false), arm(130, 164, 64, kidPose[1], sl, cf, skin, 'r', mood === 'point')];
    }
    // Arms raised above the head go in front of it; hanging arms behind the drape.
    const up = mood === 'cheer' || mood === 'wave' || mood === 'point' || mood === 'think';
    const h = `<g transform="translate(${hx} ${hy}) scale(${hs})"><g class="kp-head">${head(who, mood, { ...hp, uid: o.uid })}</g></g>`;
    const extra = mood === 'think' ? `<g class="kp-think"><circle cx="152" cy="40" r="5" fill="#fff"/><circle cx="164" cy="24" r="7" fill="#fff"/><circle cx="180" cy="6" r="9" fill="#fff"/></g>` : '';
    return `${defs}<ellipse cx="100" cy="290" rx="62" ry="8" fill="#0a0628" opacity=".28"/>
      <g class="kp-body">${up ? body + arms[0] + h + arms[1] : body + arms.join('') + h}${extra}</g>`;
  }

  // Life for a person: blinks, a mouth that moves only while the voice
  // plays, and a pose-specific gesture when it appears.
  function personLife(k, g, mood) {
    const blink = () => {
      if (!k.alive() || !g.isConnected) return;
      for (const e of g.querySelectorAll('.kp-eye')) {
        O(e).animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(.1)' }, { transform: 'scaleY(1)' }], { duration: 160 });
      }
      setTimeout(blink, 2600 + Math.random() * 2800);
    };
    setTimeout(blink, 1400 + Math.random() * 1500);
    const armR = g.querySelector('.kp-arm-r'), armL = g.querySelector('.kp-arm-l');
    const rot = (el) => parseFloat((el.style.transform.match(/-?[\d.]+/) || [0])[0]);
    if (mood === 'cheer') {
      O(g.querySelector('.kp-body'), 'center bottom').animate([{ transform: 'translateY(0) scale(1,1)' }, { transform: 'translateY(3px) scale(1.04,.95)', offset: 0.18 },
        { transform: 'translateY(-26px) scale(.97,1.04)', offset: 0.5 }, { transform: 'translateY(0) scale(1.03,.97)', offset: 0.8 }, { transform: 'translateY(0) scale(1,1)' }],
      { duration: 700, delay: 500, iterations: 2, easing: 'ease-in-out' });
    } else if (mood === 'wave' && armR) {
      const a = rot(armR);
      armR.animate([{ transform: `rotate(${a}deg)` }, { transform: `rotate(${a + 28}deg)` }, { transform: `rotate(${a}deg)` }], { duration: 420, delay: 500, iterations: 4, easing: 'ease-in-out' });
    } else if (mood === 'point' && armR) {
      const a = rot(armR);
      armR.animate([{ transform: `rotate(${a}deg)` }, { transform: `rotate(${a + 10}deg)` }, { transform: `rotate(${a}deg)` }], { duration: 360, delay: 600, iterations: 2, easing: 'ease-in-out' });
    } else if (mood === 'wow') {
      O(g.querySelector('.kp-body'), 'center bottom').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-14px)', offset: 0.4 }, { transform: 'translateY(0)' }], { duration: 420, delay: 400 });
    }
    void armL;
  }

  // Talking: the mouth cycles open shapes for about as long as the line.
  const TALK = ['t1', 't2', 't1', 't3', 't2', 'smile'];
  function personTalk(k, g, text) {
    const m = g.querySelector('.kp-mouth');
    if (!m) return;
    const until = Date.now() + clamp(String(text || '').length * 70, 700, 14000);
    k.s.talkUntil = until;
    if (k.s.talking) return;
    k.s.talking = true;
    const rest = mouthD(FACE[k.s.mood] || 'smile');
    let last = '';
    const tick = () => {
      if (!k.alive() || Date.now() > k.s.talkUntil || k.s.hushed) {
        k.s.talking = false; k.s.hushed = false;
        m.setAttribute('d', rest[0]); m.classList.toggle('kp-open', rest[1]);
        return;
      }
      let key;
      do key = TALK[Math.floor(Math.random() * TALK.length)]; while (key === last);
      last = key;
      const [d, open] = mouthD(key);
      m.setAttribute('d', d); m.classList.toggle('kp-open', open);
      setTimeout(tick, 90 + Math.random() * 70);
    };
    tick();
  }

  // A speech bubble above a character (1-3 words).
  function bubble(k, x, y, text, tailX) {
    const s = String(text).split(/\s+/).slice(0, 3).join(' ');
    const size = 34, w = clamp(s.length * size * 0.55 + 46, 110, 300), h = 64;
    return `<g class="kp-bubble" ${k.shadow}><path d="M${x - w / 2 + 24} ${y - h / 2} H${x + w / 2 - 24} Q${x + w / 2} ${y - h / 2} ${x + w / 2} ${y - h / 2 + 24} V${y + h / 2 - 24} Q${x + w / 2} ${y + h / 2} ${x + w / 2 - 24} ${y + h / 2} H${tailX + 12} L${tailX} ${y + h / 2 + 22} L${tailX - 8} ${y + h / 2} H${x - w / 2 + 24} Q${x - w / 2} ${y + h / 2} ${x - w / 2} ${y + h / 2 - 24} V${y - h / 2 + 24} Q${x - w / 2} ${y - h / 2} ${x - w / 2 + 24} ${y - h / 2}Z" fill="#fff"/>
      ${txt(x, y + 3, s, size, { fit: w - 30 })}</g>`;
  }

  // ============================================================ props
  const PROPS = {};
  const ALIAS = {};
  const def = (name, spec, aliases = []) => { PROPS[name] = spec; for (const a of aliases) ALIAS[a] = name; };

  // -------------------------------------------------- teacher / kid
  // {"name":"teacher","who":"woman|man","mood":"talk|point|cheer|think|wave|happy","to":"left|right","say":"<1-3 words>"}
  // {"name":"kid","who":"girl|boy","mood":"happy|wave|cheer|think|wow|oops|point","hijab":true,"say":"..."}
  function personProp(kid) {
    return {
      vb: (p) => (has(p.say) ? [-70, -70, 340, 370] : [-10, 0, 220, 300]),
      fill: 0.62,
      draw(k) {
        const p = k.p;
        const who = whoOf(p.who || p.gender, kid);
        const mood = moodOf(p.mood, kid ? 'happy' : 'talk');
        k.s.mood = mood;
        k.talker = !kid && (mood === 'talk' || mood === 'point');
        const flip = p.to === 'left' || p.face === 'left' ? ' transform="translate(200 0) scale(-1 1)"' : '';
        let m = `<defs>${k.cutDef()}</defs><g class="kp-person" ${k.cut}><g${flip}>${person({ who, mood, uid: k.uid, skin: p.skin, scarf: p.scarf || p.hijabColor, hijab: p.hijab, dress: p.dress })}</g></g>`;
        if (has(p.say)) {
          const right = !flip;
          m += bubble(k, right ? 186 : 14, -26, p.say, right ? 140 : 60);
        }
        return m;
      },
      async intro(k) {
        const g = k.$('.kp-person');
        personLife(k, g, k.s.mood);
        const b = k.$('.kp-bubble');
        if (b) { hide(b); await k.wait(700); pop(b); }
      },
      say(k, text) { personTalk(k, k.$('.kp-person'), text); },
      async set(k, p) {
        if (has(p.mood) || has(p.who) || has(p.say) || has(p.to)) {   // redraw in the new pose
          Object.assign(k.p, p);
          k.root.innerHTML = this.draw(k);
          k.fit();
          await this.intro(k);
        }
      },
    };
  }
  def('teacher', personProp(false), ['mualima', 'muallim', 'person', 'adult']);
  def('kid', personProp(true), ['child', 'girl', 'boy', 'student', 'pupil']);

  // ============================================================ scenes
  // A scene is a framed picture card (800 x 480, rounded, white edge, like
  // the story panels). Scenes can hold countable things ("things"), which
  // propset adds or sends away one by one.
  const SW = 800, SH = 480;
  function frame(k, inner, over = '') {
    return `<defs>${k.cutDef()}<clipPath id="${k.id('clip')}"><rect width="${SW}" height="${SH}" rx="30"/></clipPath></defs>
      <rect width="${SW}" height="${SH}" rx="30" fill="#fff" ${k.shadow}/>
      <g clip-path="url(#${k.id('clip')})">${inner}</g>
      <rect x="2" y="2" width="${SW - 4}" height="${SH - 4}" rx="28" fill="none" stroke="#fff" stroke-width="8"/>${over}`;
  }
  // A pointed (Arabian) arch window.
  function archWindow(x0, y0, w, h, sky, inner = '') {
    const x1 = x0 + w, xc = x0 + w / 2, ym = y0 + w * 0.55, y1 = y0 + h;
    const d = `M${x0} ${y1} L${x0} ${ym} C${x0} ${y0 + w * 0.2} ${xc - w * 0.12} ${y0 + 6} ${xc} ${y0} C${xc + w * 0.12} ${y0 + 6} ${x1} ${y0 + w * 0.2} ${x1} ${ym} L${x1} ${y1}Z`;
    return `<path d="${d}" fill="${sky}"/>${inner}
      <path d="M${xc} ${y0 + 4} V${y1} M${x0} ${ym + (y1 - ym) * 0.45} H${x1}" stroke="#fff" stroke-width="6"/>
      <path d="${d}" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>
      <rect x="${x0 - 14}" y="${y1 - 2}" width="${w + 28}" height="14" rx="7" fill="#fff"/>`;
  }
  // Sadu weaving band: a row of little triangles in cream and black on red.
  function sadu(x, y, w, h, base = '#B8323F') {
    let tri = '';
    const n = Math.floor(w / h);
    for (let i = 0; i < n; i++) {
      const cx = x + i * h;
      tri += `<path d="M${cx} ${y + h} L${cx + h / 2} ${y} L${cx + h} ${y + h}Z" fill="${i % 3 === 1 ? '#2A2140' : '#FFF1D6'}"/>`;
    }
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${base}"/>${tri}`;
  }

  // Countable things in a scene: fixed slots, rows of five, filled in
  // reading order, so 7 always looks like 5 + 2.
  function thingSlots(region, n, rtl) {
    const per = 5, rows = n > per ? 2 : 1;
    const size = Math.min(region.w / per * 0.84, region.h / rows * 0.9, 96);
    const gx = region.w / per, gy = region.h / rows;
    const out = [];
    for (let i = 0; i < 10; i++) {
      const r = Math.floor(i / per), c = i % per;
      const cc = rtl ? per - 1 - c : c;
      out.push({ x: region.x + gx * (cc + 0.5), y: region.y + gy * (r + 0.5), size });
    }
    return out;
  }
  function thingsOf(p) {
    const t = p.things || (p.emoji ? { emoji: p.emoji, n: p.n ?? p.count } : null);
    if (!t) return null;
    if (Array.isArray(t)) return { list: t.slice(0, 10).map((e) => (typeof e === 'string' ? e : e.emoji)) };
    if (typeof t === 'string') return { list: [t] };
    const n = clamp(int(t.n ?? t.count, 1), 0, 10);
    return { list: Array.from({ length: n }, () => t.emoji || '⭐') };
  }
  function drawThings(k, region) {
    const th = thingsOf(k.p);
    k.s.region = region;
    if (!th) return '';
    k.s.things = th.list.slice();
    const slots = thingSlots(region, th.list.length, k.rtl);
    k.s.slots = slots;
    return `<g class="kp-things">${th.list.map((e, i) => `<g class="kp-thing" data-i="${i}">${emo(e, slots[i].x, slots[i].y, slots[i].size)}</g>`).join('')}</g>`;
  }
  async function introThings(k, delay = 600) {
    const items = k.$$('.kp-thing');
    hide(items);
    await k.wait(delay);
    for (const it of items) { pop(it); await k.wait(260); }
  }
  // propset {"n":<new count>}: extra ones hop in; spare ones fly away.
  async function setThings(k, p) {
    if (!k.s.region) return;
    let g = k.$('.kp-things');
    if (has(p.things) || has(p.emoji)) {   // a new set of things
      g?.remove();
      k.p = { ...k.p, things: p.things, emoji: p.emoji, n: p.n };
      k.add(drawThings(k, k.s.region));
      await introThings(k, 100);
      return;
    }
    if (!has(p.n) && !has(p.count)) return;
    if (!g) g = k.add('<g class="kp-things"></g>');
    const target = clamp(int(p.n ?? p.count, 0), 0, 10);
    k.s.things = k.s.things || [];
    const e0 = k.s.things[0] || '⭐';
    if (!k.s.slots) k.s.slots = thingSlots(k.s.region, 10, k.rtl);
    while (k.s.things.length < target) {
      const i = k.s.things.length, s = k.s.slots[i];
      k.s.things.push(e0);
      const it = k.add(`<g class="kp-thing" data-i="${i}">${emo(e0, s.x, s.y, s.size)}</g>`, g);
      drop(it, 0, 160);
      await k.wait(380);
    }
    while (k.s.things.length > target) {
      const i = k.s.things.length - 1;
      k.s.things.pop();
      const it = g.querySelector(`.kp-thing[data-i="${i}"]`);
      if (it) {
        const up = k.s.flyUp !== false;
        await go(it, [{ transform: 'translate(0,0) rotate(0)', opacity: 1 },
          { transform: up ? 'translate(40px,-50px) rotate(-10deg)' : 'translate(0,-40px)', opacity: 1, offset: 0.3 },
          { transform: up ? `translate(${k.rtl ? -320 : 320}px,-420px) rotate(-20deg)` : 'translate(0,-40px) scale(.2)', opacity: 0 }], { duration: 760, easing: 'ease-in' });
        it.remove();
      }
      await k.wait(120);
    }
  }

  // ---------------------------------------------------------- classroom
  // {"name":"classroom","write":["<1-3 short lines>"],"teacher":"woman|man|none","mood":"point"}
  // propset {"write":[...]} rewrites the board; {"add":"<line>"} writes one more; {"erase":true}.
  const MARKERS = ['#2F6FD6', '#E2434F', '#1F9D5C'];
  def('classroom', {
    vb: () => [SW, SH],
    draw(k) {
      const p = k.p;
      const who = p.teacher === 'none' || p.teacher === false ? null : whoOf(p.teacher || p.who, false);
      k.s.who = who;
      const bx = who ? 46 : 70, bw = who ? 500 : 560, by = 46, bh = 290;
      k.s.board = { x: bx + 18, y: by + 18, w: bw - 36, h: bh - 36 };
      let floor = '';
      for (let i = 0; i < 6; i++) floor += `<path d="M0 ${392 + i * 18} H${SW}" stroke="#C4854F" stroke-width="2" opacity=".5"/>`;
      const winX = who ? 600 : 676, winW = who ? 130 : 96;
      k.s.mood = moodOf(p.mood, 'point');
      k.talker = !!who && ['talk', 'point'].includes(k.s.mood);
      const inner = `<rect width="${SW}" height="${SH}" fill="#FFF1DD"/>
        <rect y="352" width="${SW}" height="24" fill="#F3D3A6"/>
        <rect y="376" width="${SW}" height="${SH - 376}" fill="#DDA06A"/>${floor}
        ${archWindow(winX, 56, winW, 200, '#A8DCFF', `<circle cx="${winX + winW * 0.7}" cy="120" r="16" fill="#FFE07A"/>`)}
        <rect x="${bx - 10}" y="${by - 10}" width="${bw + 20}" height="${bh + 20}" rx="16" fill="#8E98BC"/>
        <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="8" fill="#FFFFFF"/>
        <path d="M${bx + bw - 120} ${by + 14} l60 0 M${bx + bw - 90} ${by + 30} l50 0" stroke="#E3E9F6" stroke-width="7" stroke-linecap="round"/>
        <rect x="${bx + 30}" y="${by + bh + 6}" width="${bw - 60}" height="12" rx="6" fill="#7A84A8"/>
        <rect x="${bx + 60}" y="${by + bh}" width="40" height="9" rx="4" fill="#2F6FD6"/><rect x="${bx + 108}" y="${by + bh}" width="40" height="9" rx="4" fill="#E2434F"/>
        <rect x="${bx + bw - 110}" y="${by + bh}" width="56" height="11" rx="4" fill="#5C6688"/>
        <g class="kp-write"></g>`;
      // The teacher stands right of the board, turned toward it (mirrored),
      // so a pointing arm reaches the writing.
      const t = who ? `<g transform="translate(804 98) scale(-1.22 1.22)"><g class="kp-person" ${k.cut}>${person({ who, mood: k.s.mood, uid: k.uid, skin: p.skin, scarf: p.scarf })}</g></g>` : '';
      return frame(k, inner + t);
    },
    async intro(k) {
      const g = k.$('.kp-person');
      if (g) personLife(k, g, k.s.mood);
      const lines = [].concat(k.p.write ?? k.p.text ?? []).filter(has).slice(0, 3);
      if (lines.length) { await k.wait(500); await writeLines(k, lines); }
    },
    say(k, text) { const g = k.$('.kp-person'); if (g) personTalk(k, g, text); },
    async set(k, p) {
      const g = k.$('.kp-write');
      if (p.erase) { await go(g, [{ opacity: 1 }, { opacity: 0 }], { duration: 400 }); g.innerHTML = ''; g.style.opacity = ''; k.s.lines = []; }
      if (has(p.write)) {
        if (g.childElementCount) { await go(g, [{ opacity: 1 }, { opacity: 0 }], { duration: 350 }); g.innerHTML = ''; g.style.opacity = ''; }
        await writeLines(k, [].concat(p.write).filter(has).slice(0, 3));
      }
      if (has(p.add)) await writeLines(k, [...(k.s.lines || []), p.add].slice(-3), true);
      if (has(p.mood) && k.s.who) {
        k.s.mood = moodOf(p.mood, 'point');
        k.talker = ['talk', 'point'].includes(k.s.mood);
        const holder = k.$('.kp-person');
        holder.innerHTML = person({ who: k.s.who, mood: k.s.mood, uid: k.uid });
        personLife(k, holder, k.s.mood);
      }
    },
  }, ['class', 'school', 'whiteboard', 'board']);
  // Marker writing: each line appears from its start side, like a pen.
  async function writeLines(k, lines, keepOld) {
    const g = k.$('.kp-write'), B = k.s.board;
    const n = lines.length, size = [0, 128, 96, 74][n];
    const old = keepOld ? Math.min((k.s.lines || []).length, n - 1) : 0;
    if (keepOld) g.innerHTML = '';
    k.s.lines = lines.slice();
    for (let i = 0; i < n; i++) {
      const raw = String(lines[i]);
      const s = k.rtl ? dig(raw, true) : raw;
      const y = B.y + B.h * (i + 0.5) / n + 4;
      const cid = k.id(`w${++UID}`);
      const t = k.add(`<g><clipPath id="${cid}"><rect x="${B.x - 10}" y="${y - size}" width="0" height="${size * 2}"/></clipPath>
        <g clip-path="url(#${cid})">${txt(B.x + B.w / 2, y, s, size, { fill: MARKERS[i % 3], fit: B.w - 20, weight: 700 })}</g></g>`, g);
      k.fit(t);
      const r = t.querySelector('rect');
      if (i < old) { r.setAttribute('width', B.w + 20); continue; }
      const tw = Math.min(B.w, t.querySelector('text').getComputedTextLength() + 24);
      const x0 = B.x + B.w / 2 - tw / 2;
      const rtl = textDir(s) === 'rtl' || k.rtl;
      await tween(Math.min(1400, 300 + tw * 2.2), (e) => {
        const w = tw * e;
        r.setAttribute('x', rtl ? x0 + tw - w : x0);
        r.setAttribute('width', w);
      }, (q) => q);
      r.setAttribute('x', B.x - 10); r.setAttribute('width', B.w + 20);
      await k.wait(150);
    }
  }

  // ---------------------------------------------------------------- home
  // {"name":"home","time":"day|night","things":{"emoji":"🍎","n":4}}   a Saudi majlis.
  // propset {"time":"night"} (the window turns to night); {"n":<count>}.
  def('home', {
    vb: () => [SW, SH],
    draw(k) {
      const p = k.p;
      const night = p.time === 'night';
      k.s.flyUp = false;
      let band = '';
      for (let i = 0; i < 40; i++) band += `<path d="M${i * 20} 40 l10 -12 l10 12z" fill="${i % 2 ? '#E9A55C' : '#C9404D'}" opacity=".85"/>`;
      const sky = `<g class="kp-day" style="opacity:${night ? 0 : 1}"><circle cx="430" cy="128" r="22" fill="#FFD84D"/><path d="M350 205 q 18 -14 36 0 q 14 -10 28 0z" fill="#fff"/></g>
        <g class="kp-night" style="opacity:${night ? 1 : 0}"><path d="M432 112 a24 24 0 1 0 14 40 a20 20 0 1 1 -14 -40z" fill="#FFE07A"/>${sparkle(370, 120, 6, '#fff')}${sparkle(392, 180, 4, '#fff')}${sparkle(450, 200, 5, '#fff')}</g>`;
      const winSky = `<rect class="kp-sky" x="330" y="64" width="140" height="190" fill="${night ? '#24306E' : '#A8DCFF'}"/>`;
      const cushion = (x, w) => `<rect x="${x}" y="246" width="${w}" height="70" rx="22" fill="#C9404D"/>
        ${sadu(x + 14, 268, w - 28, 18)}
        <rect x="${x - 6}" y="304" width="${w + 12}" height="50" rx="14" fill="#A82E3A"/>
        <rect x="${x - 6}" y="304" width="${w + 12}" height="12" rx="6" fill="#C9404D"/>`;
      const th = drawThings(k, { x: 130, y: 372, w: 540, h: 96 });
      const tray = th ? '' : `<g transform="translate(400 420)">
        <ellipse cx="0" cy="8" rx="120" ry="24" fill="#B9852C"/><ellipse cx="0" cy="0" rx="120" ry="24" fill="#E3B04B"/><ellipse cx="0" cy="0" rx="100" ry="17" fill="#F0C665"/>
        <g transform="translate(-40 6)"><ellipse cx="0" cy="0" rx="26" ry="6" fill="#B9852C"/>
          <path d="M-26 0 C-34 -20 -26 -40 -12 -46 L-10 -56 C-16 -60 -18 -66 -12 -70 L12 -70 C18 -66 16 -60 10 -56 L12 -46 C26 -40 34 -20 26 0Z" fill="#E8B84E"/>
          <path d="M8 -44 C22 -38 28 -20 22 -2" fill="none" stroke="#FFF1B8" stroke-width="4" stroke-linecap="round" opacity=".7"/>
          <path d="M-12 -70 C-12 -84 -6 -92 0 -94 C6 -92 12 -84 12 -70Z" fill="#D9A23C"/><circle cx="0" cy="-99" r="5" fill="#D9A23C"/>
          <path d="M-24 -18 C-40 -30 -44 -60 -64 -80 L-57 -84 C-38 -66 -32 -42 -17 -31Z" fill="#D9A23C"/>
          <path d="M22 -12 C46 -20 46 -56 13 -61" fill="none" stroke="#C99332" stroke-width="7" stroke-linecap="round"/></g>
        <g transform="translate(30 4)"><path d="M-12 -18 L12 -18 L8 0 L-8 0Z" fill="#fff"/><path d="M-12 -18 L12 -18" stroke="#3E7FD8" stroke-width="3"/></g>
        <g transform="translate(62 2)"><path d="M-12 -18 L12 -18 L8 0 L-8 0Z" fill="#fff"/><path d="M-12 -18 L12 -18" stroke="#3E7FD8" stroke-width="3"/></g>
      </g>`;
      const inner = `<rect width="${SW}" height="${SH}" fill="#FCE3C4"/><rect width="${SW}" height="46" fill="#F6D2A4"/>${band}
        ${archWindow(330, 64, 140, 190, 'none', winSky + sky)}
        ${cushion(30, 240)}${cushion(530, 240)}
        <rect y="352" width="${SW}" height="${SH - 352}" fill="#E7CBA6"/>
        <rect x="110" y="368" width="580" height="104" rx="10" fill="#B83A46"/>
        <rect x="124" y="380" width="552" height="80" rx="6" fill="none" stroke="#FFE7C2" stroke-width="4" stroke-dasharray="14 8"/>
        ${tray}${th}`;
      return frame(k, inner);
    },
    async intro(k) { await introThings(k); },
    async set(k, p) {
      if (has(p.time)) {
        const night = p.time === 'night';
        const sky = k.$('.kp-sky');
        go(k.$('.kp-day'), [{ opacity: night ? 1 : 0 }, { opacity: night ? 0 : 1 }], { duration: 900 });
        sky.animate([{ fill: night ? '#A8DCFF' : '#24306E' }, { fill: night ? '#24306E' : '#A8DCFF' }], { duration: 1200, fill: 'forwards' });
        await go(k.$('.kp-night'), [{ opacity: night ? 0 : 1 }, { opacity: night ? 1 : 0 }], { duration: 1200, delay: 300 });
      }
      await setThings(k, p);
    },
  }, ['house', 'majlis', 'room']);

  // ---------------------------------------------------------------- park
  // {"name":"park","things":{"emoji":"🐦","n":5},"where":"ground|sky"}   propset {"n":3}: two fly away.
  def('park', {
    vb: () => [SW, SH],
    draw(k) {
      const p = k.p;
      const sky = p.where === 'sky' || /[🐦🦅🕊🦋🐝🎈🪁🦜]/u.test(JSON.stringify(p.things || p.emoji || ''));
      const frond = (a, l, c) => `<path transform="rotate(${a})" d="M0 0 C${l * 0.3} -26 ${l * 0.75} -24 ${l} 6 C${l * 0.7} -6 ${l * 0.3} -6 0 0Z" fill="${c}"/>`;
      let trunk = '';
      for (let i = 0; i < 8; i++) trunk += `<path d="M${-12 + i * 1.6} ${-i * 26} q 14 6 26 0" fill="none" stroke="#8A5530" stroke-width="3" opacity=".6"/>`;
      const inner = `<defs><linearGradient id="${k.id('sky')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#86CCFF"/><stop offset="1" stop-color="#D6F0FF"/></linearGradient></defs>
        <rect width="${SW}" height="${SH}" fill="url(#${k.id('sky')})"/>
        <circle cx="700" cy="78" r="40" fill="#FFE07A" opacity=".45"/><circle cx="700" cy="78" r="30" fill="#FFD84D"/>
        <path d="M110 120 q 20 -26 46 -6 q 22 -18 42 6 q 18 2 10 18 h -110 q -10 -14 12 -18z" fill="#fff"/>
        <path d="M470 70 q 16 -20 36 -4 q 18 -14 32 4 q 14 2 8 14 h -86 q -8 -10 10 -14z" fill="#fff" opacity=".9"/>
        <path d="M0 330 C140 270 260 300 380 290 C520 280 640 250 800 300 V${SH} H0Z" fill="#9BE08A"/>
        <path d="M0 360 C200 330 420 350 800 340 V${SH} H0Z" fill="#5FC25A"/>
        <g transform="translate(110 360)"><path d="M-12 0 C-16 -80 -4 -150 16 -210 L28 -206 C12 -150 4 -80 12 0Z" fill="#B57744"/>${trunk}
          <g transform="translate(22 -208)">${frond(-170, 110, '#2E9A50')}${frond(-120, 100, '#3DB860')}${frond(-60, 100, '#3DB860')}${frond(-10, 110, '#2E9A50')}${frond(-200, 80, '#5BD47A')}${frond(20, 80, '#5BD47A')}
          <circle cx="-6" cy="8" r="9" fill="#8A4B22"/><circle cx="8" cy="10" r="9" fill="#9C5A2A"/></g></g>
        <g transform="translate(640 372)">
          <rect x="40" y="-150" width="10" height="150" fill="#3E7FD8"/><rect x="80" y="-150" width="10" height="150" fill="#3E7FD8"/>
          ${[0, 1, 2, 3, 4].map((i) => `<rect x="44" y="${-28 - i * 26}" width="42" height="7" rx="3" fill="#6CB6FF"/>`).join('')}
          <rect x="30" y="-160" width="70" height="14" rx="6" fill="#FF6B8B"/>
          <path d="M34 -150 C0 -150 -10 -100 -50 -40 C-62 -22 -80 -10 -100 -6 L-100 8 C-70 8 -48 -8 -34 -30 C-6 -76 6 -136 40 -136Z" fill="#FFC857"/>
          <path d="M34 -150 C0 -150 -10 -100 -50 -40 C-62 -22 -80 -10 -100 -6" fill="none" stroke="#FF9F5A" stroke-width="6" stroke-linecap="round"/>
        </g>`;
      k.s.flyUp = true;
      const th = drawThings(k, sky ? { x: 230, y: 70, w: 360, h: 170 } : { x: 220, y: 360, w: 380, h: 100 });
      return frame(k, inner + th);
    },
    async intro(k) { await introThings(k); },
    async set(k, p) { await setThings(k, p); },
  }, ['garden', 'outside', 'playground']);

  // --------------------------------------------------------------- space
  // {"name":"space","things":{"emoji":"⭐","n":6},"rocket":true}   propset {"launch":true} or {"n":..}.
  def('space', {
    vb: () => [SW, SH],
    draw(k) {
      let stars = '';
      let seed = 7;
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      for (let i = 0; i < 46; i++) stars += `<circle cx="${(rnd() * SW).toFixed(0)}" cy="${(rnd() * SH).toFixed(0)}" r="${(0.8 + rnd() * 2.2).toFixed(1)}" fill="#fff" opacity="${(0.35 + rnd() * 0.6).toFixed(2)}"/>`;
      const rocket = k.p.rocket === false ? '' : `<g transform="translate(120 360) rotate(35)"><g class="kp-rocket">
        <path d="M-14 40 Q0 76 14 40Z" fill="#FF9F5A"/><path d="M-8 40 Q0 62 8 40Z" fill="#FFE07A"/>
        <path d="M-22 30 L-36 52 L-14 44Z" fill="#FF6B8B"/><path d="M22 30 L36 52 L14 44Z" fill="#FF6B8B"/>
        <path d="M0 -60 C22 -40 24 0 18 44 L-18 44 C-24 0 -22 -40 0 -60Z" fill="#F4F6FB"/>
        <path d="M0 -60 C10 -51 15 -42 17 -34 L-17 -34 C-15 -42 -10 -51 0 -60Z" fill="#FF6B8B"/>
        <circle cx="0" cy="-6" r="11" fill="#6CB6FF" stroke="#C9D2E3" stroke-width="4"/></g></g>`;
      const inner = `<defs><radialGradient id="${k.id('sp')}" cx=".6" cy=".3" r=".9"><stop offset="0" stop-color="#3B3591"/><stop offset="1" stop-color="#120E3A"/></radialGradient></defs>
        <rect width="${SW}" height="${SH}" fill="url(#${k.id('sp')})"/>${stars}
        <g transform="translate(130 110)"><ellipse rx="86" ry="20" fill="none" stroke="#FFC857" stroke-width="7" transform="rotate(-14)" opacity=".9"/>
          <circle r="48" fill="#C79BFF"/><path d="M-46 -12 Q0 -2 46 -16 M-44 14 Q0 22 44 10" stroke="#A97FE8" stroke-width="9" fill="none"/>
          <path d="M-86 0 A86 20 0 0 0 86 0" transform="rotate(-14)" fill="none" stroke="#FFC857" stroke-width="7" opacity=".9"/></g>
        <g transform="translate(720 420)"><circle r="110" fill="#D9DCE8"/><circle cx="-50" cy="-40" r="20" fill="#BFC4D6"/><circle cx="-10" cy="-78" r="11" fill="#BFC4D6"/><circle cx="-70" cy="20" r="13" fill="#BFC4D6"/></g>
        ${rocket}`;
      k.s.flyUp = true;
      return frame(k, inner + drawThings(k, { x: 230, y: 150, w: 360, h: 190 }));
    },
    async intro(k) { await introThings(k); },
    async set(k, p) {
      if (p.launch) {
        const r = k.$('.kp-rocket');
        await go(r, [{ transform: 'translate(0,0)' }, { transform: 'translate(-3px,2px)', offset: 0.08 }, { transform: 'translate(3px,0)', offset: 0.16 },
          { transform: 'translate(-3px,1px)', offset: 0.24 }, { transform: 'translate(0,-760px)' }], { duration: 1900, easing: 'cubic-bezier(.5,0,.8,.6)' });
      }
      await setThings(k, p);
    },
  }, ['sky', 'stars']);

  // ---------------------------------------------------------------- shop
  // {"name":"shop","items":[{"emoji":"🧃","price":2},{"emoji":"🍞","price":3}]}   a baqala; prices in riyals.
  // propset {"buy":2}: item 2 hops into the basket and the total counts up. {"reset":true}.
  def('shop', {
    vb: () => [SW, SH],
    draw(k) {
      const items = (k.p.items || []).slice(0, 4).map((it) => (typeof it === 'string' ? { emoji: it } : it));
      k.s.items = items;
      k.s.total = 0;
      const rtl = k.rtl;
      const bx = rtl ? 100 : SW - 100;   // the basket sits where reading ends
      k.s.basket = { x: bx, y: 384 };
      const n = Math.max(1, items.length);
      const x0 = rtl ? 210 : 40, span = 550;
      let scal = '', stripes = '';
      for (let i = 0; i < 17; i++) {
        stripes += `<rect x="${i * 50}" y="0" width="50" height="70" fill="${i % 2 ? '#fff' : '#2FA866'}"/>`;
        scal += `<path d="M${i * 50} 70 a25 22 0 0 0 50 0z" fill="${i % 2 ? '#fff' : '#2FA866'}"/>`;
      }
      const box = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${c}"/><rect x="${x + 4}" y="${y + h * 0.3}" width="${w - 8}" height="${h * 0.25}" rx="2" fill="#fff" opacity=".7"/>`;
      let shelf = '';
      const cols = ['#FF6B8B', '#FFC857', '#6CB6FF', '#5BE49B', '#C79BFF', '#FF9F5A'];
      for (let r = 0; r < 2; r++) for (let i = 0; i < 11; i++) shelf += box(60 + i * 64, 118 + r * 84 + (i % 3) * 6, 46, 56 - (i % 3) * 6, cols[(i + r * 2) % 6]);
      shelf = `<g opacity=".38">${shelf}</g>`;
      const sign = `<rect x="300" y="12" width="200" height="62" rx="16" fill="#fff" ${k.shadow}/>${txt(400, 45, k.t('shop'), 40, { fill: '#1F8A4C', fit: 180 })}`;
      const tags = items.map((it, i) => {
        const slot = rtl ? n - 1 - i : i;
        const cx = x0 + span * (slot + 0.5) / n;
        const price = has(it.price) ? `${k.d(it.price)} ${Number(it.price) === 1 || k.rtl ? k.t('riyal') : k.t('riyals')}` : '';
        return `<g class="kp-item" data-i="${i}" data-part="item${i + 1}"><g class="kp-goods">${emo(it.emoji, cx, 262, 100)}</g>
          ${price ? `<g ${k.shadow}><rect x="${cx - 66}" y="352" width="132" height="54" rx="10" fill="#FFF7D6"/><circle cx="${cx - 50}" cy="379" r="5" fill="#C9A85A"/></g>${txt(cx + 8, 381, price, 32, { fit: 104 })}` : ''}
          ${has(it.label) ? txt(cx, 440, it.label, 28, { fill: '#fff', fit: span / n - 10 }) : ''}</g>`;
      }).join('');
      const basket = `<g transform="translate(${bx} 384)"><g class="kp-basket">
        <path d="M-50 -20 C-50 -84 50 -84 50 -20" fill="none" stroke="#8A5530" stroke-width="8"/>
        <g class="kp-in"></g>
        <path d="M-66 -24 H66 L54 46 H-54Z" fill="#D9984F"/><path d="M-60 0 H60 M-57 22 H57" stroke="#B57744" stroke-width="5"/>
        <path d="M-30 -24 L-26 46 M0 -24 V46 M30 -24 L26 46" stroke="#B57744" stroke-width="4"/></g></g>
        <g class="kp-total" style="opacity:0"><rect x="${bx - 82}" y="196" width="164" height="96" rx="20" fill="#fff" ${k.shadow}/>
          ${txt(bx, 224, k.t('total'), 26, { fill: '#1F8A4C', fit: 150 })}${txt(bx, 264, '', 42, { cls: 'kp-sum', fit: 150, dir: k.rtl ? 'rtl' : 'ltr' })}</g>`;
      const inner = `<rect width="${SW}" height="${SH}" fill="#FFF6E6"/>${stripes}${scal}
        <rect x="40" y="104" width="720" height="190" rx="10" fill="#F2E1C4"/>${shelf}
        <rect x="40" y="178" width="720" height="10" fill="#C9A06E"/><rect x="40" y="262" width="720" height="10" fill="#C9A06E"/>
        <rect y="318" width="${SW}" height="${SH - 318}" fill="#2FA0A8"/><rect y="306" width="${SW}" height="26" rx="6" fill="#4CC3C9"/>
        ${sign}${tags}`;
      return frame(k, inner, basket);
    },
    async intro(k) {
      const it = k.$$('.kp-goods');
      hide(it);
      await k.wait(500);
      for (const e of it) { pop(e); await k.wait(260); }
    },
    async set(k, p) {
      if (p.reset) { k.$('.kp-in').innerHTML = ''; k.s.total = 0; hide(k.$('.kp-total')); k.$$('.kp-goods').forEach((g) => { g.style.opacity = ''; delete g.dataset.bought; }); }
      if (!has(p.buy)) return;
      for (const b of [].concat(p.buy)) {
        const i = clamp(int(b, 1), 1, k.s.items.length) - 1;
        const item = k.s.items[i];
        const g = k.$(`.kp-item[data-i="${i}"] .kp-goods`);
        if (!g || g.dataset.bought) continue;
        g.dataset.bought = '1';
        const sx = Number(g.querySelector('text').getAttribute('x')), sy = 262;
        const { x: bx, y: by } = k.s.basket;
        const dx = bx - sx, dy = by - 40 - sy;
        await go(g, [{ transform: 'translate(0,0) scale(1)' }, { transform: `translate(${dx * 0.5}px,${dy - 150}px) scale(.8)`, offset: 0.5 },
          { transform: `translate(${dx}px,${dy}px) scale(.5)` }], { duration: 820, easing: 'cubic-bezier(.3,.6,.4,1)' });
        g.style.opacity = '0';
        g.style.transform = '';
        const n = k.$('.kp-in').childElementCount;
        k.add(emo(item.emoji, -28 + (n % 3) * 28, -34 - Math.floor(n / 3) * 12, 54), k.$('.kp-in'));
        bump(k.$('.kp-basket'), 1.1);
        const from = k.s.total;
        k.s.total += num(item.price, 0);
        const tot = k.$('.kp-total');
        if (tot.style.opacity === '0') fade(tot);
        const sum = k.$('.kp-sum');
        const unit = k.t('riyal');
        await tween(600, (e) => { sum.textContent = `${k.d(Math.round(from + (k.s.total - from) * e))} ${unit}`; });
        k.fit(tot);
        bump(sum, 1.25);
        await k.wait(250);
      }
    },
  }, ['baqala', 'store', 'market', 'dukkan']);

  // ============================================================== math
  const PLACE = ['ones', 'tens', 'hundreds', 'thousands'];
  const PLACE_COL = { ones: '#FF9F5A', tens: '#4CD68A', hundreds: '#6CB6FF', thousands: '#C79BFF' };
  const placeOf = (f) => {
    const k = String(f || '').toLowerCase();
    if (/^(one|unit|آحاد|احاد|الآحاد|الاحاد)/.test(k)) return 'ones';
    if (/^(ten|عشرات|العشرات)/.test(k)) return 'tens';
    if (/^(hund|مئات|المئات)/.test(k)) return 'hundreds';
    if (/^(thou|ألوف|الوف|آلاف)/.test(k)) return 'thousands';
    return null;
  };
  // A badge for a comparison sign, drawn as a shape (never bidi-mirrored):
  // the open side faces the bigger number, wherever it sits on screen.
  function signPath(kind) {
    if (kind === '=') return '<path d="M-22 -11 H22 M-22 11 H22" fill="none" stroke="#2A2140" stroke-width="11" stroke-linecap="round"/>';
    const s = kind === '>' ? 1 : -1;   // '>' opens to the left
    return `<path d="M${-18 * s} -26 L${22 * s} 0 L${-18 * s} 26" fill="none" stroke="#2A2140" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  // ------------------------------------------------------------ compare
  // {"name":"compare","a":456,"b":378,"focus":"hundreds"}   two numbers and a crocodile between them.
  // propset {"reveal":true}: it turns to the bigger number and chomps; the sign appears.
  // propset {"focus":"tens"} lights that digit in both; {"a":..,"b":..} a new pair (neutral again).
  const CROC = { g: '#4CC37A', g2: '#3AA866', g3: '#6BD892', belly: '#D8F5B0', dark: '#2E7A4C' };
  // Side view facing right; the jaws hinge at (-24, 8).
  function crocSide() {
    let up = '', low = '';
    for (let x = 4; x <= 104; x += 20) { up += `M${x} 8 l7 11 l7 -11z `; low += `M${x + 8} 8 l7 -11 l7 11z `; }
    return `<g class="kp-croc-side">
      <g class="kp-croc-mouth" style="opacity:0"><path d="M-24 8 L98 -50 Q118 4 104 58Z" fill="#A3304F"/><ellipse cx="56" cy="20" rx="40" ry="10" fill="#FF7A95"/></g>
      <path d="M-120 34 C-132 -10 -108 -62 -56 -68 C-24 -72 -2 -56 6 -40 L6 44 C-24 60 -96 66 -120 34Z" fill="${CROC.g}"/>
      <circle cx="-96" cy="-40" r="11" fill="${CROC.g2}"/><circle cx="-112" cy="-16" r="9" fill="${CROC.g2}"/><circle cx="-116" cy="8" r="7" fill="${CROC.g2}"/>
      <g class="kp-croc-low" style="transform-origin:-24px 8px"><path d="M-34 8 L120 8 C134 8 138 24 126 32 C102 44 40 48 0 46 C-26 44 -40 30 -34 8Z" fill="${CROC.g}"/>
        <path d="M-20 38 C20 46 80 44 120 30" fill="none" stroke="${CROC.belly}" stroke-width="7" stroke-linecap="round"/><path d="${low}" fill="#fff"/></g>
      <g class="kp-croc-up" style="transform-origin:-24px 8px"><path d="M-34 8 C-34 -30 -12 -46 20 -46 L120 -36 C144 -33 152 -14 140 0 C134 6 126 8 120 8Z" fill="${CROC.g}"/>
        <ellipse cx="128" cy="-28" rx="6" ry="4" fill="${CROC.dark}"/><path d="M10 -40 C50 -40 90 -36 116 -32" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".22"/>
        <path d="${up}" fill="#fff"/></g>
      <ellipse cx="-70" cy="18" rx="14" ry="8" fill="#FF7FA8" opacity=".5"/>
      <g transform="translate(-40 -64)"><circle r="31" fill="${CROC.g}"/><circle cx="4" cy="-4" r="21" fill="#fff"/><circle cx="12" cy="-4" r="10.5" fill="${INK}"/><circle cx="15" cy="-8" r="3.8" fill="#fff"/>
        <path d="M-20 -22 Q4 -34 26 -20" fill="none" stroke="${CROC.dark}" stroke-width="5" stroke-linecap="round"/></g>
    </g>`;
  }
  def('compare', {
    vb(p) {
      const L = Math.max(String(Math.abs(int(p.a, 0))).length, String(Math.abs(int(p.b, 0))).length);
      const cw = Math.max(230, L * 82 + 70);
      return [2 * cw + 330, 470];
    },
    draw(k) {
      const p = k.p, a = int(p.a, 0), b = int(p.b, 0);
      const L = Math.max(String(Math.abs(a)).length, String(Math.abs(b)).length);
      const cw = Math.max(230, L * 82 + 70), W2 = 2 * cw + 330;
      // a is said first: on the right of an Arabic board.
      const left = k.rtl ? b : a, right = k.rtl ? a : b;
      k.s = { ...k.s, a, b, left, right, cw, W2, revealed: false };
      const card = (x, v, side) => {
        const s = String(Math.abs(v)), n = s.length;
        const digitsSvg = [...s].map((ch, i) => {
          const place = PLACE[n - 1 - i] || 'ones';
          const dx = x + (i - (n - 1) / 2) * 82;
          return `<g class="kp-dg" data-place="${place}">${txt(dx, 175, k.d(ch), 140, { fill: INK })}</g>`;
        }).join('');
        return `<g class="kp-card kp-card-${side}" data-part="${side}">
          <rect x="${x - cw / 2 + 10}" y="74" width="${cw - 20}" height="210" rx="34" fill="#C9CFF0"/>
          <rect x="${x - cw / 2 + 10}" y="64" width="${cw - 20}" height="210" rx="34" fill="#fff"/>
          ${digitsSvg}<g class="kp-placetags"></g></g>`;
      };
      const xL = cw / 2 + 10, xR = W2 - cw / 2 - 10, xc = W2 / 2;
      k.s.xs = { left: xL, right: xR };
      return `<defs>${k.cutDef()}</defs>
        ${card(xL, left, 'left')}${card(xR, right, 'right')}
        <g transform="translate(${xc} 200) scale(.86)"><ellipse cx="10" cy="128" rx="110" ry="12" fill="#0a0628" opacity=".25"/><g class="kp-croc" ${k.cut}>
          <g class="kp-side-flip"><g class="kp-croc-sq" style="transform-origin:10px 10px"><g class="kp-croc-turn" style="transform-origin:10px 10px;transform:rotate(-90deg)">${crocSide()}</g></g></g>
          <g class="kp-croc-q"><text x="88" y="-118" font-size="76" text-anchor="middle" dominant-baseline="central" fill="#FFC857" stroke="${INK}" stroke-width="4" paint-order="stroke" font-weight="800" style="font-family:${FONT}">?</text></g></g></g>
        <g transform="translate(${xc} 392)"><g class="kp-sign" style="opacity:0"><circle r="50" fill="#FFC857"/><circle r="42" fill="#FFE59A"/><g class="kp-sign-glyph"></g></g></g>`;
    },
    async intro(k) {
      const cards = k.$$('.kp-card'), croc = k.$('.kp-croc');
      hide(cards, croc);
      const order = k.rtl ? cards.slice().reverse() : cards;
      pop(order[0]); await k.wait(350);
      pop(order[1]); await k.wait(450);
      await pop(croc);
      const q = k.$('.kp-croc-q text');
      if (q) O(q).animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-8px)' }, { transform: 'translateY(0)' }], { duration: 1400, iterations: 3, easing: 'ease-in-out' });
      if (has(k.p.focus)) await this.set(k, { focus: k.p.focus });
      if (k.p.reveal || k.p.show) await this.set(k, { reveal: true });
    },
    ownFocus: true,
    async set(k, p) {
      if (has(p.a) || has(p.b)) {
        Object.assign(k.p, { a: p.a ?? k.p.a, b: p.b ?? k.p.b, reveal: false, focus: null });
        const vb = this.vb(k.p);
        k.svg.setAttribute('viewBox', `0 0 ${vb[0]} ${vb[1]}`);
        k.root.innerHTML = this.draw(k);
        k.fit();
        await this.intro(k);
      }
      if (has(p.focus)) {
        const place = placeOf(p.focus);
        for (const g of k.$$('.kp-dg')) {
          const on = !place || g.dataset.place === place;
          g.classList.toggle('kp-soft', !on);
          g.querySelector('text').setAttribute('fill', place && on ? shade(PLACE_COL[place], -0.25) : INK);
          if (place && on) bump(g, 1.15, 500);
        }
        for (const t of k.$$('.kp-placetags')) {
          t.innerHTML = '';
          if (!place) continue;
          const dg = t.parentNode.querySelector(`.kp-dg[data-place="${place}"] text`);
          if (!dg) continue;
          const tag = k.add(pill(Number(dg.getAttribute('x')), 318, k.t(place), { size: 26, fill: shade(PLACE_COL[place], -0.2), w: 120 }), t);
          k.fit(tag);
          pop(tag);
        }
      }
      if (p.reveal || p.show || p.answer) await reveal(k);
    },
  }, ['crocodile', 'croc', 'compare2', 'greater', 'comparison']);

  async function reveal(k) {
    if (k.s.revealed) return;
    k.s.revealed = true;
    const { left, right } = k.s;
    const sign = k.$('.kp-sign');
    const kind = left > right ? '>' : left < right ? '<' : '=';
    k.$('.kp-croc-q')?.remove();
    const croc = k.$('.kp-croc'), turn = k.$('.kp-croc-turn'), sq = k.$('.kp-croc-sq'), flip = k.$('.kp-side-flip');
    if (kind === '=') {   // equal: it nods, happy, and the = sign
      await go(O(croc, 'center bottom'), [{ transform: 'translateY(0)' }, { transform: 'translateY(-16px)' }, { transform: 'translateY(0)' }, { transform: 'translateY(-10px)' }, { transform: 'translateY(0)' }], { duration: 800 });
    } else {
      // It swings its snout down toward the bigger number (mirrored first to face left).
      const dir = kind === '<' ? 1 : -1;
      if (dir < 0) {
        await go(sq, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 160, easing: 'ease-in' });
        flip.setAttribute('transform', 'translate(20 0) scale(-1 1)');
        await go(sq, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 160, easing: 'ease-out' });
      }
      await go(turn, [{ transform: 'rotate(-90deg)' }, { transform: 'rotate(8deg)', offset: 0.75 }, { transform: 'rotate(0deg)' }], { duration: 620, easing: 'cubic-bezier(.4,0,.3,1)' });
      const up = k.$('.kp-croc-up'), low = k.$('.kp-croc-low'), mouth = k.$('.kp-croc-mouth');
      const jaw = async (a, ms) => {
        mouth.style.opacity = a > 2 ? '1' : '0';
        await Promise.all([go(up, [{ transform: `rotate(${-a}deg)` }], { duration: ms }), go(low, [{ transform: `rotate(${a * 0.8}deg)` }], { duration: ms })]);
      };
      // Chomp twice toward the bigger number, then hold the mouth wide open.
      const lean = go(O(croc, 'center bottom'), [{ transform: 'translateX(0px)' }, { transform: `translateX(${dir * 10}px)` }], { duration: 400 });
      for (let i = 0; i < 2; i++) { await jaw(26, 210); await jaw(0, 120); }
      await jaw(28, 260);
      await lean;
      bump(k.$(`.kp-card-${kind === '<' ? 'right' : 'left'}`), 1.08, 520);
    }
    k.$('.kp-sign-glyph').innerHTML = signPath(kind);
    await pop(sign);
  }

  // ----------------------------------------------------- place value
  // {"name":"placevalue","n":347,"style":"houses|columns|blocks","digits":true}
  // Hundreds, tens and ones houses with base-ten blocks inside.
  // propset {"add":1} (ten ones become a ten and move house), {"sub":1}, {"n":352}, {"digits":true}, {"focus":"tens"}.
  const HW = 250, HG = 26;
  function pvPlaces(p) {
    const n = Math.abs(int(p.n ?? p.number ?? p.value, 0));
    return clamp(int(p.places, Math.max(2, String(n).length)), 1, 3);
  }
  const pvX = (k, place) => {   // left edge of a house
    const i = k.s.places - 1 - PLACE.indexOf(place);
    return 20 + i * (HW + HG);
  };
  // Blocks are drawn at (0,0) and placed by their wrapper's translate, so a
  // house can re-centre its blocks when one comes or goes.
  function cubeSvg(s, c) {
    return `<rect y="3" width="${s}" height="${s}" rx="${s * 0.2}" fill="${shade(c, -0.3)}"/>
      <rect width="${s}" height="${s}" rx="${s * 0.2}" fill="${c}"/>
      <rect x="${s * 0.16}" y="${s * 0.14}" width="${s * 0.5}" height="${s * 0.16}" rx="${s * 0.08}" fill="#fff" opacity=".45"/>`;
  }
  function rodSvg(u, c) {
    let lines = '';
    for (let i = 1; i < 10; i++) lines += `<path d="M2 ${i * u} H${u - 2}" stroke="${shade(c, -0.32)}" stroke-width="1.6"/>`;
    return `<rect y="3" width="${u}" height="${u * 10}" rx="${u * 0.25}" fill="${shade(c, -0.3)}"/>
      <rect width="${u}" height="${u * 10}" rx="${u * 0.25}" fill="${c}"/>${lines}
      <rect x="${u * 0.2}" y="4" width="${u * 0.18}" height="${u * 10 - 8}" rx="2" fill="#fff" opacity=".35"/>`;
  }
  function flatSvg(s, c) {
    let lines = '';
    for (let i = 1; i < 10; i++) lines += `<path d="M${i * s / 10} 2 V${s - 2} M2 ${i * s / 10} H${s - 2}" stroke="${shade(c, -0.28)}" stroke-width="1.3"/>`;
    return `<rect y="4" width="${s}" height="${s}" rx="${s * 0.08}" fill="${shade(c, -0.3)}"/>
      <rect width="${s}" height="${s}" rx="${s * 0.08}" fill="${c}"/>${lines}`;
  }
  // Where n blocks sit in a house (interior 220 x 260 from (x0+15, 150)):
  // ones in rows of five like a ten-frame, tens side by side, hundreds in
  // rows of three; always centred.
  const ONE = 36, ROD = 20, FLAT = 66;
  function layout(k, place, n) {
    const x0 = pvX(k, place) + 15, y0 = 150, out = [];
    if (place === 'ones') {
      const rows = n > 5 ? 2 : 1, gx = 7, gy = 12;
      const top = y0 + (260 - (rows * ONE + (rows - 1) * gy)) / 2, left = x0 + (220 - (5 * ONE + 4 * gx)) / 2;
      for (let i = 0; i < n; i++) {
        const c = i % 5, cc = k.rtl ? 4 - c : c;
        out.push({ x: left + cc * (ONE + gx), y: top + Math.floor(i / 5) * (ONE + gy) });
      }
    } else if (place === 'tens') {
      const g = 3, w = n * ROD + (n - 1) * g;
      for (let i = 0; i < n; i++) out.push({ x: x0 + 110 - w / 2 + i * (ROD + g), y: y0 + 30 });
    } else {
      const g = 10, rows = Math.ceil(n / 3), top = y0 + (260 - (rows * FLAT + (rows - 1) * g)) / 2;
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / 3), inRow = Math.min(3, n - r * 3), w = inRow * FLAT + (inRow - 1) * g;
        out.push({ x: x0 + 110 - w / 2 + (i % 3) * (FLAT + g), y: top + r * (FLAT + g) });
      }
    }
    return out;
  }
  function piece(k, place, pos) {
    const c = PLACE_COL[place];
    const body = place === 'ones' ? cubeSvg(ONE, c) : place === 'tens' ? rodSvg(ROD, c) : flatSvg(FLAT, c);
    return `<g class="kp-pc" transform="translate(${pos.x} ${pos.y})"><g class="kp-b">${body}</g></g>`;
  }
  const posOf = (el) => { const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)/.exec(el.getAttribute('transform') || ''); return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 }; };
  // Slide a house's blocks to their centred places for the current count
  // (plus `extra` places kept free for blocks about to arrive).
  function relayout(k, place, ms = 380, extra = 0) {
    const els = k.$$(`.kp-house[data-place="${place}"] .kp-pc`);
    const pos = layout(k, place, els.length + extra);
    return Promise.all(els.map((e, i) => {
      const a = posOf(e), b = pos[i];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5) return null;
      return tween(ms, (t) => e.setAttribute('transform', `translate(${a.x + (b.x - a.x) * t} ${a.y + (b.y - a.y) * t})`), easeInOut);
    }));
  }
  def('placevalue', {
    vb(p) { const n = pvPlaces(p); return [40 + n * HW + (n - 1) * HG, 560]; },
    draw(k) {
      const p = k.p;
      k.s.places = pvPlaces(p);
      const n = Math.abs(int(p.n ?? p.number ?? p.value, 0)) % (10 ** k.s.places);
      k.s.v = { hundreds: Math.floor(n / 100) % 10, tens: Math.floor(n / 10) % 10, ones: n % 10 };
      k.s.showDigits = p.digits !== false;
      const style = /col/.test(p.style || '') ? 'columns' : /block|plain/.test(p.style || '') ? 'blocks' : 'houses';
      let m = `<defs>${k.cutDef()}</defs>`;
      for (let i = k.s.places - 1; i >= 0; i--) {
        const place = PLACE[i], x0 = pvX(k, place), c = PLACE_COL[place];
        let frameSvg = '';
        if (style === 'houses') {
          frameSvg = `<path d="M${x0 - 12} 136 L${x0 + HW / 2} 26 L${x0 + HW + 12} 136Z" fill="${shade(c, -0.25)}" transform="translate(0 6)"/>
            <path d="M${x0 - 12} 136 L${x0 + HW / 2} 26 L${x0 + HW + 12} 136Z" fill="${c}" stroke="${c}" stroke-width="10" stroke-linejoin="round"/>
            <rect x="${x0}" y="136" width="${HW}" height="290" rx="10" fill="#FFF8EE" stroke="${c}" stroke-width="8"/>
            ${txt(x0 + HW / 2, 104, k.t(place), 34, { fill: '#fff', fit: 150, stroke: shade(c, -0.35), sw: 5 })}`;
        } else if (style === 'columns') {
          frameSvg = `<rect x="${x0}" y="56" width="${HW}" height="370" rx="22" fill="#FFF8EE"/>
            <rect x="${x0}" y="56" width="${HW}" height="70" rx="22" fill="${c}"/><rect x="${x0}" y="100" width="${HW}" height="26" fill="${c}"/>
            ${txt(x0 + HW / 2, 92, k.t(place), 34, { fill: '#fff', fit: 200, stroke: shade(c, -0.35), sw: 5 })}`;
        } else {
          frameSvg = `<rect x="${x0}" y="136" width="${HW}" height="290" rx="22" fill="#fff" opacity=".08"/>`;
        }
        m += `<g class="kp-house" data-part="${place}" data-place="${place}">${frameSvg}<g class="kp-pieces"></g>
          <g class="kp-digit" style="opacity:0"><circle cx="${x0 + HW / 2}" cy="${494}" r="54" fill="${shade(c, -0.3)}"/><circle cx="${x0 + HW / 2}" cy="${488}" r="54" fill="${c}"/>
          ${txt(x0 + HW / 2, 492, k.d(k.s.v[place]), 80, { fill: '#fff', cls: 'kp-dtext', stroke: shade(c, -0.4), sw: 5 })}</g></g>`;
      }
      return m;
    },
    async intro(k) {
      const houses = k.$$('.kp-house');
      hide(houses);
      for (const h of houses) { pop(h); await k.wait(220); }
      await k.wait(300);
      for (let i = k.s.places - 1; i >= 0; i--) {
        const place = PLACE[i], g = k.$(`.kp-house[data-place="${place}"] .kp-pieces`);
        const pos = layout(k, place, k.s.v[place]);
        for (let j = 0; j < k.s.v[place]; j++) {
          const el = k.add(piece(k, place, pos[j]), g).firstElementChild;
          place === 'hundreds' ? pop(el) : drop(el, 0, 90, 420);
          await k.wait(place === 'ones' ? 170 : 210);
        }
        if (k.s.showDigits) { await k.wait(200); pop(k.$(`.kp-house[data-place="${place}"] .kp-digit`)); }
        await k.wait(350);
      }
      if (has(k.p.focus)) k.focus(placeOf(k.p.focus), '.kp-house');
    },
    ownFocus: true,
    async set(k, p) {
      if (has(p.focus)) k.focus(placeOf(p.focus), '.kp-house');
      if (p.digits === true && !k.s.showDigits) {
        k.s.showDigits = true;
        for (const d of k.$$('.kp-digit')) { pop(d); await k.wait(250); }
      }
      let delta = 0;
      const cur = k.s.v.hundreds * 100 + k.s.v.tens * 10 + k.s.v.ones;
      if (has(p.add)) delta = int(p.add, 0);
      if (has(p.sub)) delta = -int(p.sub, 0);
      if (has(p.n)) delta = int(p.n, 0) - cur;
      const max = 10 ** k.s.places - 1;
      delta = clamp(cur + delta, 0, max) - cur;
      if (!delta) return;
      const steps = Math.abs(Math.trunc(delta / 100)) + Math.abs(Math.trunc((delta % 100) / 10)) + Math.abs(delta % 10);
      if (steps > 24) {   // too many to show one by one: rebuild
        k.p.n = cur + delta;
        k.root.innerHTML = this.draw(k);
        k.fit();
        await this.intro(k);
        return;
      }
      const sgn = Math.sign(delta), a = Math.abs(delta);
      const parts = [['hundreds', Math.floor(a / 100)], ['tens', Math.floor(a / 10) % 10], ['ones', a % 10]];
      for (const [place, cnt] of parts) {
        for (let i = 0; i < cnt; i++) {
          if (sgn > 0) await pvAdd(k, place); else await pvSub(k, place);
        }
      }
    },
  }, ['placevalue', 'place', 'houses', 'pv', 'blocks', 'baseten', 'base10']);

  const UP = { ones: 'tens', tens: 'hundreds' };
  async function setDigit(k, place) {
    const d = k.$(`.kp-house[data-place="${place}"] .kp-digit`);
    if (!d || !k.s.showDigits) return;
    const t = d.querySelector('.kp-dtext');
    await go(O(t), [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], { duration: 140 });
    t.textContent = k.d(k.s.v[place]);
    await go(O(t), [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 180, easing: BOUNCE });
  }
  const pcs = (k, place) => k.$$(`.kp-house[data-place="${place}"] .kp-pc`);
  async function pvAdd(k, place) {
    const g = k.$(`.kp-house[data-place="${place}"] .kp-pieces`);
    if (!g) return;
    const n = k.s.v[place] + 1;
    const pos = layout(k, place, n);
    relayout(k, place, 300, 1);
    const el = k.add(piece(k, place, pos[n - 1]), g).firstElementChild;
    await drop(el, 0, 110, 440);
    k.s.v[place] = n;
    await setDigit(k, place);
    if (n >= 10) await pvCarry(k, place);
  }
  // Ten of a kind glow, line up into one bigger block, and it moves house.
  async function pvCarry(k, place) {
    const up = UP[place];
    if (!up || !k.$(`.kp-house[data-place="${up}"]`)) return;
    await k.wait(300);
    const all = pcs(k, place);
    all.forEach((e) => e.classList.add('kp-glow'));
    await k.wait(500);
    const x0 = pvX(k, place) + 15;
    const from = place === 'ones' ? { x: x0 + 110 - ROD / 2, y: 180 } : { x: x0 + 110 - FLAT / 2, y: 247 };
    // Gather into the shape of the bigger block (each scales about its top-left).
    const col = place === 'ones' ? { x: x0 + 110 - ROD / 2, y: 180 } : { x: x0 + 110 - ROD * 5, y: 180 };
    await Promise.all(all.map((e, j) => {
      const a = posOf(e), b = e.firstElementChild;
      const tf = place === 'ones'
        ? `translate(${col.x - a.x}px, ${col.y + j * ROD - a.y}px) scale(${ROD / ONE})`
        : `translate(${col.x + j * ROD - a.x}px, ${col.y - a.y}px) scale(1)`;
      return go(O(b, '0 0'), [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: tf }], { duration: 560, delay: j * 35 });
    }));
    await k.wait(200);
    if (place === 'tens') {   // ten rods side by side make a square: it shrinks to a hundred
      const sq = k.add(`<g class="kp-pc" transform="translate(${col.x} ${col.y})"><g class="kp-b">${flatSvg(ROD * 10, PLACE_COL.hundreds)}</g></g>`, k.$(`.kp-house[data-place="${place}"] .kp-pieces`));
      all.forEach((e) => e.remove());
      await go(O(sq.firstElementChild, '0 0'), [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: `translate(${from.x - col.x}px, ${from.y - col.y}px) scale(${FLAT / (ROD * 10)})` }], { duration: 500 });
      sq.remove();
    } else {
      all.forEach((e) => e.remove());
    }
    k.s.v[place] = 0;
    setDigit(k, place);
    // The new block flies to the next house.
    const gUp = k.$(`.kp-house[data-place="${up}"] .kp-pieces`);
    const n = k.s.v[up] + 1;
    relayout(k, up, 500, 1);
    const to = layout(k, up, n)[n - 1];
    const nb = k.add(piece(k, up, to), gUp);
    const dx = from.x - to.x, dy = from.y - to.y;
    nb.classList.add('kp-glow');
    await go(nb.firstElementChild, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: `translate(${dx / 2}px, ${dy / 2 - 120}px)`, offset: 0.5 },
      { transform: 'translate(0px, 0px)' }], { duration: 900, easing: 'cubic-bezier(.4,.1,.3,1)' });
    nb.classList.remove('kp-glow');
    k.s.v[up] = n;
    await setDigit(k, up);
    bump(k.$(`.kp-house[data-place="${up}"]`), 1.04, 400);
    if (n >= 10) await pvCarry(k, up);
  }
  // Take one away; with none left, a block from the next house breaks into ten.
  async function pvSub(k, place) {
    const g = k.$(`.kp-house[data-place="${place}"] .kp-pieces`);
    if (!g) return;
    if (!k.s.v[place]) {
      const up = UP[place];
      if (!up || !k.$(`.kp-house[data-place="${up}"]`)) return;
      if (!k.s.v[up]) await pvSub(k, up);   // borrow further up first
      if (!k.s.v[up]) return;
      const big = pcs(k, up).pop();
      k.s.v[up] -= 1;
      setDigit(k, up);
      const a = posOf(big), x0 = pvX(k, place) + 15;
      const to = place === 'ones' ? { x: x0 + 110 - ROD / 2, y: 180 } : { x: x0 + 110 - FLAT / 2, y: 247 };
      big.classList.add('kp-glow');
      await go(big.firstElementChild, [{ transform: 'translate(0px, 0px)' }, { transform: `translate(${(to.x - a.x) / 2}px, ${(to.y - a.y) / 2 - 120}px)`, offset: 0.5 },
        { transform: `translate(${to.x - a.x}px, ${to.y - a.y}px)` }], { duration: 860, easing: 'cubic-bezier(.4,.1,.3,1)' });
      big.remove();
      relayout(k, up, 400);
      const pos = layout(k, place, 10);
      for (let j = 0; j < 10; j++) pop(k.add(piece(k, place, pos[j]), g).firstElementChild, j * 50, 380);
      k.s.v[place] = 10;
      await k.wait(800);
      await setDigit(k, place);
    }
    const last = pcs(k, place).pop();
    k.s.v[place] -= 1;
    if (last) {
      await go(last.firstElementChild, [{ transform: 'translate(0px, 0px)', opacity: 1 }, { transform: 'translate(0px, -60px)', opacity: 1, offset: 0.4 }, { transform: 'translate(0px, -160px)', opacity: 0 }], { duration: 600, easing: 'ease-in' });
      last.remove();
      relayout(k, place, 350);
    }
    await setDigit(k, place);
  }
  // White numerals on the dark board, with an ink edge so they read anywhere.
  const big = (x, y, s, size, o = {}) => txt(x, y, s, size, { fill: '#fff', stroke: INK, sw: Math.max(5, size / 9), ...o });
  // A round number badge (white digits on a candy disc).
  const badge = (x, y, r, s, c, cls = 'kp-badge') => `<g class="${cls}"><circle cx="${x}" cy="${y + 6}" r="${r}" fill="${shade(c, -0.35)}"/><circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>
    ${txt(x, y + 2, s, r * 1.15, { fill: '#fff', stroke: shade(c, -0.4), sw: 5, cls: 'kp-btext', fit: r * 1.7 })}</g>`;
  async function setBadge(el, s) {
    const t = el?.querySelector('.kp-btext');
    if (!t) return;
    await go(O(t), [{ transform: 'scale(1)' }, { transform: 'scale(.2)' }], { duration: 120 });
    t.textContent = s;
    await go(O(t), [{ transform: 'scale(.2)' }, { transform: 'scale(1)' }], { duration: 220, easing: BOUNCE });
  }
  // A glossy round counter.
  const chip = (c, r = 40) => `<circle r="${r}" cy="4" fill="${shade(c, -0.3)}"/><circle r="${r}" fill="${c}"/><circle r="${r * 0.72}" fill="none" stroke="${shade(c, 0.3)}" stroke-width="3" opacity=".7"/><ellipse cx="${-r * 0.3}" cy="${-r * 0.36}" rx="${r * 0.3}" ry="${r * 0.18}" fill="#fff" opacity=".5"/>`;

  // ---------------------------------------------------------- ten-frame
  // {"name":"tenframe","n":7,"add":3,"number":true}   counters fill a 2 x 5 frame (two frames past ten).
  // propset {"add":2} (new counters in a second colour), {"n":5}, {"number":true}.
  const TF = { cell: 104, gap: 10, x: 40, h: 270 };
  def('tenframe', {
    vb(p) { const tot = int(p.n, 0) + int(p.add, 0); return [800, (int(p.frames, tot > 10 ? 2 : 1) > 1 ? 2 : 1) * TF.h + 20]; },
    draw(k) {
      const p = k.p;
      const n = clamp(int(p.n, 0), 0, 20), add = clamp(int(p.add, 0), 0, 20 - n);
      k.s.frames = int(p.frames, n + add > 10 ? 2 : 1) > 1 ? 2 : 1;
      k.s.cols = [];
      k.s.c1 = col(p.color, C.red); k.s.c2 = col(p.color2, C.yellow);
      k.s.init = [...Array(n).fill(k.s.c1), ...Array(add).fill(k.s.c2)];
      k.s.number = p.number !== false;
      let m = `<defs>${k.cutDef()}</defs><g class="kp-frames">`;
      for (let f = 0; f < k.s.frames; f++) m += this.frameSvg(k, f);
      const cy = 20 + (k.s.frames * TF.h - 26) / 2;
      m += `</g><g class="kp-ctrs"></g><g class="kp-numpos" transform="translate(0 ${cy})"><g class="kp-num" style="opacity:0">${badge(712, 0, 62, k.d(0), C.purple)}</g></g>`;
      return m;
    },
    frameSvg(k, f) {
      const y0 = 20 + f * TF.h;
      let m = `<g class="kp-frame"><rect x="20" y="${y0 + 8}" width="600" height="244" rx="28" fill="#B9C0EA"/><rect x="20" y="${y0}" width="600" height="244" rx="28" fill="#fff"/>`;
      for (let j = 0; j < 10; j++) {
        const c = this.cell(k, f * 10 + j);
        m += `<rect x="${c.x - TF.cell / 2}" y="${c.y - TF.cell / 2}" width="${TF.cell}" height="${TF.cell}" rx="20" fill="#EEF1FF" stroke="#D5DAF5" stroke-width="3"/>`;
      }
      return `${m}</g>`;
    },
    async grow(k) {
      k.s.frames = 2;
      k.resize([0, 0, 800, 2 * TF.h + 20]);
      const fr = k.add(this.frameSvg(k, 1), k.$('.kp-frames'));
      k.$('.kp-numpos').setAttribute('transform', `translate(0 ${20 + (2 * TF.h - 26) / 2})`);
      await pop(fr, 0, 420);
    },
    cell(k, i) {
      const f = Math.floor(i / 10), j = i % 10, r = Math.floor(j / 5), c = k.rtl ? 4 - (j % 5) : j % 5;
      return { x: TF.x + TF.cell / 2 + c * (TF.cell + TF.gap), y: 20 + f * TF.h + 18 + TF.cell / 2 + r * (TF.cell + TF.gap) };
    },
    async place(k, colr) {
      const i = k.s.cols.length;
      if (i >= 20) return;
      if (i >= k.s.frames * 10) await this.grow(k);
      k.s.cols.push(colr);
      const c = this.cell(k, i);
      const el = k.add(`<g transform="translate(${c.x} ${c.y})"><g class="kp-ctr">${chip(colr)}</g></g>`, k.$('.kp-ctrs'));
      await drop(el.firstElementChild, 0, 130, 420);
    },
    async intro(k) {
      await k.wait(400);
      let last = k.s.c1;
      for (const c of k.s.init) {
        if (c !== last) await k.wait(500);
        last = c;
        await this.place(k, c);
        await k.wait(60);
      }
      if (k.s.number) { await k.wait(250); await this.showNum(k); }
    },
    async showNum(k) {
      const g = k.$('.kp-num');
      const s = k.d(k.s.cols.length);
      if (g.style.opacity === '0') { g.querySelector('.kp-btext').textContent = s; await pop(g); } else await setBadge(g, s);
    },
    async set(k, p) {
      if (p.number === true) k.s.number = true;
      if (has(p.add)) for (let i = 0; i < clamp(int(p.add, 0), 0, 20); i++) await this.place(k, k.s.c2);
      if (has(p.n)) {
        const target = clamp(int(p.n, 0), 0, 20);
        while (k.s.cols.length < target) await this.place(k, k.s.c1);
        while (k.s.cols.length > target) {
          k.s.cols.pop();
          const el = k.$('.kp-ctrs').lastElementChild;
          await go(el.firstElementChild, [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-140px)', opacity: 0 }], { duration: 420, easing: 'ease-in' });
          el.remove();
        }
      }
      if (k.s.number) await this.showNum(k);
    },
  }, ['tenframe', 'frame10', 'tenframes', 'counters']);

  // -------------------------------------------------------------- count
  // {"name":"count","emoji":"🍎","n":7,"count":true}   things in rows of five; counting numbers them one by one.
  // propset {"count":true}, {"n":9}, {"take":2} (the last two get crossed out).
  def('count', {
    vb: () => [860, 440],
    draw(k) {
      const p = k.p;
      k.s.n = clamp(int(p.n ?? p.count, 5), 1, 20);
      if (typeof p.count === 'number') k.s.n = clamp(p.count, 1, 20);
      k.s.emoji = p.emoji || '🍎';
      k.s.taken = 0;
      return `<defs>${k.cutDef()}</defs><g class="kp-items"></g><g class="kp-tags"></g>
        <g class="kp-num" style="opacity:0">${badge(k.rtl ? 90 : 770, 220, 66, '', C.purple)}</g>`;
    },
    // Rows of five in the space beside the number badge.
    spot(k, i, n) {
      const cols = Math.min(5, Math.max(n, 1)), rows = Math.ceil(n / 5);
      const size = Math.min(128, 640 / cols * 0.84, 400 / rows * 0.84);
      const x0 = k.rtl ? 190 : 20, w = 650, gx = w / 5, gy = Math.min(140, 420 / rows);
      const c = i % 5, cc = k.rtl ? 4 - c : c, r = Math.floor(i / 5);
      const rowW = cols * gx;
      const left = x0 + (w - rowW) / 2;
      return { x: left + gx * (cc - (k.rtl ? 5 - cols : 0) + 0.5), y: 220 - (rows * gy) / 2 + gy * (r + 0.5), size };
    },
    drawItems(k) {
      const g = k.$('.kp-items');
      g.innerHTML = '';
      k.$('.kp-tags').innerHTML = '';
      for (let i = 0; i < k.s.n; i++) {
        const s = this.spot(k, i, k.s.n);
        k.add(`<g class="kp-it" data-i="${i}"><g>${emo(k.s.emoji, s.x, s.y, s.size)}</g></g>`, g);
      }
    },
    async intro(k) {
      this.drawItems(k);
      const items = k.$$('.kp-it > g');
      hide(items);
      await k.wait(350);
      for (const it of items) { pop(it, 0, 420); await k.wait(150); }
      await k.wait(300);
      if (k.p.count === true) await this.count(k);
      if (has(k.p.take)) await this.set(k, { take: k.p.take });
    },
    async count(k) {
      k.$('.kp-tags').innerHTML = '';
      const items = k.$$('.kp-it > g');
      const live = items.length - k.s.taken;
      for (let i = 0; i < live; i++) {
        const s = this.spot(k, i, k.s.n);
        bump(items[i], 1.22, 380);
        const tag = k.add(`<g><circle cx="${s.x + s.size * 0.36}" cy="${s.y + s.size * 0.36}" r="${Math.max(20, s.size * 0.2)}" fill="#fff" stroke="${C.purple}" stroke-width="4"/>
          ${txt(s.x + s.size * 0.36, s.y + s.size * 0.37, k.d(i + 1), Math.max(24, s.size * 0.26), { fill: INK })}</g>`, k.$('.kp-tags'));
        pop(tag, 0, 360);
        await k.wait(480);
      }
      const nb = k.$('.kp-num');
      nb.querySelector('.kp-btext').textContent = k.d(live);
      if (nb.style.opacity === '0') await pop(nb); else bump(nb);
    },
    async set(k, p) {
      if (has(p.n) && int(p.n, k.s.n) !== k.s.n) {
        const n = clamp(int(p.n, 1), 1, 20), old = k.s.n;
        k.s.n = n;
        k.s.taken = 0;
        hide(k.$('.kp-num'));
        this.drawItems(k);
        const items = k.$$('.kp-it > g');
        for (let i = 0; i < items.length; i++) if (i >= old) { hide(items[i]); pop(items[i], (i - old) * 200, 420); }
        await k.wait(Math.max(0, n - old) * 200 + 400);
      }
      if (has(p.take)) {
        const t = clamp(int(p.take, 0), 0, k.s.n - k.s.taken);
        const items = k.$$('.kp-it');
        for (let j = 0; j < t; j++) {
          const i = k.s.n - 1 - k.s.taken;
          k.s.taken += 1;
          const s = this.spot(k, i, k.s.n), r = s.size * 0.42;
          go(items[i], [{ opacity: 1 }, { opacity: 0.4 }], { duration: 400 });
          const x = k.add(`<g><path d="M${s.x - r} ${s.y - r} L${s.x + r} ${s.y + r} M${s.x + r} ${s.y - r} L${s.x - r} ${s.y + r}" stroke="#FF4D6D" stroke-width="12" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></g>`, k.$('.kp-tags'));
          await go(x.firstElementChild, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 420 });
          await k.wait(200);
        }
        const nb = k.$('.kp-num');
        if (nb.style.opacity !== '0') await setBadge(nb, k.d(k.s.n - k.s.taken));
      }
      if (p.count) await this.count(k);
    },
  }, ['counting', 'objects', 'howmany']);

  // --------------------------------------------------------- number line
  // {"name":"numberline","from":0,"to":10,"start":3,"hops":[2,3]}   a frog hops along it; each hop is an arc with its +n.
  // propset {"hop":2} (another hop; negative goes back), {"at":7} (jumps straight there).
  function frog() {
    return `<ellipse cx="-24" cy="-6" rx="16" ry="8" fill="#2FA866"/><ellipse cx="24" cy="-6" rx="16" ry="8" fill="#2FA866"/>
      <ellipse cx="0" cy="-34" rx="36" ry="30" fill="#5BE49B"/><ellipse cx="0" cy="-24" rx="22" ry="16" fill="#C9F7D9"/>
      <g transform="translate(-16 -62)"><circle r="14" fill="#5BE49B"/><circle r="9.5" fill="#fff"/><circle cx="1" cy="-1" r="5.5" fill="${INK}"/><circle cx="2.6" cy="-3" r="2" fill="#fff"/></g>
      <g transform="translate(16 -62)"><circle r="14" fill="#5BE49B"/><circle r="9.5" fill="#fff"/><circle cx="1" cy="-1" r="5.5" fill="${INK}"/><circle cx="2.6" cy="-3" r="2" fill="#fff"/></g>
      <path d="M-12 -44 Q0 -36 12 -44" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
      <ellipse cx="-24" cy="-40" rx="6" ry="3.5" fill="#FF7FA8" opacity=".6"/><ellipse cx="24" cy="-40" rx="6" ry="3.5" fill="#FF7FA8" opacity=".6"/>`;
  }
  def('numberline', {
    vb: () => [940, 360],
    draw(k) {
      const p = k.p;
      let from = int(p.from ?? p.min, 0), to = int(p.to ?? p.max, 10);
      if (to - from > 20) to = from + 20;
      if (to <= from) to = from + 10;
      k.s.from = from; k.s.to = to;
      k.s.at = clamp(int(p.start ?? p.at, from), from, to);
      const X = (v) => 70 + (v - from) / (to - from) * 800;
      k.s.X = X;
      const Y = 250;
      let ticks = '';
      for (let v = from; v <= to; v++) {
        ticks += `<rect x="${X(v) - 3}" y="${Y - 16}" width="6" height="32" rx="3" fill="#fff"/>
          <g class="kp-lab" data-v="${v}">${big(X(v), Y + 52, k.d(v), to - from > 12 ? 30 : 38)}</g>`;
      }
      return `<defs>${k.cutDef()}</defs>
        <rect x="30" y="${Y - 6}" width="880" height="12" rx="6" fill="#fff"/>
        <path d="M20 ${Y} l22 -16 v32z M920 ${Y} l-22 -16 v32z" fill="#fff"/>
        ${ticks}<g class="kp-arcs"></g>
        <g class="kp-frog-at" transform="translate(${X(k.s.at)} ${Y - 10})"><g class="kp-frog" ${k.cut}>${frog()}</g></g>`;
    },
    async intro(k) {
      const f = k.$('.kp-frog');
      hide(f);
      await k.wait(400);
      await drop(f, 0, 120, 500);
      for (const h of [].concat(k.p.hops ?? k.p.jumps ?? []).slice(0, 6)) await this.hop(k, int(h, 0));
    },
    async hop(k, d) {
      const a = k.s.at, b = clamp(a + d, k.s.from, k.s.to);
      if (a === b) return;
      const X = k.s.X, Y = 240, x1 = X(a), x2 = X(b);
      const h = Math.min(170, 70 + Math.abs(b - a) * 14);
      const c = b > a ? '#FFC857' : '#FF8FB8';
      const arc = k.add(`<g><path d="M${x1} ${Y - 18} Q${(x1 + x2) / 2} ${Y - 18 - h * 2} ${x2} ${Y - 18}" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
        <path d="M${x2} ${Y - 18} l${b > a ? -16 : 16} -12 l${b > a ? 2 : -2} 18z" fill="${c}" opacity="0" class="kp-ah"/></g>`, k.$('.kp-arcs'));
      for (const old of [...k.$('.kp-arcs').children]) if (old !== arc) go(old, [{ opacity: 0.32 }], { duration: 400 });
      const fr = k.$('.kp-frog-at'), body = k.$('.kp-frog');
      O(body, 'center bottom');
      await go(body, [{ transform: 'scale(1,1)' }, { transform: 'scale(1.15,.8)' }], { duration: 160 });
      go(arc.firstElementChild, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 640, easing: 'linear' });
      go(body, [{ transform: 'scale(1.15,.8)' }, { transform: 'scale(.9,1.12)' }, { transform: 'scale(1,1)' }], { duration: 640 });
      await tween(640, (t) => {
        const x = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * ((x1 + x2) / 2) + t * t * x2;
        const y = (1 - t) * (1 - t) * (Y - 10) + 2 * (1 - t) * t * (Y - 10 - h * 2) + t * t * (Y - 10);
        fr.setAttribute('transform', `translate(${x} ${y})`);
      }, (q) => q);
      arc.querySelector('.kp-ah').setAttribute('opacity', '1');
      go(body, [{ transform: 'scale(1.2,.78)' }, { transform: 'scale(1,1)' }], { duration: 260, easing: BOUNCE });
      const lab = `${b > a ? '+' : '−'}${k.d(Math.abs(b - a))}`;
      const tag = k.add(pill((x1 + x2) / 2, Y - 18 - h - 30, lab, { size: 30, fill: shade(c, -0.25), w: 76 }), arc);
      pop(tag);
      k.s.at = b;
      const l = k.$(`.kp-lab[data-v="${b}"]`);
      for (const e of k.$$('.kp-lab')) e.classList.toggle('kp-glow', e === l);
      bump(l, 1.3, 420);
      await k.wait(450);
    },
    async set(k, p) {
      if (has(p.hops)) for (const h of [].concat(p.hops).slice(0, 6)) await this.hop(k, int(h, 0));
      if (has(p.hop)) await this.hop(k, int(p.hop, 0));
      if (has(p.at)) await this.hop(k, int(p.at, k.s.at) - k.s.at);
    },
  }, ['line', 'numline', 'hops', 'frog']);

  // ----------------------------------------------------------- fractions
  // {"name":"fraction","n":3,"d":4,"as":"pizza|kabsa|bar"}   d equal parts; n of them slide out and glow.
  // propset {"n":2}.
  def('fraction', {
    vb: (p) => (/bar/.test(p.as || p.shape || '') ? [820, 420] : [820, 440]),
    draw(k) {
      const p = k.p;
      const d = clamp(int(p.d ?? p.of ?? p.den, 4), 1, 12), n = clamp(int(p.n ?? p.num, 1), 0, d);
      const as = /bar|choc|strip/.test(p.as || p.shape || '') ? 'bar' : /kabsa|rice|plate|food/.test(p.as || p.shape || '') ? 'kabsa' : 'pizza';
      Object.assign(k.s, { d, n: 0, target: n, as });
      const c = col(p.color, C.orange);
      k.s.c = c;
      let pic = '';
      if (as === 'bar') {
        const x0 = 60, w = 700, y0 = 50, h = 140, pw = w / d;
        for (let i = 0; i < d; i++) {
          const ii = k.rtl ? d - 1 - i : i;
          pic += `<g class="kp-part" data-i="${i}"><g class="kp-off"><rect x="${x0 + ii * pw + 4}" y="${y0}" width="${pw - 8}" height="${h}" rx="16" fill="#fff" opacity=".12" stroke="#fff" stroke-width="4" stroke-dasharray="12 9"/></g>
            <g class="kp-on" style="opacity:0"><rect x="${x0 + ii * pw + 4}" y="${y0 + 6}" width="${pw - 8}" height="${h}" rx="16" fill="${shade(c, -0.3)}"/><rect x="${x0 + ii * pw + 4}" y="${y0}" width="${pw - 8}" height="${h}" rx="16" fill="${c}"/>
            <rect x="${x0 + ii * pw + 16}" y="${y0 + 14}" width="${Math.max(10, pw - 50)}" height="14" rx="7" fill="#fff" opacity=".4"/></g></g>`;
        }
        k.s.lab = { x: 410, y: 320, row: true };
        return `<defs>${k.cutDef()}</defs>${pic}<g class="kp-frac"></g>`;
      }
      const cx = k.rtl ? 590 : 230, cy = 220, R = 196;
      k.s.lab = { x: k.rtl ? 200 : 620, y: 220 };
      const sector = (r, a0, a1) => {
        if (d === 1) return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
        const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)], p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
        return `M${cx} ${cy} L${p0[0]} ${p0[1]} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p1[0]} ${p1[1]}Z`;
      };
      const plate = as === 'kabsa' ? `<circle cx="${cx}" cy="${cy + 8}" r="${R + 6}" fill="#8E98BC"/><circle cx="${cx}" cy="${cy}" r="${R + 6}" fill="#D9DFEA"/><circle cx="${cx}" cy="${cy}" r="${R - 8}" fill="#EEF2F8"/>` : '';
      let seed = 3;
      const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
      for (let i = 0; i < d; i++) {
        const a0 = -Math.PI / 2 + i * 2 * Math.PI / d, a1 = a0 + 2 * Math.PI / d, am = (a0 + a1) / 2;
        const at = (r, da = 0) => [cx + r * Math.cos(am + da), cy + r * Math.sin(am + da)];
        const spread = Math.min(0.9, Math.PI / d) * 0.55;
        let top = '';
        if (as === 'pizza') {
          top += `<path d="${sector(R, a0, a1)}" fill="#E3A048"/><path d="${sector(R - 18, a0, a1)}" fill="#E8603C"/><path d="${sector(R - 24, a0, a1)}" fill="#FFD45C"/>`;
          for (let j = 0; j < 4; j++) {   // melted-cheese patches
            const [x, y] = at(40 + rnd() * 110, (rnd() - 0.5) * spread * 1.4);
            top += `<ellipse cx="${x}" cy="${y}" rx="${12 + rnd() * 10}" ry="${7 + rnd() * 6}" fill="#FFE58A" transform="rotate(${rnd() * 180} ${x} ${y})"/>`;
          }
          const count = Math.max(3, Math.round(14 / Math.sqrt(d)));
          for (let j = 0; j < count; j++) {
            const [x, y] = at(36 + rnd() * 120, (rnd() - 0.5) * spread * 1.5), rot = Math.round(rnd() * 180);
            const kind = j % 4;
            if (kind === 0) top += `<circle cx="${x}" cy="${y}" r="8" fill="none" stroke="#2A2140" stroke-width="5"/>`;
            else if (kind === 1) top += `<rect x="${x - 11}" y="${y - 3.5}" width="22" height="7" rx="3.5" fill="#2FA866" transform="rotate(${rot} ${x} ${y})"/>`;
            else if (kind === 2) top += `<path d="M${x - 9} ${y + 3} Q${x} ${y - 13} ${x + 9} ${y + 3}Z" fill="#E9D5B0" transform="rotate(${rot} ${x} ${y})"/>`;
            else top += `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="#FFF1A8" transform="rotate(${rot} ${x} ${y})"/>`;
          }
        } else {
          top += `<path d="${sector(R - 14, a0, a1)}" fill="#E8963A"/>`;
          for (let j = 0; j < 26; j++) {
            const [x, y] = at(24 + rnd() * (R - 50), (rnd() - 0.5) * spread * 1.7);
            top += `<ellipse cx="${x}" cy="${y}" rx="5.5" ry="2.2" fill="${j % 3 ? '#FFC676' : '#C9712A'}" transform="rotate(${rnd() * 180} ${x} ${y})"/>`;
          }
          const [mx, my] = at(R * 0.52);
          const rot = am * 180 / Math.PI;
          // a roast drumstick: meat, then the bone with its knobbly end
          top += `<g transform="translate(${mx} ${my}) rotate(${rot + 90}) scale(${Math.min(1.05, 2.6 / Math.max(d, 2) + 0.35)})">
            <rect x="-5" y="12" width="10" height="26" rx="5" fill="#FFF6E4"/><circle cx="-6" cy="40" r="7" fill="#FFF6E4"/><circle cx="6" cy="40" r="7" fill="#FFF6E4"/>
            <path d="M0 -38 C24 -38 30 -12 22 4 C16 16 8 20 0 20 C-8 20 -16 16 -22 4 C-30 -12 -24 -38 0 -38Z" fill="#A8521E"/>
            <path d="M-12 -28 C-4 -34 10 -32 14 -22" fill="none" stroke="#D98A45" stroke-width="6" stroke-linecap="round"/></g>`;
          for (let j = 0; j < 3; j++) {
            const [x, y] = at(R * (0.72 + j * 0.06), (j - 1) * spread * 0.7);
            top += j === 1 ? `<circle cx="${x}" cy="${y}" r="5" fill="#5B2A3A"/>` : `<ellipse cx="${x}" cy="${y}" rx="8" ry="4" fill="#FFF0D0" transform="rotate(${rot + 40} ${x} ${y})"/>`;
          }
          const [gx, gy] = at(R * 0.3, spread * 0.5);
          top += `<circle cx="${gx}" cy="${gy}" r="5" fill="#3DB860"/><circle cx="${gx + 8}" cy="${gy - 4}" r="4" fill="#3DB860"/>`;
        }
        const [ox, oy] = [Math.cos(am) * 22, Math.sin(am) * 22];
        pic += `<g class="kp-part" data-i="${i}" data-dx="${ox}" data-dy="${oy}"><g class="kp-slice">${top}
          <path d="${sector(as === 'pizza' ? R : R - 14, a0, a1)}" fill="none" stroke="${as === 'pizza' ? '#FFF3D6' : '#FFFFFF'}" stroke-width="${d > 1 ? 5 : 0}" stroke-linejoin="round"/></g></g>`;
      }
      return `<defs>${k.cutDef()}</defs>${plate}<g class="kp-pic">${pic}</g><g class="kp-frac"></g>`;
    },
    label(k) {
      const { x, y } = k.s.lab, c = k.s.c;
      return `<g class="kp-num">${big(x, y - 74, k.d(k.s.n), 110, { fill: c, cls: 'kp-ntext' })}</g>
        <rect x="${x - 70}" y="${y - 6}" width="140" height="14" rx="7" fill="#fff"/>
        <g class="kp-den">${big(x, y + 80, k.d(k.s.d), 110)}</g>`;
    },
    async intro(k) {
      const parts = k.$$('.kp-part');
      hide(parts);
      await k.wait(300);
      for (const p of parts) { pop(p, 0, 380); await k.wait(110); }
      await k.wait(400);
      const f = k.add(this.label(k), k.$('.kp-frac'));
      if (k.s.as === 'bar') f.parentNode.setAttribute('transform', `translate(0 0)`);
      hide(k.$('.kp-num'));
      pop(k.$('.kp-den'));
      await k.wait(700);
      k.$('.kp-num').style.opacity = '';
      await this.to(k, k.s.target);
    },
    async to(k, n) {
      n = clamp(n, 0, k.s.d);
      const parts = k.$$('.kp-part');
      while (k.s.n !== n) {
        const up = n > k.s.n;
        const i = up ? k.s.n : k.s.n - 1;
        const p = parts[i];
        k.s.n += up ? 1 : -1;
        if (k.s.as === 'bar') {
          const on = p.querySelector('.kp-on');
          if (up) { on.style.opacity = ''; await pop(on, 0, 380); } else await go(on, [{ opacity: 1 }, { opacity: 0 }], { duration: 260 });
        } else {
          const dx = p.dataset.dx, dy = p.dataset.dy;
          p.classList.toggle('kp-glow', up);
          await go(p.firstElementChild, [{ transform: up ? 'translate(0px,0px)' : `translate(${dx}px,${dy}px)` }, { transform: up ? `translate(${dx}px,${dy}px)` : 'translate(0px,0px)' }], { duration: 340, easing: BOUNCE });
        }
        setBadgeText(k.$('.kp-ntext'), k.d(k.s.n));
        await k.wait(260);
      }
      if (k.s.as !== 'bar') for (const [i, p] of parts.entries()) p.classList.toggle('kp-dull', !(i < k.s.n || !k.s.n));
    },
    async set(k, p) { if (has(p.n)) await this.to(k, int(p.n, 0)); },
  }, ['fractions', 'pizza', 'kabsa', 'part', 'parts', 'half', 'quarter']);
  async function setBadgeText(t, s) {
    if (!t) return;
    await go(O(t), [{ transform: 'scale(1)' }, { transform: 'scale(.3)' }], { duration: 100 });
    t.textContent = s;
    await go(O(t), [{ transform: 'scale(.3)' }, { transform: 'scale(1)' }], { duration: 200, easing: BOUNCE });
  }

  // --------------------------------------------------------------- clock
  // {"name":"clock","h":3,"m":30,"digital":true}   a friendly alarm clock.
  // propset {"h":4,"m":15}: the hands turn forward to the new time (the digital time follows).
  def('clock', {
    vb: (p) => [540, p.digital === false ? 540 : 640],
    draw(k) {
      const p = k.p, cx = 270, cy = 300;
      k.s.min = ((int(p.h ?? p.hour, 3) % 12) * 60 + clamp(int(p.m ?? p.min ?? p.minute, 0), 0, 59));
      k.s.digital = p.digital !== false;
      let ticks = '', nums = '';
      for (let i = 0; i < 60; i++) {
        const a = i * Math.PI / 30, h = i % 5 === 0;
        const r1 = h ? 150 : 158, r2 = 168;
        ticks += `<path d="M${cx + r1 * Math.sin(a)} ${cy - r1 * Math.cos(a)} L${cx + r2 * Math.sin(a)} ${cy - r2 * Math.cos(a)}" stroke="${h ? INK : '#C3C9E8'}" stroke-width="${h ? 5 : 3}" stroke-linecap="round"/>`;
      }
      for (let i = 1; i <= 12; i++) {
        const a = i * Math.PI / 6;
        nums += txt(cx + 122 * Math.sin(a), cy - 122 * Math.cos(a) + 3, k.d(i), 48, { fill: INK });
      }
      const bell = (s) => `<g transform="translate(${cx + s * 128} ${cy - 168}) rotate(${s * 38})"><path d="M-50 18 C-50 -40 50 -40 50 18Z" fill="#FFC857"/><path d="M-50 18 H50" stroke="#E8A93A" stroke-width="8" stroke-linecap="round"/><circle cy="-34" r="9" fill="#E8A93A"/></g>`;
      const leg = (s) => `<rect x="${cx + s * 120 - 14}" y="${cy + 168}" width="28" height="56" rx="14" fill="#3E7FD8" transform="rotate(${s * -28} ${cx + s * 120} ${cy + 170})"/>`;
      const dg = k.s.digital ? `<g class="kp-dig"><rect x="${cx - 120}" y="560" width="240" height="76" rx="26" fill="#2A2140" opacity=".55"/><rect x="${cx - 120}" y="552" width="240" height="76" rx="26" fill="#fff"/>
        ${txt(cx, 592, '', 56, { fill: INK, cls: 'kp-dtime', dir: 'ltr' })}</g>` : '';
      k.s.c = { cx, cy };
      return `<defs>${k.cutDef()}</defs><g ${k.shadow}>${leg(-1)}${leg(1)}${bell(-1)}${bell(1)}
        <circle cx="${cx}" cy="${cy}" r="204" fill="#6CB6FF"/></g><circle cx="${cx}" cy="${cy}" r="190" fill="#4E9BEA"/><circle cx="${cx}" cy="${cy}" r="180" fill="#fff"/>
        ${ticks}${nums}
        <g class="kp-hh"><path d="M${cx - 10} ${cy + 16} L${cx - 8} ${cy - 84} Q${cx} ${cy - 100} ${cx + 8} ${cy - 84} L${cx + 10} ${cy + 16}Z" fill="${INK}"/></g>
        <g class="kp-mh"><path d="M${cx - 7} ${cy + 20} L${cx - 5} ${cy - 138} Q${cx} ${cy - 152} ${cx + 5} ${cy - 138} L${cx + 7} ${cy + 20}Z" fill="#FF4D7A"/></g>
        <circle cx="${cx}" cy="${cy}" r="16" fill="#FFC857"/><circle cx="${cx}" cy="${cy}" r="6" fill="${INK}"/>${dg}`;
    },
    pose(k, total) {
      const { cx, cy } = k.s.c, m = ((total % 720) + 720) % 720;
      k.$('.kp-mh').setAttribute('transform', `rotate(${total * 6} ${cx} ${cy})`);
      k.$('.kp-hh').setAttribute('transform', `rotate(${total * 0.5} ${cx} ${cy})`);
      const t = k.$('.kp-dtime');
      if (t) {
        const hh = Math.floor(m / 60) || 12, mm = Math.floor(m % 60);
        t.textContent = `${k.d(hh)}:${k.d(String(mm).padStart(2, '0'))}`;
      }
    },
    async intro(k) {
      this.pose(k, k.s.min);
      const d = k.$('.kp-dig');
      if (d) { hide(d); await k.wait(700); pop(d); }
    },
    async set(k, p) {
      if (p.digital === true && !k.$('.kp-dig')) { k.p.digital = true; }
      if (!has(p.h) && !has(p.m) && !has(p.hour) && !has(p.minute)) return;
      const cur = k.s.min, curM = ((cur % 720) + 720) % 720;
      const h = has(p.h ?? p.hour) ? int(p.h ?? p.hour, 0) % 12 : Math.floor(curM / 60);
      const target = h * 60 + clamp(int(p.m ?? p.minute, has(p.h) ? 0 : curM % 60), 0, 59);
      let delta = target - curM;
      if (delta <= 0) delta += 720;
      const ms = clamp(delta * 14, 1000, 3600);
      await tween(ms, (t) => this.pose(k, cur + delta * t), easeInOut);
      k.s.min = cur + delta;
      bump(k.$('.kp-dig'), 1.1, 400);
    },
  }, ['time', 'watch', 'clockface']);

  // --------------------------------------------------------------- money
  // {"name":"money","items":[5,1,1,0.5]}   Saudi riyal notes and coins (values in riyals; 0.5 = 50 halalas); the total counts up.
  // propset {"add":[1]} drops more in; {"items":[...]} starts over.
  const NOTE = { 5: '#8E6CC9', 10: '#B07A4A', 50: '#3FA06B', 100: '#D9506A', 200: '#7A8A4A', 500: '#3A7BD5' };
  const COIN_OK = [2, 1, 0.5, 0.25, 0.1, 0.05];
  function moneyItem(k, v) {
    const rtl = k.rtl;
    if (NOTE[v]) {
      const c = NOTE[v], c2 = shade(c, 0.45);
      const palm = `<g transform="translate(${rtl ? 40 : -40} 14)" opacity=".55"><path d="M-3 30 C-4 10 -2 -8 2 -22 L6 -21 C3 -8 2 10 4 30Z" fill="${c2}"/>
        ${[-150, -110, -70, -30, 10].map((a) => `<path transform="translate(4 -22) rotate(${a})" d="M0 0 C10 -9 26 -8 34 2 C24 -2 12 -1 0 0Z" fill="${c2}"/>`).join('')}</g>`;
      return { w: 236, h: 124, svg: `<rect x="-112" y="-58" width="224" height="124" rx="14" fill="${shade(c, -0.35)}"/><rect x="-112" y="-62" width="224" height="124" rx="14" fill="${c}"/>
        <rect x="-102" y="-52" width="204" height="104" rx="9" fill="none" stroke="${c2}" stroke-width="3" opacity=".8"/>${palm}
        <circle cx="${rtl ? -62 : 62}" cy="-8" r="36" fill="#fff"/>${txt(rtl ? -62 : 62, -6, k.d(v), v >= 100 ? 30 : 40, { fill: shade(c, -0.3) })}
        ${txt(rtl ? -62 : 62, 40, k.t('riyal'), 20, { fill: '#fff' })}` };
    }
    const hal = v < 1, r = v === 2 ? 56 : v === 1 ? 54 : v >= 0.5 ? 46 : 40;
    const ring = v === 1 ? '#E2B44A' : '#CDD3DE', mid = v === 1 ? '#D7DCE6' : v === 2 ? '#E2B44A' : v >= 0.1 ? '#D9DEE8' : '#D7A15E';
    const num = hal ? Math.round(v * 100) : v;
    return { w: r * 2 + 16, h: r * 2, svg: `<circle r="${r}" cy="4" fill="${shade(ring, -0.35)}"/><circle r="${r}" fill="${ring}"/>${hal ? '' : `<circle r="${r * 0.7}" fill="${mid}"/>`}
      <circle r="${r * 0.86}" fill="none" stroke="#fff" stroke-width="2" opacity=".5" stroke-dasharray="3 5"/>
      ${txt(0, -6, k.d(num), r * 0.78, { fill: '#5A4A2A' })}${txt(0, r * 0.46, hal ? k.t('halala') : k.t('riyal'), r * 0.3, { fill: '#5A4A2A' })}` };
  }
  def('money', {
    vb: () => [880, 440],
    draw(k) {
      k.s.items = [];
      k.s.total = 0;
      return `<defs>${k.cutDef()}</defs><g class="kp-cash"></g>
        <g class="kp-total" style="opacity:0"><rect x="290" y="356" width="300" height="72" rx="36" fill="#1F8A4C"/><rect x="290" y="350" width="300" height="72" rx="36" fill="#2FA866"/>
        ${txt(440, 388, '', 40, { fill: '#fff', cls: 'kp-sum', fit: 270, dir: k.rtl ? 'rtl' : 'ltr' })}</g>`;
    },
    vals(list) {
      return [].concat(list ?? []).map((x) => num(typeof x === 'object' ? x.v ?? x.value : x, 0))
        .map((v) => (NOTE[v] ? v : COIN_OK.reduce((a, c) => (Math.abs(c - v) < Math.abs(a - v) ? c : a), 1))).slice(0, 8);
    },
    // Place items in rows (reading order), each centred in the space above the total.
    layoutAll(k) {
      const els = k.$$('.kp-money');
      const rows = [[]];
      let w = 0;
      for (const e of els) {
        const iw = Number(e.dataset.w);
        if (w + iw > 840 && rows[rows.length - 1].length) { rows.push([]); w = 0; }
        rows[rows.length - 1].push(e); w += iw + 14;
      }
      const rh = rows.length > 1 ? 168 : 200;
      rows.forEach((row, r) => {
        const tw = row.reduce((s, e) => s + Number(e.dataset.w) + 14, -14);
        let x = 440 - tw / 2;
        const y = (rows.length > 1 ? 92 : 160) + r * rh;
        const seq = k.rtl ? row.slice().reverse() : row;
        for (const e of seq) {
          const iw = Number(e.dataset.w);
          e.setAttribute('transform', `translate(${x + iw / 2} ${y})`);
          x += iw + 14;
        }
      });
    },
    async drop1(k, v) {
      const it = moneyItem(k, v);
      const el = k.add(`<g class="kp-money" data-w="${it.w * 1.3}"><g class="kp-mi"><g transform="scale(1.3)">${it.svg}</g></g></g>`, k.$('.kp-cash'));
      k.s.items.push(v);
      this.layoutAll(k);
      const inner = el.firstElementChild;
      if (NOTE[v]) await go(O(inner), [{ transform: 'translateY(-160px) rotate(-8deg)', opacity: 0 }, { transform: 'translateY(10px) rotate(3deg)', opacity: 1, offset: 0.7 }, { transform: 'translateY(0) rotate(0)', opacity: 1 }], { duration: 620 });
      else await go(O(inner), [{ transform: 'translateY(-170px) scaleX(1)', opacity: 0 }, { transform: 'translateY(-60px) scaleX(-1)', opacity: 1, offset: 0.4 }, { transform: 'translateY(0) scaleX(1)', opacity: 1, offset: 0.8 }, { transform: 'translateY(0) scaleX(1)', opacity: 1 }], { duration: 640, easing: 'ease-in' });
      await this.addTotal(k, v);
    },
    fmt(k, t) {
      const r = Math.floor(t + 1e-6), h = Math.round((t - r) * 100);
      if (!h) return `${k.d(r)} ${r === 1 || k.rtl ? k.t('riyal') : k.t('riyals')}`;
      if (!r) return `${k.d(h)} ${k.t('halala')}${!k.rtl && h !== 1 ? 's' : ''}`;
      return k.rtl ? `${k.d(r)} ${k.t('riyal')} و ${k.d(h)} ${k.t('halala')}` : `${r} ${r === 1 ? 'riyal' : 'riyals'} ${h} halalas`;
    },
    async addTotal(k, v) {
      const from = k.s.total;
      k.s.total = Math.round((k.s.total + v) * 100) / 100;
      const tot = k.$('.kp-total'), sum = k.$('.kp-sum');
      if (tot.style.opacity === '0') { sum.textContent = this.fmt(k, from); k.fit(tot); fade(tot); }
      await tween(380, (e) => { sum.textContent = this.fmt(k, Math.round((from + v * e) * 100) / 100); });
      k.fit(tot);
      bump(sum, 1.15, 300);
    },
    async intro(k) {
      await k.wait(300);
      for (const v of this.vals(k.p.items ?? k.p.values ?? k.p.add)) { await this.drop1(k, v); await k.wait(160); }
    },
    async set(k, p) {
      if (has(p.items)) {
        k.$('.kp-cash').innerHTML = ''; k.s.items = []; k.s.total = 0; hide(k.$('.kp-total'));
        for (const v of this.vals(p.items)) { await this.drop1(k, v); await k.wait(160); }
      }
      if (has(p.add)) for (const v of this.vals(p.add)) { await this.drop1(k, v); await k.wait(160); }
    },
  }, ['riyals', 'riyal', 'coins', 'cash', 'notes', 'sar']);

  // -------------------------------------------------------------- shapes
  // {"name":"shapes","items":["circle","square","triangle","rectangle"]}   friendly shapes with their names.
  // propset {"sides":"triangle"}: its sides light up and are counted; {"corners":"square"} counts the corners.
  const SHAPE_COL = { circle: C.red, square: C.blue, triangle: C.yellow, rectangle: C.green, oval: C.purple, star: '#FFB547', heart: C.pink, pentagon: C.cyan, hexagon: C.orange, diamond: '#B48CFF' };
  const SHAPE_ALIAS = { دائرة: 'circle', مربع: 'square', مثلث: 'triangle', مستطيل: 'rectangle', بيضاوي: 'oval', نجمة: 'star', قلب: 'heart', خماسي: 'pentagon', سداسي: 'hexagon', معين: 'diamond', 'معيّن': 'diamond', rhombus: 'diamond', ellipse: 'oval', kite: 'diamond' };
  const shapeName = (s) => { const k = String(s || '').toLowerCase().trim(); return SHAPE_COL[k] ? k : SHAPE_ALIAS[k] || null; };
  function shapePts(name) {
    const reg = (n, r, a0 = -Math.PI / 2) => Array.from({ length: n }, (_, i) => [r * Math.cos(a0 + i * 2 * Math.PI / n), r * Math.sin(a0 + i * 2 * Math.PI / n)]);
    switch (name) {
      case 'square': return [[-74, -74], [74, -74], [74, 74], [-74, 74]];
      case 'rectangle': return [[-96, -58], [96, -58], [96, 58], [-96, 58]];
      case 'triangle': return [[0, -86], [92, 70], [-92, 70]];
      case 'pentagon': return reg(5, 90);
      case 'hexagon': return reg(6, 88, 0);
      case 'diamond': return [[0, -96], [70, 0], [0, 96], [-70, 0]];
      case 'star': return Array.from({ length: 10 }, (_, i) => { const r = i % 2 ? 40 : 92, a = -Math.PI / 2 + i * Math.PI / 5; return [r * Math.cos(a), r * Math.sin(a)]; });
      default: return null;
    }
  }
  function shapeSvg(name, c) {
    const pts = shapePts(name);
    let body;
    if (pts) body = `<path d="M${pts.map((p) => p.join(' ')).join(' L')}Z" fill="${c}" stroke="${c}" stroke-width="14" stroke-linejoin="round"/>`;
    else if (name === 'circle') body = `<circle r="86" fill="${c}"/>`;
    else if (name === 'oval') body = `<ellipse rx="100" ry="66" fill="${c}"/>`;
    else body = `<path d="M0 84 C-60 40 -98 8 -98 -30 C-98 -66 -66 -86 -40 -86 C-20 -86 -6 -76 0 -62 C6 -76 20 -86 40 -86 C66 -86 98 -66 98 -30 C98 8 60 40 0 84Z" fill="${c}"/>`;
    const fy = name === 'triangle' ? 22 : name === 'heart' ? -14 : name === 'star' ? 4 : 0;
    const face = `<g transform="translate(0 ${fy})"><ellipse cx="-18" cy="-6" rx="6.5" ry="8" fill="${INK}"/><ellipse cx="18" cy="-6" rx="6.5" ry="8" fill="${INK}"/>
      <circle cx="-16" cy="-9" r="2.4" fill="#fff"/><circle cx="20" cy="-9" r="2.4" fill="#fff"/>
      <path d="M-12 10 Q0 21 12 10" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="-30" cy="8" rx="7" ry="4" fill="#FF5F8F" opacity=".45"/><ellipse cx="30" cy="8" rx="7" ry="4" fill="#FF5F8F" opacity=".45"/></g>`;
    const shine = `<ellipse cx="-36" cy="-40" rx="18" ry="9" fill="#fff" opacity=".3" transform="rotate(-30 -36 -40)"/>`;
    return `<g transform="translate(0 6)" opacity=".3">${body.replace(/fill="[^"]+"/, `fill="${shade(c, -0.5)}"`).replace(/stroke="[^"]+"/, `stroke="${shade(c, -0.5)}"`)}</g>${body}${name === 'star' ? '' : shine}${face}`;
  }
  def('shapes', {
    vb(p) { const n = clamp([].concat(p.items ?? p.shapes ?? p.shape ?? ['circle']).length, 1, 4); return [Math.max(400, n * 230 + 20), 420]; },
    draw(k) {
      const list = [].concat(k.p.items ?? k.p.shapes ?? k.p.shape ?? ['circle']).map(shapeName).filter(Boolean).slice(0, 4);
      k.s.list = list.length ? list : ['circle'];
      const n = k.s.list.length, Wd = Math.max(400, n * 230 + 20), cw = (Wd - 20) / n;
      k.s.cx = [];
      let m = `<defs>${k.cutDef()}</defs>`;
      k.s.list.forEach((s, i) => {
        const slot = k.rtl ? n - 1 - i : i, cx = 10 + cw * (slot + 0.5);
        k.s.cx.push(cx);
        m += `<g class="kp-shape" data-part="${s}" data-i="${i}"><g transform="translate(${cx} 190)"><g class="kp-sh">${shapeSvg(s, SHAPE_COL[s])}</g><g class="kp-marks"></g></g>
          ${k.p.names === false ? '' : `<g class="kp-name">${big(cx, 360, k.t(s), 40, { fit: cw - 16 })}</g>`}<g class="kp-cnt"></g></g>`;
      });
      return m;
    },
    async intro(k) {
      const sh = k.$$('.kp-sh'), nm = k.$$('.kp-name');
      hide(sh, nm);
      await k.wait(300);
      for (let i = 0; i < sh.length; i++) { pop(sh[i]); await k.wait(260); fade(nm[i]); await k.wait(200); }
      for (const key of ['sides', 'corners']) if (has(k.p[key])) await this.set(k, { [key]: k.p[key] });
    },
    async set(k, p) {
      for (const key of ['sides', 'corners']) {
        if (!has(p[key])) continue;
        const i = typeof p[key] === 'number' ? clamp(p[key], 1, k.s.list.length) - 1 : k.s.list.indexOf(shapeName(p[key]) || k.s.list[0]);
        if (i < 0) continue;
        const name = k.s.list[i], pts = shapePts(name) || [];
        const g = k.$$('.kp-shape')[i], marks = g.querySelector('.kp-marks');
        marks.innerHTML = '';
        for (const s of k.$$('.kp-shape')) s.classList.toggle('kp-soft', s !== g);
        for (let j = 0; j < pts.length; j++) {
          const a = pts[j], b = pts[(j + 1) % pts.length];
          if (key === 'sides') {
            const ln = k.add(`<path d="M${a[0]} ${a[1]} L${b[0]} ${b[1]}" stroke="#fff" stroke-width="12" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>`, marks);
            await go(ln, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 360 });
            const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, len = Math.hypot(mx, my) || 1;
            pop(k.add(`<g><circle cx="${mx + mx / len * 30}" cy="${my + my / len * 30}" r="20" fill="${INK}"/>${txt(mx + mx / len * 30, my + my / len * 30 + 1, k.d(j + 1), 26, { fill: '#fff' })}</g>`, marks));
          } else {
            pop(k.add(`<g><circle cx="${a[0]}" cy="${a[1]}" r="17" fill="#fff" stroke="${INK}" stroke-width="4"/>${txt(a[0], a[1] + 1, k.d(j + 1), 22, { fill: INK })}</g>`, marks));
          }
          await k.wait(260);
        }
        const word = pts.length === 0 ? (k.rtl ? 'لا يوجد' : 'none') : `${k.d(pts.length)} ${k.t(key)}`;
        const cnt = g.querySelector('.kp-cnt');
        cnt.innerHTML = pill(k.s.cx[i], 40, word, { size: 32, fill: C.purple, w: 180 });
        k.fit(cnt);
        await pop(cnt.firstElementChild);
      }
    },
  }, ['shape', 'geometry', 'polygons']);

  // --------------------------------------------------------------- ruler
  // {"name":"ruler","len":7,"thing":"pencil|crayon","color":"blue"}   it lines up at 0 and is measured in cm.
  // propset {"len":5}: a shorter pencil is measured again.
  const RU = { x0: 70, u: 50, y: 190 };
  function pencilD(len, kind, c) {
    const L = len * RU.u, y = 112, t = 44, x = RU.x0;
    const tip = 46;
    if (kind === 'crayon') {
      return `<path d="M${x} ${y - t / 2} H${x + L - tip} L${x + L - 4} ${y - 5} Q${x + L} ${y} ${x + L - 4} ${y + 5} L${x + L - tip} ${y + t / 2} H${x}Z" fill="${c}"/>
        <rect x="${x + 10}" y="${y - t / 2}" width="${Math.max(10, L - tip - 20)}" height="${t}" fill="#fff" opacity=".85"/>
        <rect x="${x + 10}" y="${y - t / 2}" width="${Math.max(10, L - tip - 20)}" height="7" fill="${c}"/><rect x="${x + 10}" y="${y + t / 2 - 7}" width="${Math.max(10, L - tip - 20)}" height="7" fill="${c}"/>`;
    }
    return `<rect x="${x}" y="${y - t / 2}" width="24" height="${t}" rx="10" fill="#FF8FB8"/><rect x="${x + 16}" y="${y - t / 2}" width="20" height="${t}" fill="#C9D1E0"/>
      <path d="M${x + 36} ${y - t / 2} H${x + L - tip} L${x + L} ${y} L${x + L - tip} ${y + t / 2} H${x + 36}Z" fill="#F2C894"/>
      <rect x="${x + 36}" y="${y - t / 2}" width="${Math.max(0, L - tip - 36)}" height="${t}" fill="${c}"/><rect x="${x + 36}" y="${y - t / 2}" width="${Math.max(0, L - tip - 36)}" height="12" fill="#fff" opacity=".28"/>
      <path d="M${x + L - 15} ${y - 7} L${x + L} ${y} L${x + L - 15} ${y + 7}Z" fill="${INK}"/>`;
  }
  def('ruler', {
    vb: () => [900, 330],
    draw(k) {
      const p = k.p;
      k.s.len = clamp(num(p.len ?? p.length ?? p.cm, 7), 1, 15);
      k.s.kind = /crayon/.test(p.thing || '') ? 'crayon' : 'pencil';
      k.s.c = col(p.color, k.s.kind === 'crayon' ? C.red : C.blue);
      let ticks = '';
      for (let i = 0; i <= 30; i++) {
        const x = RU.x0 + i * RU.u / 2, cm = i % 2 === 0;
        ticks += `<rect x="${x - (cm ? 2.5 : 1.5)}" y="${RU.y}" width="${cm ? 5 : 3}" height="${cm ? 34 : 20}" rx="1.5" fill="${INK}"/>`;
        if (cm) ticks += txt(x, RU.y + 62, k.d(i / 2), 30, { fill: INK });
      }
      return `<defs>${k.cutDef()}</defs>
        <rect x="34" y="${RU.y + 8}" width="830" height="104" rx="14" fill="#D9A93E"/><rect x="34" y="${RU.y}" width="830" height="104" rx="14" fill="#FFD36B"/>
        <rect class="kp-band" x="${RU.x0}" y="${RU.y}" width="0" height="12" fill="#FF4D7A"/>${ticks}
        <g class="kp-pen" ${k.cut}>${pencilD(k.s.len, k.s.kind, k.s.c)}</g>
        <path class="kp-guide" d="" stroke="#fff" stroke-width="4" stroke-dasharray="8 8" opacity="0"/><g class="kp-read"></g>`;
    },
    async measure(k) {
      const end = RU.x0 + k.s.len * RU.u;
      const band = k.$('.kp-band'), w0 = Number(band.getAttribute('width'));
      const guide = k.$('.kp-guide');
      guide.setAttribute('d', `M${end} 140 V${RU.y}`);
      fade(guide, 0, 300); guide.setAttribute('opacity', '1');
      await tween(900, (t) => band.setAttribute('width', w0 + (end - RU.x0 - w0) * t), easeInOut);
      const r = k.$('.kp-read');
      r.innerHTML = pill(end, 36, `${k.d(k.s.len)} ${k.t('cm')}`, { size: 34, fill: '#FF4D7A', w: 140 });
      k.fit(r);
      await pop(r.firstElementChild);
    },
    async intro(k) {
      const pen = k.$('.kp-pen');
      hide(pen);
      await k.wait(400);
      pen.style.opacity = '';
      await go(pen, [{ transform: 'translate(0px,-120px)', opacity: 0 }, { transform: 'translate(0px,0px)', opacity: 1 }], { duration: 600, easing: BOUNCE });
      await k.wait(300);
      if (k.p.measure !== false) await this.measure(k);
    },
    async set(k, p) {
      if (has(p.len ?? p.length ?? p.cm)) {
        const from = k.s.len, to = clamp(num(p.len ?? p.length ?? p.cm, from), 1, 15);
        k.$('.kp-read').innerHTML = '';
        k.$('.kp-guide').setAttribute('opacity', '0');
        const pen = k.$('.kp-pen');
        await tween(700, (t) => { pen.innerHTML = pencilD(from + (to - from) * t, k.s.kind, k.s.c); }, easeInOut);
        k.s.len = to;
      }
      if (has(p.len ?? p.length ?? p.cm) || p.measure) await this.measure(k);
    },
  }, ['measure', 'length', 'pencil', 'cm']);

  // ------------------------------------------------------------- balance
  // {"name":"balance","left":{"emoji":"🍎","n":3},"right":{"emoji":"🍎","n":5}}   or numbers: "left":7,"right":5.
  // It tips toward the heavier side; the < > = sign appears ("sign":false to hold it back, then propset {"reveal":true}).
  def('balance', {
    vb: () => [880, 480],
    draw(k) {
      const p = k.p;
      // In Arabic the first one said ("left" in the params) sits on the right.
      const A = p.left ?? p.a, B = p.right ?? p.b;
      k.s.side = { L: k.rtl ? B : A, R: k.rtl ? A : B };
      const P = { x: 440, y: 150 };
      k.s.P = P;
      const pan = (s) => `<g class="kp-pan kp-pan-${s}"><path d="M0 0 L-86 118 M0 0 L86 118" stroke="#8E98BC" stroke-width="4"/>
        <path d="M-110 118 Q0 176 110 118Z" fill="#E8A93A"/><path d="M-110 118 H110" stroke="#FFC857" stroke-width="10" stroke-linecap="round"/><g class="kp-load"></g>
        <circle r="8" fill="#6C7AA8"/></g>`;
      return `<defs>${k.cutDef()}</defs>
        <path d="M${P.x - 110} 456 Q${P.x} 410 ${P.x + 110} 456Z" fill="#6C7AA8"/><rect x="${P.x - 12}" y="${P.y}" width="24" height="290" rx="10" fill="#8E98BC"/>
        <g class="kp-beam"><rect x="${P.x - 300}" y="${P.y - 9}" width="600" height="18" rx="9" fill="#C9D1E6"/><rect x="${P.x - 300}" y="${P.y - 9}" width="600" height="6" rx="3" fill="#fff" opacity=".5"/></g>
        <circle cx="${P.x}" cy="${P.y}" r="20" fill="#FFC857"/><circle cx="${P.x}" cy="${P.y}" r="8" fill="${INK}"/>
        ${pan('L')}${pan('R')}
        <g transform="translate(${P.x} 60)"><g class="kp-sign" style="opacity:0"><circle r="46" fill="#FFC857"/><circle r="38" fill="#FFE59A"/><g class="kp-sign-glyph"></g></g></g>`;
    },
    weight(v) { return typeof v === 'object' && v ? clamp(int(v.n ?? v.count, 1), 0, 10) : num(v, 0); },
    load(k, s) {
      const v = k.s.side[s], g = k.$(`.kp-pan-${s} .kp-load`);
      g.innerHTML = '';
      const items = [];
      if (v && typeof v === 'object') {
        const n = this.weight(v), e = v.emoji || '🍎', sz = 46;
        const rows = [4, 3, 2, 1];
        let i = 0;
        for (let r = 0; r < rows.length && i < n; r++) {
          const inRow = Math.min(rows[r], n - i);
          for (let j = 0; j < inRow; j++, i++) items.push(k.add(`<g>${emo(e, (j - (inRow - 1) / 2) * sz * 0.98, 92 - r * sz * 0.86, sz)}</g>`, g));
        }
      } else {
        items.push(k.add(`<g><path d="M-48 112 L-38 46 H38 L48 112Z" fill="#5C6B9C"/><rect x="-16" y="30" width="32" height="20" rx="8" fill="none" stroke="#5C6B9C" stroke-width="8"/>
          ${txt(0, 84, k.d(v), 42, { fill: '#fff', fit: 80 })}</g>`, g));
      }
      return items;
    },
    tilt(k, deg) {
      const P = k.s.P, r = deg * Math.PI / 180;
      k.$('.kp-beam').setAttribute('transform', `rotate(${deg} ${P.x} ${P.y})`);
      k.$('.kp-pan-L').setAttribute('transform', `translate(${P.x - 280 * Math.cos(r)} ${P.y - 280 * Math.sin(r)})`);
      k.$('.kp-pan-R').setAttribute('transform', `translate(${P.x + 280 * Math.cos(r)} ${P.y + 280 * Math.sin(r)})`);
      k.s.deg = deg;
    },
    async intro(k) {
      this.tilt(k, 0);
      await k.wait(300);
      for (const s of k.rtl ? ['R', 'L'] : ['L', 'R']) {
        const items = this.load(k, s);
        hide(items);
        for (const it of items) { drop(it, 0, 120, 420); await k.wait(120); }
        await k.wait(400);
      }
      await this.settle(k);
      if (k.p.sign !== false) await this.sign(k);
    },
    async settle(k) {
      const L = this.weight(k.s.side.L), R = this.weight(k.s.side.R);
      const target = L === R ? 0 : clamp((R - L) / Math.max(L, R, 1) * 22, -14, 14) || (R > L ? 6 : -6);
      const from = k.s.deg || 0;
      await tween(1400, (t) => {
        const damp = 1 - Math.exp(-5 * t) * Math.cos(9 * t);
        this.tilt(k, from + (target - from) * damp);
      }, (q) => q);
      this.tilt(k, target);
    },
    async sign(k) {
      const L = this.weight(k.s.side.L), R = this.weight(k.s.side.R);
      k.$('.kp-sign-glyph').innerHTML = signPath(L > R ? '>' : L < R ? '<' : '=');
      await pop(k.$('.kp-sign'));
    },
    async set(k, p) {
      if (has(p.left) || has(p.right)) {
        hide(k.$('.kp-sign'));
        const A = p.left ?? (k.rtl ? k.s.side.R : k.s.side.L), B = p.right ?? (k.rtl ? k.s.side.L : k.s.side.R);
        k.s.side = { L: k.rtl ? B : A, R: k.rtl ? A : B };
        for (const s of ['L', 'R']) { const items = this.load(k, s); hide(items); for (const it of items) { drop(it, 0, 120, 380); await k.wait(80); } }
        await this.settle(k);
        if (k.p.sign !== false) await this.sign(k);
      }
      if (p.reveal || p.sign === true) await this.sign(k);
    },
  }, ['scale', 'scales', 'weigh', 'mizan']);

  // ----------------------------------------------------------- bar chart
  // {"name":"barchart","bars":[{"emoji":"🍎","v":3,"label":"<word>"},{"emoji":"🍌","v":5}],"max":6}
  // Bars build up block by block. propset {"values":[4,5]} regrows them; {"focus":2} lights bar 2.
  def('barchart', {
    vb: () => [860, 500],
    draw(k) {
      const bars = (k.p.bars || k.p.items || []).slice(0, 6).map((b) => (typeof b === 'number' ? { v: b } : b));
      k.s.bars = bars;
      const max = Math.max(1, int(k.p.max, 0) || Math.max(...bars.map((b) => num(b.v ?? b.value, 0)), 1));
      k.s.max = max;
      k.s.vals = bars.map(() => 0);
      const rtl = k.rtl, ax = rtl ? 790 : 80, x0 = rtl ? 40 : 110, w = 700, base = 380, top = 50;
      Object.assign(k.s, { ax, x0, w, base, top, uh: (base - top) / max, blocks: max <= 12 });
      const step = max <= 12 ? 1 : Math.ceil(max / 10 / 5) * 5;
      let grid = '';
      for (let v = 0; v <= max; v += step) {
        const y = base - v * k.s.uh;
        grid += `<path d="M${x0} ${y} H${x0 + w}" stroke="#fff" stroke-width="2" opacity="${v ? 0.14 : 0}"/>${big(rtl ? ax + 28 : ax - 26, y, k.d(v), 26, { sw: 4 })}`;
      }
      const n = Math.max(1, bars.length), slot = w / n, bw = Math.min(110, slot * 0.6);
      Object.assign(k.s, { slot, bw });
      let labels = '';
      bars.forEach((b, i) => {
        const cx = this.cx(k, i);
        labels += `<g class="kp-bl" data-part="bar${i + 1}">${b.emoji ? emo(b.emoji, cx, base + 46, 56) : ''}${has(b.label) ? big(cx, base + (b.emoji ? 98 : 40), b.label, 28, { sw: 4, fit: slot - 8 }) : ''}</g>`;
      });
      return `<defs>${k.cutDef()}</defs>${grid}
        <rect x="${x0 - 10}" y="${base}" width="${w + 20}" height="8" rx="4" fill="#fff"/><rect x="${ax - 4}" y="${top - 20}" width="8" height="${base - top + 28}" rx="4" fill="#fff"/>
        <g class="kp-bars"></g>${labels}<g class="kp-vals"></g>`;
    },
    cx(k, i) { const n = Math.max(1, k.s.bars.length), slot = k.rtl ? n - 1 - i : i; return k.s.x0 + k.s.slot * (slot + 0.5); },
    async grow(k, i, v) {
      v = clamp(Math.round(v), 0, k.s.max);
      const c = col(k.s.bars[i].color, CANDY_BAR[i % CANDY_BAR.length]);
      const cx = this.cx(k, i), bw = k.s.bw, uh = k.s.uh, base = k.s.base;
      let g = k.$(`.kp-bar[data-i="${i}"]`);
      if (!g) g = k.add(`<g class="kp-bar" data-i="${i}" data-part="bar${i + 1}"></g>`, k.$('.kp-bars'));
      const cur = k.s.vals[i];
      if (k.s.blocks) {
        for (let u = cur; u < v; u++) {
          const b = k.add(`<g><rect x="${cx - bw / 2}" y="${base - (u + 1) * uh + 3}" width="${bw}" height="${uh - 5}" rx="${Math.min(12, uh / 4)}" fill="${shade(c, -0.3)}"/>
            <rect x="${cx - bw / 2}" y="${base - (u + 1) * uh}" width="${bw}" height="${uh - 5}" rx="${Math.min(12, uh / 4)}" fill="${c}"/>
            <rect x="${cx - bw / 2 + 8}" y="${base - (u + 1) * uh + 6}" width="${bw * 0.35}" height="${Math.max(4, uh * 0.14)}" rx="3" fill="#fff" opacity=".4"/></g>`, g);
          drop(b, 0, 60, 260);
          await k.wait(110);
        }
        for (let u = cur; u > v; u--) { const last = g.lastElementChild; await go(last, [{ opacity: 1 }, { opacity: 0 }], { duration: 160 }); last.remove(); }
      } else {
        if (!g.firstElementChild) k.add(`<rect x="${cx - bw / 2}" y="${base}" width="${bw}" height="0" rx="12" fill="${c}"/>`, g);
        const r = g.firstElementChild;
        await tween(700, (t) => { const h = (cur + (v - cur) * t) * uh; r.setAttribute('y', base - h); r.setAttribute('height', h); });
      }
      k.s.vals[i] = v;
      const vg = k.$('.kp-vals');
      vg.querySelector(`[data-i="${i}"]`)?.remove();
      const lab = k.add(`<g data-i="${i}">${badge(cx, base - v * uh - 34, 26, k.d(v), INK)}</g>`, vg);
      pop(lab, 0, 360);
    },
    async intro(k) {
      await k.wait(400);
      for (let i = 0; i < k.s.bars.length; i++) { await this.grow(k, i, num(k.s.bars[i].v ?? k.s.bars[i].value, 0)); await k.wait(250); }
    },
    async set(k, p) {
      if (has(p.values)) for (const [i, v] of [].concat(p.values).entries()) if (i < k.s.bars.length) await this.grow(k, i, num(v, 0));
      if (has(p.focus)) {
        const i = clamp(int(p.focus, 1), 1, k.s.bars.length);
        for (const b of k.$$('.kp-bar, .kp-bl')) b.classList.toggle('kp-soft', b.dataset.part !== `bar${i}`);
        bump(k.$(`.kp-bar[data-i="${i - 1}"]`), 1.06, 420);
      }
    },
    ownFocus: true,
  }, ['bars', 'graph', 'chart', 'bargraph', 'pictograph']);
  const CANDY_BAR = ['#FF6B8B', '#6CB6FF', '#5BE49B', '#FFC857', '#C79BFF', '#FF9F5A'];

  // -------------------------------------------------------------- groups
  // {"name":"groups","groups":3,"each":4,"emoji":"🍪"}   equal groups on plates; the running total is counted on (4, 8, 12) and the × sentence appears.
  // propset {"groups":4} adds a plate.
  def('groups', {
    vb: () => [900, 440],
    draw(k) {
      k.s.g = clamp(int(k.p.groups ?? k.p.g, 3), 1, 5);
      k.s.each = clamp(int(k.p.each ?? k.p.per ?? k.p.n, 4), 1, 10);
      k.s.emoji = k.p.emoji || '🍪';
      k.s.shown = 0;
      return `<defs>${k.cutDef()}</defs><g class="kp-plates"></g><g class="kp-eq"></g>`;
    },
    plateX(k, i, n) { const w = 880 / n, s = k.rtl ? n - 1 - i : i; return 10 + w * (s + 0.5); },
    plate(k, i) {
      const n = Math.max(k.s.g, i + 1), x = this.plateX(k, i, n), y = 170, r = Math.min(86, 880 / n / 2 - 10);
      const e = k.s.each, cols = e <= 4 ? 2 : 3, rows = Math.ceil(e / cols), sz = Math.min(r * 0.62, (r * 1.45) / Math.max(cols, rows));
      let items = '';
      for (let j = 0; j < e; j++) {
        const rr = Math.floor(j / cols), inRow = Math.min(cols, e - rr * cols), cc = j % cols;
        items += `<g class="kp-gi">${emo(k.s.emoji, x + (cc - (inRow - 1) / 2) * sz * 1.02, y + (rr - (rows - 1) / 2) * sz * 0.98, sz)}</g>`;
      }
      return `<g class="kp-plate" data-i="${i}"><ellipse cx="${x}" cy="${y + 10}" rx="${r}" ry="${r}" fill="#0a0628" opacity=".25"/><circle cx="${x}" cy="${y}" r="${r}" fill="#fff"/><circle cx="${x}" cy="${y}" r="${r * 0.78}" fill="none" stroke="#E3E8F4" stroke-width="5"/>${items}
        <g class="kp-run">${badge(x, 318, 32, k.d((i + 1) * e), C.purple)}</g></g>`;
    },
    async addPlate(k) {
      const i = k.s.shown;
      const el = k.add(this.plate(k, i), k.$('.kp-plates'));
      k.s.shown += 1;
      const run = el.querySelector('.kp-run'), items = [...el.querySelectorAll('.kp-gi')];
      hide(run, items);
      await pop(el.firstElementChild.nextElementSibling ? el : el, 0, 420);
      for (const it of items) { pop(it, 0, 300); await k.wait(70); }
      await k.wait(200);
      await pop(run, 0, 400);
      await k.wait(300);
    },
    async eq(k) {
      const g = k.$('.kp-eq');
      const s = `${k.d(k.s.shown)} × ${k.d(k.s.each)} = ${k.d(k.s.shown * k.s.each)}`;
      g.innerHTML = `<g>${pill(450, 400, s, { size: 40, fill: '#2FA866', w: 320, ink: '#fff' })}</g>`;
      g.querySelector('text').setAttribute('direction', k.rtl ? 'rtl' : 'ltr');
      k.fit(g);
      await pop(g.firstElementChild);
    },
    async intro(k) {
      await k.wait(300);
      for (let i = 0; i < k.s.g; i++) await this.addPlate(k);
      if (k.p.sentence !== false) await this.eq(k);
    },
    async set(k, p) {
      if (has(p.groups)) {
        const n = clamp(int(p.groups, k.s.g), 1, 5);
        k.s.g = n;
        k.$('.kp-plates').innerHTML = ''; k.$('.kp-eq').innerHTML = ''; k.s.shown = 0;
        if (has(p.each)) k.s.each = clamp(int(p.each, 4), 1, 10);
        for (let i = 0; i < n; i++) await this.addPlate(k);
        await this.eq(k);
      } else if (p.sentence) await this.eq(k);
    },
  }, ['group', 'multiply', 'times', 'multiplication', 'plates', 'equalgroups']);

  // =========================================================== language
  // Arabic letters that never join the letter after them.
  const NOJOIN_NEXT = new Set([...'اأإآٱدذرزوؤةءى']);
  const NOJOIN = new Set([...'ء']);
  const isAr = (ch) => /[؀-ۿ]/.test(ch || '');
  // A word with one letter coloured. Zero-width joiners on both sides of the
  // split keep every letter in its joined shape.
  function markWord(word, letter, color) {
    const w = [...String(word || '')], L = String(letter || '');
    const base = (c) => c.replace(/[أإآ]/g, 'ا');
    const out = [];
    let hit = false;
    for (let i = 0; i < w.length; i++) {
      const ch = w[i];
      const match = !hit && (ch === L || (isAr(L) ? base(ch) === base(L) : ch.toLowerCase() === L.toLowerCase()));
      if (match) {
        hit = true;
        const prev = w[i - 1], next = w[i + 1];
        const joinPrev = isAr(ch) && prev && isAr(prev) && !NOJOIN_NEXT.has(prev) && !NOJOIN.has(ch);
        const joinNext = isAr(ch) && next && isAr(next) && !NOJOIN_NEXT.has(ch) && !NOJOIN.has(next);
        if (joinPrev && out.length) out[out.length - 1].t += '‍';
        out.push({ t: `${joinPrev ? '‍' : ''}${ch}${joinNext ? '‍' : ''}`, c: color });
        if (joinNext) out.push({ t: '‍', c: null });
      } else if (out.length && out[out.length - 1].c === null) out[out.length - 1].t += ch;
      else out.push({ t: ch, c: null });
    }
    return out;
  }
  function wordSvg(x, y, word, letter, size, color, o = {}) {
    const segs = markWord(word, letter, color);
    const dir = textDir(word) === 'rtl' ? 'rtl' : 'ltr';
    return `<text x="${x}" y="${y}" font-size="${size}" text-anchor="middle" dominant-baseline="central" direction="${dir}" unicode-bidi="embed" font-weight="800"
      style="font-family:${FONT}" data-fit="${o.fit || 400}" fill="${o.fill || INK}">${segs.map((s) => (s.c ? `<tspan fill="${s.c}">${esc(s.t)}</tspan>` : esc(s.t))).join('')}</text>`;
  }
  // Writing a letter: its outline draws itself, then it fills in.
  async function trace(k, t, color) {
    if (!t) return;
    t.setAttribute('fill', 'transparent');
    t.setAttribute('stroke', color);
    t.setAttribute('stroke-width', '5');
    t.setAttribute('stroke-linejoin', 'round');
    t.style.strokeDasharray = '1600';
    await go(t, [{ strokeDashoffset: 1600 }, { strokeDashoffset: 0 }], { duration: 1500, easing: 'ease-in-out' });
    t.animate([{ fill: 'rgba(0,0,0,0)' }, { fill: color }], { duration: 450, fill: 'forwards' });
    await k.wait(460);
    t.setAttribute('fill', color);
    t.removeAttribute('stroke');
    t.style.strokeDasharray = '';
  }

  // {"name":"letter","ch":"ب","word":"بطة","emoji":"🦆","forms":true}   an Arabic letter card:
  // the letter (it writes itself), its forms (بـ ـبـ ـب) and an example word with the letter coloured.
  // English: {"name":"letter","ch":"B","word":"Ball","emoji":"⚽"} (capital and small letter).
  // propset {"form":"initial|medial|final|alone"} lights one form; {"trace":true} writes it again; {"word":"..","emoji":".."}.
  const FORM_KEYS = ['alone', 'initial', 'medial', 'final'];
  def('letter', {
    vb: (p) => (isAr(p.ch || p.letter) && p.forms !== false ? [900, 560] : [900, 440]),
    draw(k) {
      const p = k.p;
      const ch = String(p.ch || p.letter || 'ب').trim().slice(0, 2);
      const ar = isAr(ch);
      k.rtl = ar || k.rtl;
      const c = col(p.color, C.purple), dark = shade(c, -0.35);
      Object.assign(k.s, { ch, ar, c });
      const hasForms = ar && p.forms !== false;
      const big = ar ? ch : `${ch.toUpperCase()}${ch.toLowerCase()}`;
      // The letter card sits where reading starts.
      const lx = ar ? 680 : 220, wx = ar ? 250 : 650;
      let m = `<defs>${k.cutDef()}</defs>
        <g class="kp-lcard"><rect x="${lx - 190}" y="28" width="380" height="370" rx="44" fill="${dark}"/><rect x="${lx - 190}" y="16" width="380" height="370" rx="44" fill="#fff"/>
          <rect x="${lx - 166}" y="40" width="332" height="322" rx="30" fill="none" stroke="${shade(c, 0.6)}" stroke-width="4" stroke-dasharray="4 12" stroke-linecap="round"/>
          <text class="kp-big" x="${lx}" y="${ar ? 214 : 200}" font-size="${ar ? 250 : 210}" text-anchor="middle" dominant-baseline="central" direction="${ar ? 'rtl' : 'ltr'}" font-weight="800" fill="${c}" style="font-family:${FONT}" data-fit="320">${esc(big)}</text></g>
        <g class="kp-ex"><g class="kp-pic">${emo(p.emoji || '⭐', wx, 140, 170)}</g>
          ${has(p.word) ? `<g class="kp-word">${this.strip(wx, p.word, ch, c)}</g>` : ''}</g>`;
      if (hasForms) {
        const forms = NOJOIN_NEXT.has(ch) ? [['alone', ch], ['final', `ـ${ch}`]] : [['alone', ch], ['initial', `${ch}ـ`], ['medial', `ـ${ch}ـ`], ['final', `ـ${ch}`]];
        const n = forms.length, tw = 170, gap = 26, total = n * tw + (n - 1) * gap;
        forms.forEach(([key, f], i) => {
          const x = 450 + total / 2 - tw / 2 - i * (tw + gap);   // right to left
          m += `<g class="kp-form" data-part="${key}"><rect x="${x - tw / 2}" y="${430 + 6}" width="${tw}" height="112" rx="26" fill="${shade(c, -0.45)}"/>
            <rect x="${x - tw / 2}" y="430" width="${tw}" height="112" rx="26" fill="${shade(c, 0.78)}"/>
            ${txt(x, 482, f, 72, { fill: dark, dir: 'rtl', fit: tw - 20 })}</g>`;
        });
      }
      return m;
    },
    async intro(k) {
      const card = k.$('.kp-lcard'), bigT = k.$('.kp-big'), pic = k.$('.kp-pic'), word = k.$('.kp-word'), forms = k.$$('.kp-form');
      hide(pic, word, forms);
      await pop(card, 0, 460);
      await trace(k, bigT, k.s.c);
      for (const f of forms) { pop(f, 0, 400); await k.wait(220); }
      if (forms.length) await k.wait(300);
      pop(pic);
      await k.wait(350);
      await fade(word, 0, 400);
      bump(word, 1.08, 500);
      if (has(k.p.form)) await this.set(k, { form: k.p.form });
    },
    async set(k, p) {
      if (has(p.form)) {
        const key = { isolated: 'alone', start: 'initial', begin: 'initial', beginning: 'initial', first: 'initial', middle: 'medial', mid: 'medial', end: 'final', last: 'final', أول: 'initial', وسط: 'medial', آخر: 'final', منفصل: 'alone' }[p.form] || p.form;
        const f = k.focus(FORM_KEYS.includes(key) ? key : null, '.kp-form');
        if (f) bump(f, 1.15, 500);
      }
      if (p.trace) await trace(k, k.$('.kp-big'), k.s.c);
      if (has(p.word) || has(p.emoji)) {
        const ex = k.$('.kp-ex');
        await go(ex, [{ opacity: 1 }, { opacity: 0 }], { duration: 260 });
        Object.assign(k.p, { word: p.word ?? k.p.word, emoji: p.emoji ?? k.p.emoji });
        const wx = k.s.ar ? 250 : 650;
        ex.innerHTML = `<g class="kp-pic">${emo(k.p.emoji || '⭐', wx, 140, 170)}</g><g class="kp-word">${this.strip(wx, k.p.word || '', k.s.ch, k.s.c)}</g>`;
        k.fit(ex);
        ex.style.opacity = '';
        pop(ex.firstElementChild);
        await fade(ex.lastElementChild, 300);
      }
    },
    // The example word on a white strip; its letter in the card's colour.
    strip(x, word, ch, c) {
      return `<rect x="${x - 200}" y="${268}" width="400" height="104" rx="32" fill="${shade(c, -0.45)}"/><rect x="${x - 200}" y="260" width="400" height="104" rx="32" fill="#fff"/>
        ${wordSvg(x, 314, word, ch, 80, shade(c, -0.25), { fit: 360, fill: INK })}`;
    },
    ownFocus: true,
  }, ['arabicletter', 'harf', 'abc', 'englishletter', 'alphabet', 'lettercard']);

  // ============================================================ science
  // --------------------------------------------------------------- plant
  // {"name":"plant","stage":1-5}   seed -> sprout -> seedling -> plant -> flower, in a pot.
  // propset {"stage":3}: the watering can pours and it grows to that stage. {"show":"cycle"} instead: all five in a row.
  const STAGES = ['seed', 'sprout', 'seedling', 'plant', 'flower'];
  const STEM = 'M0 0 C-10 -55 12 -105 0 -155 C-8 -185 4 -205 0 -225';
  const STEM_PCT = [0, 22, 50, 82, 100];
  const LEAVES = [   // [y, side, size, stage]
    [-46, -1, 0.8, 2], [-46, 1, 0.8, 2], [-104, -1, 1, 3], [-122, 1, 1, 3], [-168, -1, 0.95, 4], [-184, 1, 0.9, 4],
  ];
  const leaf = (y, side, s, st) => `<g transform="translate(${side * 3} ${y}) scale(${side * s} ${s})"><g class="kp-leaf" data-st="${st}" style="transform-origin:0 0">
    <path d="M0 0 C14 -26 46 -30 66 -14 C48 6 18 10 0 0Z" fill="#3DB860"/><path d="M4 -2 C22 -12 40 -14 56 -12" fill="none" stroke="#7FE39A" stroke-width="3" stroke-linecap="round"/></g></g>`;
  function plantSvg(k, stage) {
    let leaves = LEAVES.map(([y, side, s, st]) => (st === 2 ? `<g transform="translate(${side * 3} ${y}) scale(${side * s} ${s})"><g class="kp-leaf" data-st="2" style="transform-origin:0 0"><ellipse cx="22" cy="-6" rx="24" ry="14" fill="#6BD892"/></g></g>` : leaf(y, side, s, st))).join('');
    const petals = Array.from({ length: 8 }, (_, i) => `<ellipse rx="16" ry="34" cy="-34" fill="${i % 2 ? '#FF6B8B' : '#FF8FB8'}" transform="rotate(${i * 45})"/>`).join('');
    return `<g class="kp-seed" data-st="1" transform="translate(0 -8)"><path d="M-16 4 C-18 -12 -2 -20 10 -14 C20 -8 18 8 4 12 C-6 14 -14 12 -16 4Z" fill="#9A6234"/><path d="M-8 -4 C-2 -10 6 -10 10 -6" stroke="#C99260" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <path class="kp-stem" d="${STEM}" fill="none" stroke="#2FA866" stroke-width="9" stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - STEM_PCT[stage - 1]}"/>
      ${leaves}
      <g transform="translate(0 -228)"><g class="kp-bud" data-st="4" style="transform-origin:0 0"><path d="M0 4 C-14 -6 -12 -28 0 -36 C12 -28 14 -6 0 4Z" fill="#FF8FB8"/><path d="M0 4 C-10 -2 -10 -14 -6 -20 L0 -8 L6 -20 C10 -14 10 -2 0 4Z" fill="#3DB860"/></g></g>
      <g transform="translate(0 -236)"><g class="kp-flower" data-st="5" style="transform-origin:0 0">${petals}<circle r="22" fill="#FFC857"/><circle r="22" fill="none" stroke="#E8A93A" stroke-width="4" stroke-dasharray="3 5"/>
        <circle cx="-7" cy="-4" r="2.6" fill="${INK}"/><circle cx="7" cy="-4" r="2.6" fill="${INK}"/><path d="M-6 5 Q0 10 6 5" fill="none" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/></g></g>`;
  }
  function potSvg() {
    return `<path d="M-108 0 L-80 118 Q0 132 80 118 L108 0Z" fill="#D9774A"/><path d="M-108 0 L-80 118 Q-60 122 -50 123 L-74 0Z" fill="#EE9563" opacity=".6"/>
      <rect x="-122" y="-14" width="244" height="36" rx="14" fill="#E8875A"/><ellipse cx="0" cy="-12" rx="104" ry="13" fill="#6B4026"/>`;
  }
  // Which leaves, bud and flower show at a stage.
  function plantStage(g, stage, animate) {
    for (const e of g.querySelectorAll('[data-st]')) {
      const st = Number(e.dataset.st);
      let on = stage >= st;
      if (e.classList.contains('kp-bud')) on = stage === 4;
      if (e.classList.contains('kp-seed')) on = stage <= 2;
      const was = e.style.opacity !== '0';
      if (on && !was) { e.style.opacity = ''; if (animate) pop(e, 0, 520); }
      if (!on) e.style.opacity = '0';
    }
  }
  def('plant', {
    vb: (p) => (/cycle|stages|all/.test(p.show || '') ? [1000, 440] : [700, 640]),
    draw(k) {
      const p = k.p;
      k.s.cycle = /cycle|stages|all/.test(p.show || '');
      k.s.stage = clamp(int(p.stage, k.s.cycle ? 5 : 1), 1, 5);
      k.s.labels = p.labels !== false;
      if (k.s.cycle) {
        let m = `<defs>${k.cutDef()}</defs>`;
        for (let i = 0; i < 5; i++) {
          const slot = k.rtl ? 4 - i : i, x = 100 + slot * 200;
          m += `<g class="kp-cyc" data-i="${i}"><g transform="translate(${x} 300) scale(.66)"><g transform="translate(0 14)">${potSvg()}</g><g class="kp-plant">${plantSvg(k, i + 1)}</g></g>
            ${k.s.labels ? big(x, 410, k.t(STAGES[i]), 30, { fit: 180, sw: 4 }) : ''}</g>`;
          if (i < 4) m += `<path class="kp-arr" data-i="${i}" d="M${x + (k.rtl ? -72 : 72)} 236 l${k.rtl ? -50 : 50} 0" stroke="#FFC857" stroke-width="8" stroke-linecap="round"/><path class="kp-arr" data-i="${i}" d="M${x + (k.rtl ? -134 : 134)} 236 l${k.rtl ? 14 : -14} -12 v24z" fill="#FFC857"/>`;
        }
        return m;
      }
      return `<defs>${k.cutDef()}</defs>
        <g transform="translate(110 100)"><circle r="58" fill="#FFE07A" opacity=".35"/><circle r="44" fill="#FFD84D"/></g>
        <g class="kp-can" style="opacity:0"><g transform="translate(520 150)"><g class="kp-can-tilt" style="transform-origin:0 0">
          <path d="M-46 -30 H30 L36 34 H-52Z" fill="#6CB6FF"/><path d="M30 -18 L96 -54 L102 -44 L36 0Z" fill="#6CB6FF"/><path d="M-50 -20 C-86 -20 -86 24 -50 24" fill="none" stroke="#4E9BEA" stroke-width="9"/>
          <ellipse cx="99" cy="-50" rx="9" ry="13" fill="#4E9BEA" transform="rotate(-30 99 -50)"/></g></g></g>
        <g class="kp-drops"></g>
        <g transform="translate(350 450) scale(1.3)"><g transform="translate(0 14)">${potSvg()}</g><g class="kp-plant">${plantSvg(k, k.s.stage)}</g></g>
        <g class="kp-stagelab"></g>`;
    },
    async label(k) {
      if (!k.s.labels) return;
      const g = k.$('.kp-stagelab');
      g.innerHTML = pill(350, 600, k.t(STAGES[k.s.stage - 1]), { size: 34, fill: '#2FA866', w: 200 });
      k.fit(g);
      await pop(g.firstElementChild, 0, 400);
    },
    async intro(k) {
      if (k.s.cycle) {
        const cyc = k.$$('.kp-cyc'), arr = k.$$('.kp-arr');
        hide(cyc, arr);
        k.$$('.kp-plant').forEach((g, i) => plantStage(g, i + 1, false));
        await k.wait(300);
        for (let i = 0; i < 5; i++) {
          await pop(cyc[i], 0, 460);
          arr.filter((a) => Number(a.dataset.i) === i).forEach((a) => fade(a, 100, 300));
          await k.wait(350);
        }
        return;
      }
      plantStage(k.$('.kp-plant'), k.s.stage, false);
      await k.wait(300);
      await this.label(k);
    },
    async set(k, p) {
      if (k.s.cycle || !has(p.stage)) return;
      const to = clamp(int(p.stage, k.s.stage), 1, 5);
      if (to <= k.s.stage) { k.s.stage = to; plantStage(k.$('.kp-plant'), to, false); k.$('.kp-stem').setAttribute('stroke-dashoffset', 100 - STEM_PCT[to - 1]); await this.label(k); return; }
      // Water first, then it grows one stage at a time.
      const can = k.$('.kp-can'), tilt = k.$('.kp-can-tilt');
      can.style.opacity = '';
      await go(tilt, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(28deg)' }], { duration: 380 });
      const drops = k.$('.kp-drops');
      for (let i = 0; i < 6; i++) {
        const d = k.add(`<path d="M${600 + (i % 3) * 8} 120 c-6 10 -8 16 0 18 c8 -2 6 -8 0 -18z" fill="#7FC8FF"/>`, drops);
        go(d, [{ transform: 'translate(0px,0px)', opacity: 1 }, { transform: `translate(${-170 - i * 6}px, 300px)`, opacity: 0.2 }], { duration: 700, easing: 'ease-in' }).then(() => d.remove());
        await k.wait(120);
      }
      await k.wait(500);
      go(tilt, [{ transform: 'rotate(28deg)' }, { transform: 'rotate(0deg)' }], { duration: 300 }).then(() => { can.style.opacity = '0'; });
      const stem = k.$('.kp-stem');
      for (let st = k.s.stage + 1; st <= to; st++) {
        const a = 100 - STEM_PCT[st - 2], b = 100 - STEM_PCT[st - 1];
        await tween(700, (t) => stem.setAttribute('stroke-dashoffset', a + (b - a) * t), easeInOut);
        plantStage(k.$('.kp-plant'), st, true);
        k.s.stage = st;
        this.label(k);
        await k.wait(650);
      }
    },
  }, ['plants', 'grow', 'growth', 'seed', 'flower', 'lifecycle']);

  // ---------------------------------------------------------- water cycle
  // {"name":"watercycle","step":1}   1 evaporation, 2 condensation, 3 rain, 4 collection (0 = just the scene).
  // propset {"step":2}: that step plays (its motion runs; earlier steps keep their labels).
  def('watercycle', {
    vb: () => [SW, SH],
    draw(k) {
      k.s.step = 0;
      const inner = `<defs><linearGradient id="${k.id('wsky')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7CC6FF"/><stop offset="1" stop-color="#D4EEFF"/></linearGradient></defs>
        <rect width="${SW}" height="${SH}" fill="url(#${k.id('wsky')})"/>
        <g transform="translate(96 86)"><circle r="56" fill="#FFE07A" opacity=".4"/><circle r="42" fill="#FFD84D"/></g>
        <path d="M360 ${SH} L470 300 C500 250 540 220 560 180 C580 140 620 110 650 120 C690 130 720 190 760 230 L${SW} 270 V${SH}Z" fill="#7CBF6A"/>
        <path d="M560 180 C580 140 620 110 650 120 C672 126 690 150 706 172 C690 166 676 176 660 168 C646 160 632 176 616 168 C600 160 588 178 560 180Z" fill="#fff"/>
        <path d="M430 ${SH} L520 330 C560 300 610 300 640 330 L740 ${SH}Z" fill="#5FA857" opacity=".7"/>
        <path d="M0 360 Q60 344 120 360 T240 360 T360 360 T480 368 V${SH} H0Z" fill="#3E9BEA"/>
        <path d="M0 390 Q60 374 120 390 T240 390 T360 390 T480 396 V${SH} H0Z" fill="#2F86D6"/>
        <path class="kp-river" d="M640 250 C620 290 600 300 560 330 C520 360 500 380 460 392 C420 404 380 400 340 392" fill="none" stroke="#3E9BEA" stroke-width="16" stroke-linecap="round" opacity="0"/>
        <g class="kp-vapor"></g>
        <g transform="translate(560 120)"><g class="kp-cloud" style="transform-origin:0 0;transform:scale(.55)">
          <path d="M-90 30 C-120 30 -120 -14 -84 -16 C-80 -52 -30 -60 -12 -32 C4 -66 70 -60 70 -18 C108 -20 112 30 76 30Z" fill="#fff" class="kp-cloudfill"/></g></g>
        <g class="kp-rain"></g><g class="kp-labs"></g>`;
      return frame(k, inner);
    },
    async intro(k) { const s = int(k.p.step, 0); if (s) await this.set(k, { step: s }); },
    async set(k, p) {
      if (!has(p.step)) return;
      const to = /all|cycle/.test(String(p.step)) ? 4 : clamp(int(p.step, 1), 0, 4);
      for (let s = k.s.step + 1; s <= to; s++) await this.play(k, s, s === to);
      k.s.step = Math.max(k.s.step, to);
    },
    async play(k, s, keep) {
      const L = k.$('.kp-labs');
      for (const l of L.children) go(l, [{ opacity: 0.55 }], { duration: 300 });
      // Only the current step keeps moving.
      k.$$('.kp-loop').forEach((e) => e.getAnimations().forEach((a) => a.cancel()));
      k.$$('.kp-loop').forEach((e) => e.remove());
      const lab = (x, y, key) => { const g = k.add(pill(x, y, k.t(key), { size: 30, fill: '#2A2140', w: 170 }), L); k.fit(g); pop(g); };
      if (s === 1) {   // vapour rises off the warm sea
        const v = k.$('.kp-vapor');
        for (let i = 0; i < 4; i++) {
          const x = 70 + i * 80;
          const e = k.add(`<path class="kp-loop" d="M${x} 340 q12 -16 0 -32 q-12 -16 0 -32 q12 -16 0 -32" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".9"/>`, v);
          e.animate([{ transform: 'translate(0px,0px)', opacity: 0 }, { opacity: 0.9, offset: 0.3 }, { transform: 'translate(0px,-150px)', opacity: 0 }], { duration: 2000, delay: i * 400, iterations: keep ? Infinity : 2 });
        }
        lab(200, 220, 'evaporation');
        await k.wait(keep ? 1200 : 2400);
      } else if (s === 2) {   // the cloud gathers and grows grey
        const c = k.$('.kp-cloud');
        await go(c, [{ transform: 'scale(.55)' }, { transform: 'scale(1.15)' }], { duration: 1400, easing: 'ease-in-out' });
        k.$('.kp-cloudfill').animate([{ fill: '#ffffff' }, { fill: '#C9D3E6' }], { duration: 900, fill: 'forwards' });
        lab(560, 210, 'condensation');
        await k.wait(600);
      } else if (s === 3) {   // rain falls on the mountain
        const r = k.$('.kp-rain');
        for (let i = 0; i < 9; i++) {
          const x = 470 + (i % 5) * 36 + (i > 4 ? 16 : 0);
          const e = k.add(`<path class="kp-loop" d="M${x} 150 c-5 9 -7 14 0 16 c7 -2 5 -7 0 -16z" fill="#4E9BEA"/>`, r);
          e.animate([{ transform: 'translate(0px,0px)', opacity: 0 }, { opacity: 1, offset: 0.15 }, { transform: 'translate(-14px,140px)', opacity: 0 }], { duration: 900, delay: (i * 137) % 900, iterations: keep ? Infinity : 3 });
        }
        lab(690, 330, 'rain');
        await k.wait(keep ? 1200 : 2400);
      } else if (s === 4) {   // the river carries it back to the sea
        const rv = k.$('.kp-river');
        rv.setAttribute('opacity', '1');
        rv.setAttribute('pathLength', '100');
        rv.style.strokeDasharray = '100';
        await go(rv, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { duration: 1200, easing: 'ease-in-out' });
        rv.style.strokeDasharray = '';
        const flow = k.add('<path class="kp-loop" d="M640 250 C620 290 600 300 560 330 C520 360 500 380 460 392 C420 404 380 400 340 392" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-dasharray="8 26" opacity=".85"/>', k.$('.kp-rain'));
        flow.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -68 }], { duration: 1100, iterations: Infinity });
        lab(470, 440, 'collection');
        await k.wait(600);
      }
    },
  }, ['water', 'watercycle', 'rain', 'cycle']);

  // ------------------------------------------------------------- planets
  // {"name":"planets","focus":"earth"}   the Sun and eight planets in a row (sizes not to scale).
  // {"name":"planets","show":"orbit"}   the Earth going round the Sun, the Moon round the Earth.
  // propset {"focus":"mars"}.
  const PLANETS = [
    ['mercury', 15, '#B9B2A8'], ['venus', 24, '#F2C46B'], ['earth', 26, '#4E9BEA'], ['mars', 20, '#E2643C'],
    ['jupiter', 56, '#E0A86E'], ['saturn', 44, '#F0D08A'], ['uranus', 32, '#8EE0E6'], ['neptune', 31, '#4F6FE8'],
  ];
  const PL_ALIAS = { عطارد: 'mercury', الزهرة: 'venus', الأرض: 'earth', الارض: 'earth', المريخ: 'mars', المشتري: 'jupiter', زحل: 'saturn', أورانوس: 'uranus', نبتون: 'neptune', sun: 'sun', الشمس: 'sun', moon: 'moon', القمر: 'moon' };
  function planetSvg(name, r, c) {
    let extra = '';
    if (name === 'earth') extra = `<path d="M${-r * 0.5} ${-r * 0.5} q${r * 0.4} ${-r * 0.2} ${r * 0.6} ${r * 0.2} q${-r * 0.1} ${r * 0.4} ${-r * 0.5} ${r * 0.3}z M${r * 0.1} ${r * 0.2} q${r * 0.5} ${-r * 0.1} ${r * 0.6} ${r * 0.4} q${-r * 0.3} ${r * 0.3} ${-r * 0.6} ${r * 0.1}z" fill="#5BE49B"/>`;
    if (name === 'jupiter') extra = `<path d="M${-r} ${-r * 0.35} H${r} M${-r} ${r * 0.05} H${r} M${-r * 0.9} ${r * 0.45} H${r * 0.9}" stroke="#B87A48" stroke-width="${r * 0.14}" opacity=".7"/><ellipse cx="${r * 0.35}" cy="${r * 0.28}" rx="${r * 0.2}" ry="${r * 0.12}" fill="#C9583A"/>`;
    if (name === 'mars') extra = `<circle cx="${-r * 0.3}" cy="${-r * 0.2}" r="${r * 0.22}" fill="#B84A2A" opacity=".6"/>`;
    const ring = name === 'saturn' ? `<ellipse rx="${r * 1.9}" ry="${r * 0.45}" fill="none" stroke="#D9B66A" stroke-width="${r * 0.22}" transform="rotate(-16)"/>` : '';
    const ringFront = name === 'saturn' ? `<path d="M${-r * 1.9} 0 A${r * 1.9} ${r * 0.45} 0 0 0 ${r * 1.9} 0" fill="none" stroke="#D9B66A" stroke-width="${r * 0.22}" transform="rotate(-16)"/>` : '';
    return `<g>${ring}<circle r="${r}" fill="${c}"/>${extra}<circle r="${r}" fill="url(#kp-planet-shade)"/>${ringFront}</g>`;
  }
  def('planets', {
    vb: (p) => (/orbit/.test(p.show || '') ? [760, 520] : [1000, 330]),
    draw(k) {
      const shadeDef = `<radialGradient id="kp-planet-shade" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#0a0628" stop-opacity=".45"/></radialGradient>`;
      k.s.orbit = /orbit/.test(k.p.show || '');
      if (k.s.orbit) {
        const id = k.id('orb');
        return `<defs>${k.cutDef()}${shadeDef}<path id="${id}" d="M640 260 A260 170 0 1 1 120 260 A260 170 0 1 1 640 260"/></defs>
          <ellipse cx="380" cy="260" rx="260" ry="170" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="6 12" opacity=".5"/>
          <g transform="translate(380 260)"><circle r="92" fill="#FFC857" opacity=".25"/><circle r="74" fill="#FFB547"/><circle r="74" fill="url(#kp-planet-shade)"/></g>
          ${big(380, 260, k.t('sun'), 30, { sw: 4 })}
          <g class="kp-earth" style="opacity:0"><animateMotion dur="10s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion>
            ${planetSvg('earth', 30, '#4E9BEA')}
            <g><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="3s" repeatCount="indefinite"/><circle cx="54" cy="0" r="9" fill="#D9DCE8"/></g>
            ${big(0, 54, k.t('earth'), 24, { sw: 4 })}</g>`;
      }
      const rtl = k.rtl;
      let m = `<defs>${k.cutDef()}${shadeDef}</defs><g class="kp-sun"><circle cx="${rtl ? 1060 : -60}" cy="170" r="190" fill="#FFC857" opacity=".25"/><circle cx="${rtl ? 1060 : -60}" cy="170" r="170" fill="#FFB547"/></g>`;
      let x = 150;
      PLANETS.forEach(([name, r, c], i) => {
        x += i ? PLANETS[i - 1][1] + r + (i === 5 ? 62 : i === 6 ? 52 : 24) : r;
        const px = rtl ? 1000 - x : x;
        m += `<g class="kp-planet" data-part="${name}" data-i="${i}"><g transform="translate(${px} 170)"><g class="kp-pb">${planetSvg(name, r, c)}</g></g></g>`;
      });
      k.s.xs = {};
      x = 150;
      PLANETS.forEach(([name, r], i) => { x += i ? PLANETS[i - 1][1] + r + (i === 5 ? 62 : i === 6 ? 52 : 24) : r; k.s.xs[name] = rtl ? 1000 - x : x; });
      return `${m}<g class="kp-plab"></g>`;
    },
    async intro(k) {
      if (k.s.orbit) { await k.wait(400); await pop(k.$('.kp-earth')); return; }
      const ps = k.$$('.kp-planet');
      hide(ps);
      await k.wait(300);
      for (const p of ps) { pop(p, 0, 420); await k.wait(140); }
      if (has(k.p.focus)) await this.set(k, { focus: k.p.focus });
    },
    ownFocus: true,
    async set(k, p) {
      if (!has(p.focus) || k.s.orbit) return;
      const f = String(p.focus).toLowerCase();
      const name = PLANETS.find(([n]) => n === f) ? f : PL_ALIAS[p.focus] || PL_ALIAS[f];
      if (!name || name === 'sun' || name === 'moon') return;
      const hit = k.focus(name, '.kp-planet');
      bump(hit?.querySelector('.kp-pb'), 1.5, 700);
      const r = PLANETS.find(([n]) => n === name)[1];
      const g = k.$('.kp-plab');
      g.innerHTML = pill(k.s.xs[name], 170 + r + 60, k.t(name), { size: 32, fill: C.purple, w: 170 });
      k.fit(g);
      pop(g.firstElementChild, 200);
    },
  }, ['planet', 'solarsystem', 'solar', 'sun', 'orbit']);
  // ------------------------------------------------------------- animals
  // {"name":"animal","kind":"camel|cat|fish|falcon|sheep|turtle","show":"legs"}   a friendly animal; "show" lights a feature.
  // Features: legs, tail, hump (camel), wings, beak (falcon), fins (fish), wool (sheep), shell (turtle), ears, whiskers (cat).
  // propset {"show":"tail"}: that part moves the way it works (legs walk, wings flap, tails swish) and is named.
  const cuteEye = (x, y, r = 13) => `<g transform="translate(${x} ${y})"><circle r="${r}" fill="#fff"/><circle cx="${r * 0.18}" cy="${r * 0.05}" r="${r * 0.62}" fill="${INK}"/><circle cx="${r * 0.4}" cy="${-r * 0.22}" r="${r * 0.24}" fill="#fff"/></g>`;
  const legBar = (x, y0, y1, w, c, hoof) => `<g class="kp-leg" data-part="legs" style="transform-origin:${x}px ${y0}px"><rect x="${x - w / 2}" y="${y0}" width="${w}" height="${y1 - y0}" rx="${w / 2}" fill="${c}"/>${hoof ? `<ellipse cx="${x + 2}" cy="${y1 - 4}" rx="${w * 0.7}" ry="${w * 0.36}" fill="${hoof}"/>` : ''}</g>`;
  const ANIMALS = {
    camel: { ar: 'جمل', svg: () => {
      const b = '#E8B66B', d = '#D49A4E', l = '#F4CF92';
      return `<g data-part="tail" class="kp-tail" style="transform-origin:186px 238px"><path d="M186 238 C164 252 160 290 168 322" stroke="${d}" stroke-width="9" fill="none" stroke-linecap="round"/><path d="M160 316 l8 28 l12 -26z" fill="#8A5530"/></g>
        ${legBar(232, 280, 436, 22, d, '#8A5530')}${legBar(414, 280, 436, 22, d, '#8A5530')}
        <path d="M184 252 C184 210 226 196 270 196 L398 196 C440 200 464 222 464 254 C464 298 420 314 322 314 C226 314 184 298 184 252Z" fill="${b}"/>
        <path data-part="hump" class="kp-hump" d="M244 206 C258 118 384 106 406 204 Z" fill="${b}"/>
        <path d="M262 160 C290 126 350 124 376 152" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".3"/>
        <ellipse cx="320" cy="286" rx="100" ry="20" fill="${l}" opacity=".6"/>
        ${legBar(258, 284, 440, 24, b, '#8A5530')}${legBar(440, 280, 440, 24, b, '#8A5530')}
        <path d="M428 224 C470 212 486 172 494 128 L536 136 C532 188 508 248 458 270Z" fill="${b}"/>
        <g transform="translate(530 116) rotate(-8)"><ellipse cx="-40" cy="-26" rx="9" ry="14" fill="${d}" transform="rotate(-30 -40 -26)"/>
          <ellipse rx="54" ry="31" fill="${b}"/><ellipse cx="34" cy="8" rx="28" ry="21" fill="${l}"/>
          <ellipse cx="50" cy="0" rx="4" ry="6" fill="#7A5230"/>${cuteEye(-10, -8, 11)}
          <path d="M-22 -24 l-4 -6 M-14 -26 l-2 -7 M-6 -26 l0 -7" stroke="${INK}" stroke-width="2.4" stroke-linecap="round"/>
          <path d="M28 20 Q40 28 52 20" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/></g>`;
    } },
    cat: { ar: 'قطة', svg: () => {
      const b = '#FFAE5E', d = '#F08A3A', l = '#FFE3C4';
      return `<g data-part="tail" class="kp-tail" style="transform-origin:182px 272px"><path d="M182 272 C126 252 120 176 162 150" stroke="${d}" stroke-width="22" fill="none" stroke-linecap="round"/></g>
        ${legBar(222, 300, 424, 30, d, l)}${legBar(372, 300, 424, 30, d, l)}
        <ellipse cx="300" cy="290" rx="132" ry="64" fill="${b}"/><ellipse cx="310" cy="316" rx="90" ry="30" fill="${l}" opacity=".7"/>
        <path d="M250 232 q10 26 0 44 M290 228 q10 26 0 44 M330 230 q10 24 0 40" stroke="${d}" stroke-width="9" fill="none" stroke-linecap="round"/>
        ${legBar(252, 304, 430, 30, b, l)}${legBar(402, 304, 430, 30, b, l)}
        <g data-part="ears" class="kp-ears"><path d="M372 172 L384 104 L424 150Z" fill="${b}"/><path d="M384 158 L390 120 L412 150Z" fill="#FF9DB8"/>
          <path d="M454 146 L490 98 L500 170Z" fill="${b}"/><path d="M464 150 L486 118 L490 164Z" fill="#FF9DB8"/></g>
        <circle cx="436" cy="212" r="72" fill="${b}"/><ellipse cx="446" cy="246" rx="34" ry="22" fill="${l}"/>
        ${cuteEye(414, 202, 14)}${cuteEye(468, 200, 14)}
        <path d="M440 236 l12 0 l-6 8z" fill="#FF7FA8"/><path d="M434 252 q6 6 12 0 q6 6 12 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
        <g data-part="whiskers" class="kp-whisk" stroke="${INK}" stroke-width="2.6" stroke-linecap="round" opacity=".75"><path d="M418 244 L370 236 M418 252 L372 256 M476 244 L524 236 M476 252 L522 258"/></g>
        <ellipse cx="398" cy="232" rx="9" ry="5" fill="#FF7FA8" opacity=".5"/><ellipse cx="494" cy="230" rx="9" ry="5" fill="#FF7FA8" opacity=".5"/>`;
    } },
    fish: { ar: 'سمكة', svg: () => {
      const b = '#6CB6FF', d = '#3E8FE0', l = '#C9E6FF';
      let scales = '';
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) scales += `<path d="M${250 + c * 44 + (r % 2) * 22} ${200 + r * 34} q16 18 0 34" fill="none" stroke="${d}" stroke-width="4" opacity=".55" stroke-linecap="round"/>`;
      return `<g data-part="tail" class="kp-tail" style="transform-origin:176px 240px"><path d="M182 240 L96 166 Q118 240 96 314Z" fill="${d}"/></g>
        <g data-part="fins" class="kp-fin" style="transform-origin:330px 150px"><path d="M250 156 Q320 74 406 152Z" fill="${d}"/></g>
        <g data-part="fins" class="kp-fin" style="transform-origin:340px 330px"><path d="M300 326 Q336 384 378 326Z" fill="${d}"/></g>
        <ellipse cx="320" cy="240" rx="164" ry="100" fill="${b}"/><ellipse cx="330" cy="278" rx="120" ry="44" fill="${l}" opacity=".7"/>${scales}
        <path d="M402 168 Q382 240 402 312" fill="none" stroke="${d}" stroke-width="6" stroke-linecap="round" opacity=".6"/>
        <g data-part="fins" class="kp-fin" style="transform-origin:370px 262px"><path d="M372 262 C350 254 330 280 344 300 C358 296 370 284 372 262Z" fill="${d}"/></g>
        ${cuteEye(434, 214, 20)}
        <path d="M466 262 Q478 270 488 258" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
        <ellipse cx="452" cy="250" rx="10" ry="6" fill="#FF7FA8" opacity=".5"/>`;
    } },
    falcon: { ar: 'صقر', svg: () => {
      const b = '#A87A52', d = '#7A5236', l = '#F5E8D2';
      let spots = '';
      [[358, 238], [380, 262], [352, 282], [376, 306], [356, 326]].forEach(([x, y]) => { spots += `<path d="M${x} ${y} q5 6 0 10 q-5 -4 0 -10z" fill="${d}" opacity=".7"/>`; });
      return `<rect x="150" y="402" width="380" height="20" rx="10" fill="#8A5530"/><rect x="170" y="396" width="60" height="10" rx="5" fill="#8A5530"/>
        <g data-part="tail" class="kp-tail" style="transform-origin:290px 340px"><path d="M268 330 L228 432 L262 436 L288 420 L306 340Z" fill="${d}"/></g>
        <path d="M332 148 C412 150 432 240 412 320 C398 372 330 392 290 362 C250 332 250 232 280 190 C292 168 310 150 332 148Z" fill="${b}"/>
        <path d="M352 200 C402 222 412 300 382 352 C362 372 332 362 332 330 C322 280 332 232 352 200Z" fill="${l}"/>${spots}
        <g data-part="legs" class="kp-leg" style="transform-origin:330px 368px"><path d="M326 366 L322 404 M344 368 L346 404" stroke="#FFC857" stroke-width="10" stroke-linecap="round"/><path d="M308 406 h28 M332 406 h28" stroke="${INK}" stroke-width="5" stroke-linecap="round"/></g>
        <g data-part="wings" class="kp-wing" style="transform-origin:312px 210px"><path d="M306 196 C250 214 236 316 268 386 C300 364 334 300 334 226Z" fill="${d}"/>
          <path d="M282 270 q16 20 18 50 M298 252 q12 22 12 48" stroke="${b}" stroke-width="4" fill="none" stroke-linecap="round"/></g>
        <circle cx="360" cy="150" r="54" fill="${b}"/><path d="M350 150 C360 132 396 128 410 150 C406 182 380 196 360 190 C348 182 344 166 350 150Z" fill="${l}"/>
        <path d="M368 158 C364 174 366 186 372 196 C380 188 382 172 378 158Z" fill="${INK}" opacity=".8"/>
        <circle cx="380" cy="140" r="16" fill="#FFC857"/>${cuteEye(380, 140, 12)}
        <g data-part="beak" class="kp-beak"><path d="M404 136 C432 136 444 156 430 178 C424 166 414 164 404 166Z" fill="#4A4458"/><path d="M402 134 C410 130 418 132 422 138 L404 146Z" fill="#FFC857"/></g>`;
    } },
    sheep: { ar: 'خروف', svg: () => {
      const w = '#F6F6FB', ws = '#D9DCEA', g = '#4A4458';
      const puffs = [[222, 250, 50], [270, 216, 56], [334, 210, 56], [394, 226, 50], [416, 280, 46], [366, 304, 50], [292, 308, 52], [226, 296, 46]];
      return `${legBar(234, 300, 432, 18, g)}${legBar(386, 300, 432, 18, g)}
        <circle cx="176" cy="252" r="22" fill="${ws}"/><circle cx="174" cy="248" r="20" fill="${w}"/>
        <g data-part="wool" class="kp-wool">${puffs.map(([x, y, r]) => `<circle cx="${x}" cy="${y + 6}" r="${r}" fill="${ws}"/>`).join('')}${puffs.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${w}"/>`).join('')}<ellipse cx="320" cy="262" rx="110" ry="58" fill="${w}"/></g>
        ${legBar(262, 304, 436, 18, g)}${legBar(414, 300, 436, 18, g)}
        <g data-part="ears" class="kp-ears"><ellipse cx="412" cy="194" rx="28" ry="12" fill="${g}" transform="rotate(30 412 194)"/><ellipse cx="500" cy="186" rx="28" ry="12" fill="${g}" transform="rotate(-30 500 186)"/></g>
        <ellipse cx="456" cy="214" rx="44" ry="56" fill="${g}"/>
        <circle cx="436" cy="166" r="18" fill="${w}"/><circle cx="458" cy="158" r="20" fill="${w}"/><circle cx="478" cy="168" r="16" fill="${w}"/>
        ${cuteEye(440, 210, 11)}${cuteEye(474, 210, 11)}
        <path d="M448 246 q8 7 16 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><ellipse cx="456" cy="236" rx="8" ry="5" fill="#2A2140"/>`;
    } },
    turtle: { ar: 'سلحفاة', svg: () => {
      const s = '#4CC37A', sd = '#2E9A5A', sk = '#9BD77C', skd = '#77BC5A';
      return `<g data-part="tail" class="kp-tail" style="transform-origin:172px 316px"><path d="M176 306 L132 326 L180 330Z" fill="${skd}"/></g>
        ${['230 336', '412 336'].map((p) => { const [x, y] = p.split(' ').map(Number); return `<g class="kp-leg" data-part="legs" style="transform-origin:${x}px ${y - 20}px"><ellipse cx="${x}" cy="${y + 20}" rx="24" ry="34" fill="${skd}"/></g>`; }).join('')}
        <path d="M454 300 C480 250 520 236 548 252 C580 270 578 316 546 326 C518 334 486 320 454 316Z" fill="${sk}"/>
        ${cuteEye(540, 270, 12)}<path d="M548 300 Q558 306 566 298" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="530" cy="292" rx="7" ry="4" fill="#FF7FA8" opacity=".55"/>
        ${['268 346', '378 346'].map((p) => { const [x, y] = p.split(' ').map(Number); return `<g class="kp-leg" data-part="legs" style="transform-origin:${x}px ${y - 20}px"><ellipse cx="${x}" cy="${y + 24}" rx="26" ry="36" fill="${sk}"/></g>`; }).join('')}
        <g data-part="shell" class="kp-shell"><path d="M168 326 C176 170 456 164 470 326Z" fill="${s}"/>
          <path d="M168 326 C176 170 456 164 470 326" fill="none" stroke="${sd}" stroke-width="8"/>
          <rect x="160" y="318" width="318" height="24" rx="12" fill="${sd}"/>
          <path d="M280 208 L360 208 L392 256 L360 304 L280 304 L248 256Z M248 256 L190 270 M392 256 L450 270 M280 208 L262 182 M360 208 L376 182 M280 304 L262 324 M360 304 L376 324" fill="none" stroke="${sd}" stroke-width="7" stroke-linejoin="round"/>
          <path d="M226 210 C250 186 290 176 320 176" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" opacity=".3"/></g>`;
    } },
  };
  const ANIMAL_ALIAS = { camel: 'camel', جمل: 'camel', ناقة: 'camel', cat: 'cat', kitten: 'cat', قطة: 'cat', قط: 'cat', fish: 'fish', سمكة: 'fish', falcon: 'falcon', bird: 'falcon', hawk: 'falcon', صقر: 'falcon', طائر: 'falcon', sheep: 'sheep', lamb: 'sheep', خروف: 'sheep', turtle: 'turtle', tortoise: 'turtle', سلحفاة: 'turtle' };
  const FEATURE_ALIAS = { leg: 'legs', feet: 'legs', أرجل: 'legs', wing: 'wings', أجنحة: 'wings', fin: 'fins', زعانف: 'fins', ذيل: 'tail', سنام: 'hump', صدفة: 'shell', منقار: 'beak', صوف: 'wool', ear: 'ears', أذنان: 'ears', whisker: 'whiskers', شوارب: 'whiskers' };
  def('animal', {
    vb: () => [660, 480],
    draw(k) {
      const kind = ANIMAL_ALIAS[String(k.p.kind || k.p.animal || k.p.type || 'camel').toLowerCase()] || 'camel';
      k.s.kind = kind;
      return `<defs>${k.cutDef()}</defs><ellipse cx="330" cy="444" rx="230" ry="18" fill="#0a0628" opacity=".28"/>
        <g class="kp-animal" ${k.cut}>${ANIMALS[kind].svg()}</g><g class="kp-marks"></g><g class="kp-alab"></g>`;
    },
    async intro(k) {
      const a = k.$('.kp-animal');
      hide(a);
      await k.wait(250);
      await pop(a, 0, 600);
      if (k.p.label) {
        const g = k.$('.kp-alab');
        g.innerHTML = pill(330, 462, k.rtl ? ANIMALS[k.s.kind].ar : k.s.kind, { size: 32, fill: C.purple, w: 170 });
        k.fit(g); pop(g.firstElementChild);
      }
      if (has(k.p.show)) await this.set(k, { show: k.p.show });
    },
    ownFocus: true,
    async set(k, p) {
      if (!has(p.show ?? p.feature)) return;
      const raw = String(p.show ?? p.feature).toLowerCase();
      const part = FEATURE_ALIAS[raw] || raw;
      const els = k.$$(`.kp-animal [data-part="${part}"]`);
      k.$('.kp-marks').innerHTML = '';
      k.$$('.kp-animal [data-part]').forEach((e) => e.classList.remove('kp-glow'));
      if (!els.length) return;
      els.forEach((e) => e.classList.add('kp-glow'));
      // The part does its job.
      const anims = els.map((e, i) => {
        if (part === 'legs') return e.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? -12 : 12}deg)` }, { transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? 12 : -12}deg)` }, { transform: 'rotate(0deg)' }], { duration: 700, iterations: 3 });
        if (part === 'wings') return e.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-48deg) scaleY(1.08)' }, { transform: 'rotate(0deg)' }], { duration: 520, iterations: 4, easing: 'ease-in-out' });
        if (part === 'tail') return e.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(14deg)' }, { transform: 'rotate(-10deg)' }, { transform: 'rotate(0deg)' }], { duration: 800, iterations: 3, easing: 'ease-in-out' });
        if (part === 'fins') return e.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? -14 : 14}deg)` }, { transform: 'rotate(0deg)' }], { duration: 500, iterations: 5, easing: 'ease-in-out' });
        return O(e).animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }], { duration: 600, iterations: 2 });
      });
      // Legs get counted.
      if (part === 'legs') {
        const spots = els.map((e) => { const b = e.getBBox(); return { x: b.x + b.width / 2, y: b.y + b.height }; }).sort((a, b) => a.x - b.x);
        for (let i = 1; i < spots.length; i++) spots[i].x = Math.max(spots[i].x, spots[i - 1].x + 44);
        const y = Math.max(...spots.map((sp) => sp.y)) + 24;
        spots.forEach((sp, i) => {
          const t = k.add(`<g><circle cx="${sp.x}" cy="${y}" r="19" fill="#fff" stroke="${C.purple}" stroke-width="4"/>${txt(sp.x, y + 1, k.d(i + 1), 24, { fill: INK })}</g>`, k.$('.kp-marks'));
          pop(t, 300 + i * 350, 360);
        });
      }
      const g = k.$('.kp-alab');
      g.innerHTML = pill(330, 30, k.t(part), { size: 34, fill: C.purple, w: 190 });
      k.fit(g);
      pop(g.firstElementChild, 200);
      await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    },
  }, ['animals', 'camel', 'cat', 'fish', 'falcon', 'bird', 'sheep', 'turtle']);

  // ----------------------------------------------------------- day/night
  // {"name":"daynight","time":"day|night"}   the Sun lights half the Earth; our house turns with it.
  // propset {"time":"night"} (the Earth turns half a turn) or {"spin":true} (a whole day).
  def('daynight', {
    vb: () => [900, 480],
    draw(k) {
      const night = k.p.time === 'night';
      k.s.ang = night ? 180 : 0;
      const sx = 120, ex = 600, ey = 240, R = 160;
      let rays = '';
      for (let i = 0; i < 12; i++) rays += `<rect x="-6" y="-128" width="12" height="30" rx="6" fill="#FFD84D" transform="rotate(${i * 30})"/>`;
      return `<defs>${k.cutDef()}<clipPath id="${k.id('earth')}"><circle cx="${ex}" cy="${ey}" r="${R}"/></clipPath>
        <linearGradient id="${k.id('beam')}" x1="0" x2="1"><stop offset="0" stop-color="#FFE07A" stop-opacity=".5"/><stop offset="1" stop-color="#FFE07A" stop-opacity="0"/></linearGradient></defs>
        <path d="M${sx} ${ey - 70} L${ex} ${ey - R} L${ex} ${ey + R} L${sx} ${ey + 70}Z" fill="url(#${k.id('beam')})" opacity=".55"/>
        <g transform="translate(${sx} ${ey})">${rays}<circle r="96" fill="#FFE07A" opacity=".4"/><circle r="90" fill="#FFD84D"/></g>
        <g clip-path="url(#${k.id('earth')})">
          <circle cx="${ex}" cy="${ey}" r="${R}" fill="#4E9BEA"/>
          <g class="kp-spin" style="transform-origin:${ex}px ${ey}px;transform:rotate(${k.s.ang}deg)">
            <path d="M${ex - 120} ${ey - 60} q40 -50 90 -30 q30 20 0 60 q-50 30 -90 -30z M${ex + 20} ${ey + 30} q60 -20 100 20 q-10 60 -60 60 q-50 -20 -40 -80z M${ex - 60} ${ey + 70} q30 -10 40 20 q-20 30 -40 -20z" fill="#5BE49B"/></g>
          <path d="M${ex} ${ey - R} A${R} ${R} 0 0 1 ${ex} ${ey + R}Z" fill="#0E0A33" opacity=".62"/>
        </g>
        <circle cx="${ex}" cy="${ey}" r="${R}" fill="none" stroke="#fff" stroke-width="5" opacity=".7"/>
        <g class="kp-spin kp-spin2" style="transform-origin:${ex}px ${ey}px;transform:rotate(${k.s.ang}deg)">
          <g transform="translate(${ex - R + 4} ${ey}) rotate(-90) scale(1.5)"><g class="kp-house" ${k.cut}>
            <rect x="-24" y="-46" width="48" height="44" rx="5" fill="#fff"/><path d="M-32 -44 L0 -74 L32 -44Z" fill="#FF6B8B"/><rect x="-7" y="-26" width="14" height="24" rx="3" fill="#B9784A"/>
            <rect x="-19" y="-38" width="10" height="10" rx="2" fill="#7FC8FF" class="kp-win"/><rect x="9" y="-38" width="10" height="10" rx="2" fill="#7FC8FF" class="kp-win"/></g></g></g>
        <g class="kp-dnlab"></g>`;
    },
    // The house is on the sunny side between -90 and 90 degrees of turn.
    label(k) {
      const a = ((k.s.ang % 360) + 360) % 360, day = a < 90 || a > 270;
      const h = k.$('.kp-house');
      if (h) { h.style.filter = day ? '' : 'brightness(.55)'; h.querySelectorAll('.kp-win').forEach((w) => w.setAttribute('fill', day ? '#7FC8FF' : '#FFE07A')); }
      const g = k.$('.kp-dnlab');
      if (g.dataset.day === String(day)) return;
      g.dataset.day = String(day);
      g.innerHTML = `${pill(600, 446, `${day ? '☀' : '🌙'} ${k.t(day ? 'day' : 'night')}`, { size: 34, fill: day ? '#E8A93A' : '#3B3F9E', w: 180 })}`;
      k.fit(g);
      pop(g.firstElementChild, 0, 380);
    },
    async intro(k) { await k.wait(300); this.label(k); },
    async set(k, p) {
      let turn = 0;
      if (p.spin) turn = 360;
      else if (has(p.time)) {
        const night = p.time === 'night';
        const a = ((k.s.ang % 360) + 360) % 360;
        if (night !== (a >= 90 && a <= 270)) turn = 180;
      }
      if (!turn) return;
      const from = k.s.ang, spins = k.$$('.kp-spin');
      await tween(turn === 360 ? 4200 : 2400, (t) => {
        k.s.ang = from + turn * t;
        for (const sp of spins) sp.style.transform = `rotate(${k.s.ang}deg)`;
        this.label(k);
      }, easeInOut);
    },
  }, ['day', 'night', 'dayandnight', 'earth', 'rotation']);

  // -------------------------------------------------------------- matter
  // {"name":"matter","state":"solid|liquid|gas"}   an ice cube melts to water, then the water turns to steam.
  // propset {"state":"liquid"}: the change happens (the sun warms it).
  const MATTER = ['solid', 'liquid', 'gas'];
  def('matter', {
    vb: () => [760, 460],
    draw(k) {
      k.s.state = Math.max(0, MATTER.indexOf(k.p.state || 'solid'));
      return `<defs>${k.cutDef()}</defs>
        <g transform="translate(110 90)"><circle r="56" fill="#FFE07A" opacity=".35"/><circle r="42" fill="#FFD84D"/></g>
        <g class="kp-warm" style="opacity:0"><path d="M170 130 q30 20 60 10 M176 168 q30 20 60 10" stroke="#FFD84D" stroke-width="7" fill="none" stroke-linecap="round"/></g>
        <ellipse cx="380" cy="392" rx="210" ry="40" fill="#0a0628" opacity=".25"/><ellipse cx="380" cy="380" rx="210" ry="42" fill="#E3E8F4"/><ellipse cx="380" cy="374" rx="180" ry="30" fill="#fff"/>
        <g class="kp-puddle" style="transform-origin:380px 372px;transform:scale(${k.s.state === 1 ? 1 : 0})"><ellipse cx="380" cy="372" rx="150" ry="22" fill="#6CB6FF"/><ellipse cx="350" cy="366" rx="60" ry="6" fill="#fff" opacity=".6"/></g>
        <g class="kp-ice" style="transform-origin:380px 368px;transform:scale(${k.s.state === 0 ? 1 : 0})">
          <path d="M300 368 L300 248 Q300 232 316 232 L444 232 Q460 232 460 248 L460 368Z" fill="#BFE6FF" opacity=".95"/>
          <path d="M300 248 L340 212 L484 212 L460 232 L316 232Z" fill="#E6F6FF"/><path d="M460 232 L484 212 L484 336 L460 368Z" fill="#94D2FF"/>
          <path d="M318 252 L318 330" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity=".7"/>
          ${cuteEye(356, 300, 10)}${cuteEye(404, 300, 10)}<path d="M370 324 q10 8 20 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/></g>
        <g class="kp-steam"></g><g class="kp-mlab"></g>`;
    },
    async label(k) {
      const g = k.$('.kp-mlab');
      g.innerHTML = pill(380, 440, k.t(MATTER[k.s.state]), { size: 34, fill: ['#4E9BEA', '#2FA0A8', '#8E98BC'][k.s.state], w: 170 });
      k.fit(g);
      await pop(g.firstElementChild, 0, 380);
    },
    steam(k, on) {
      const g = k.$('.kp-steam');
      g.innerHTML = '';
      if (!on) return;
      for (let i = 0; i < 4; i++) {
        const x = 300 + i * 54;
        const e = k.add(`<path d="M${x} 330 q14 -18 0 -36 q-14 -18 0 -36 q14 -18 0 -36" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/>`, g);
        e.animate([{ transform: 'translate(0px,0px)', opacity: 0 }, { opacity: 0.85, offset: 0.3 }, { transform: 'translate(0px,-170px)', opacity: 0 }], { duration: 2200, delay: i * 450, iterations: Infinity });
      }
    },
    async intro(k) { this.steam(k, k.s.state === 2); await k.wait(300); await this.label(k); },
    async set(k, p) {
      const to = MATTER.indexOf(p.state);
      if (to < 0 || to === k.s.state) return;
      const warm = k.$('.kp-warm');
      warm.style.opacity = '';
      warm.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 1200 });
      const ice = k.$('.kp-ice'), pud = k.$('.kp-puddle');
      if (to >= 1 && k.s.state === 0) {   // melting: the cube shrinks into a puddle
        await Promise.all([go(ice, [{ transform: 'scale(1)' }, { transform: 'scale(1,.5)', offset: 0.5 }, { transform: 'scale(0)' }], { duration: 1800, easing: 'ease-in' }),
          go(pud, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 1800, delay: 300 })]);
        k.s.state = 1;
        await this.label(k);
      }
      if (to === 2 && k.s.state === 1) {   // boiling off: the puddle shrinks, steam rises
        this.steam(k, true);
        await go(pud, [{ transform: 'scale(1)' }, { transform: 'scale(0)' }], { duration: 2600, easing: 'ease-in' });
        k.s.state = 2;
        await this.label(k);
      }
      if (to === 0) {   // freezing back
        this.steam(k, false);
        await Promise.all([go(pud, [{ transform: 'scale(0)' }], { duration: 400 }), go(ice, [{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 900, easing: BOUNCE })]);
        k.s.state = 0;
        await this.label(k);
      }
      go(warm, [{ opacity: 1 }, { opacity: 0 }], { duration: 400 });
    },
  }, ['states', 'ice', 'melt', 'water3', 'statesofmatter']);

  // =============================================================== ops
  const baseClear = Board.prototype.op_clear;
  const baseSay = Board.prototype.onSay;
  const baseSilence = Board.prototype.onSilence;
  const kits = (b) => b._kp || (b._kp = new Map());

  Object.assign(Board.prototype, {
    op_prop(cmd) {
      const raw = String(cmd.name || cmd.prop || '').toLowerCase().replace(/[\s_-]+/g, '');
      const name = PROPS[raw] ? raw : ALIAS[raw];
      if (!name) { console.warn('unknown prop', cmd.name); return; }
      // "girl"/"boy" as a name means the kid prop with that look.
      if (raw === 'girl' || raw === 'boy') cmd = { who: raw, ...cmd };
      // A name that is itself the option: "camel" is the animal prop showing a camel, "pizza" a fraction pizza.
      if (name === 'animal' && !cmd.kind && raw !== 'animal' && raw !== 'animals') cmd = { kind: raw, ...cmd };
      if (name === 'fraction' && !cmd.as && /pizza|kabsa/.test(raw)) cmd = { as: raw, ...cmd };
      const spec = PROPS[name];
      const k = new Kit(this, cmd, name, spec);
      const vbr = spec.vb(k.p, k);
      const vb = vbr.length === 4 ? vbr : [0, 0, vbr[0], vbr[1]];
      // The whole board below the title: the mascot floats on top of it.
      const top = this.top + 6;
      const area = { x: 24, y: top, w: W - 48, h: 584 - top };
      const fill = num(cmd.scale, spec.fill || 1);
      let w = num(cmd.w, 0);
      if (!w) w = Math.min(area.w * fill, area.h * fill * vb[2] / vb[3]);
      w = clamp(w, 80, 960);
      const h = w * vb[3] / vb[2];
      const x = num(cmd.x, area.x + (area.w - w) / 2);
      const empty = this.cursorY <= this.top + 2;
      let y = num(cmd.y, empty ? area.y + Math.max(0, (area.h - h) / 2) : this.cursorY);
      y = this.avoid({ x, y: Math.max(y, this.top), w, h });
      const el = document.createElement('div');
      el.className = `kp kp-${name}`;
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      el.innerHTML = `<svg viewBox="${vb.join(' ')}" width="100%" height="100%" overflow="visible" aria-hidden="true"><g class="kp-root"></g></svg>`;
      k.el = el;
      k.svg = el.firstElementChild;
      k.root = k.svg.firstElementChild;
      k.vb = vb;
      k.root.innerHTML = spec.draw(k);
      this.addHtml(el);
      el.dir = 'ltr';   // every text sets its own direction
      k.fit();
      document.fonts?.ready?.then(() => { if (k.alive()) k.fit(); });
      const rec = this.register(cmd.id || `prop${UID}`, { nodes: [el], bbox: { x, y, w, h } });
      k.key = rec.id;
      kits(this).set(rec.id, k);
      if (spec.intro) k.run(() => spec.intro(k));
      if (cmd.then && spec.set) k.run(() => spec.set(k, cmd.then));
    },

    // {"op":"propset","id":"<id>",...}: the prop's own change (see each prop).
    op_propset(cmd) {
      const all = kits(this);
      const k = all.get(cmd.id || cmd.target) || [...all.values()].reverse().find((x) => x.alive());
      if (!k || !k.alive() || !k.spec.set) return;
      const p = { ...cmd };
      delete p.op; delete p.id; delete p.target;
      k.run(async () => {
        await k.spec.set(k, p);
        if (has(p.focus) && k.spec.focusable !== false && !k.spec.ownFocus) k.focus(p.focus === 'none' ? null : p.focus);
      });
    },

    op_clear(cmd) {
      baseClear.call(this, cmd);
      kits(this).clear();
    },

    // While a teacher on the board is "talking", the voice is hers: her
    // mouth moves and the mascot listens. Otherwise the mascot talks.
    onSay(text, speaker) {
      const talkers = isKids() ? [...kits(this).values()].filter((k) => k.alive() && k.talker && k.spec.say) : [];
      if (talkers.length) { talkers.forEach((k) => k.spec.say(k, text)); return; }
      baseSay?.call(this, text, speaker);
    },
    onSilence() {
      for (const k of kits(this).values()) if (k.s.talking) k.s.hushed = true;
      baseSilence?.call(this);
    },
  });

  // For tests and the docs: the names the library knows.
  window.KidProps = { names: () => Object.keys(PROPS), aliases: () => ({ ...ALIAS }) };
})();
