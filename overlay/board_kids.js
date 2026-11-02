// Kids mode: a mascot who lives on the board and talks with the voice, big
// picture stickers instead of text boxes, choice cards answered out loud, a
// star meter, a confetti cheer for right answers, and comic-strip stories.
// Extends Board.prototype; loaded after board_extras.js. Everything here
// waits for body.kids (app.js toggles it); without it the board is untouched.
//
// Motion has a job: the mascot's mouth moves only while the voice plays, its
// eyes follow what's being talked about, and celebrations fire only on a
// right answer or an earned star. Pictures pop in once and then hold still.
(() => {
  const isKids = () => document.body.classList.contains('kids');
  const st = (b) => b._kd || (b._kd = { stars: 0, goal: 0, rtl: false, picks: new Map(), stories: new Map() });
  const make = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => escapeHtml(s ?? '');
  const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
  const num = (v, d) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : d);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const digits = (n, rtl) => (rtl ? String(n).replace(/\d/g, (d) => AR_DIGITS[d]) : String(n));
  const CANDY = ['#FF6B8B', '#FFC857', '#5BE49B', '#6CB6FF', '#C79BFF', '#FF9F5A', '#7FE3FF'];
  // Choice cards: one colour each, so "the blue one" is an answer too.
  const CARD_COLORS = ['red', 'blue', 'green', 'amber'];
  const SIZES = { s: 110, m: 160, l: 230, xl: 300 };
  const sizeOf = (v, d) => (typeof v === 'string' && SIZES[v.toLowerCase()]) || clamp(num(v, d), 50, 420);

  const shade = (hex, k) => {   // k < 0 darkens, k > 0 lightens
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k));
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  };

  // A picture for an emoji: the engine's resolved Fluent Emoji file when it
  // sent one, otherwise the character itself in Windows' colour emoji font.
  const SRC_OK = /^(\.\.\/cache\/|data:image\/)/;
  function pic(emoji, src, px) {
    if (src && SRC_OK.test(src)) return `<img class="kd-img" src="${esc(src)}" alt="" style="width:${px}px;height:${px}px">`;
    return `<span class="kd-emo" style="font-size:${Math.round(px * 0.8)}px;width:${px}px;height:${px}px">${esc(emoji || '⭐')}</span>`;
  }

  // Which way pictures with labels read: Arabic boards go right to left, so
  // choice 1 and story frame 1 sit on the right.
  function readsRtl(b, texts) {
    const d = textDir(texts.filter(Boolean).join(' '));
    return d ? d === 'rtl' : st(b).rtl;
  }

  // ------------------------------------------------------------ the layer
  // Mascot, star meter and confetti live in their own untransformed layer
  // above the content: camera framing never moves or scales them, and a
  // clear never wipes them.
  function layer(b) {
    const s = st(b);
    if (!s.layer || !s.layer.isConnected) {
      s.layer = make('div', 'kd-layer');
      b.root.appendChild(s.layer);
    }
    return s.layer;
  }

  const pop = (n, delay = 0) => n.animate([
    { transform: 'scale(0) rotate(-8deg)', opacity: 0 },
    { transform: 'scale(1.14) rotate(3deg)', opacity: 1, offset: 0.55 },
    { transform: 'scale(0.96) rotate(-1deg)', offset: 0.8 },
    { transform: 'scale(1) rotate(0)' },
  ], { duration: 620, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });

  // ============================================================== mascot
  const M_W = 150, M_H = 165, M_SCALE = M_W / 200;
  const HOME = { x: W - M_W - 10, y: H - M_H - 6 };
  const MOUTHS = {
    smile: ['M-14 -4 Q0 10 14 -4', false],
    grin: ['M-16 -6 Q0 18 16 -6 Q0 -2 -16 -6Z', true, true],
    o: ['M0 -9 C7 -9 9 -2 9 4 C9 10 5 13 0 13 C-5 13 -9 10 -9 4 C-9 -2 -7 -9 0 -9Z', true],
    smallo: ['M0 -5 C4 -5 5 -1 5 2 C5 6 3 7 0 7 C-3 7 -5 6 -5 2 C-5 -1 -4 -5 0 -5Z', true],
    flat: ['M-9 1 Q0 -1 9 3', false],
    wobble: ['M-13 2 Q-6 -4 0 2 Q6 8 13 2', false],
    t0: ['M-11 -2 Q0 5 11 -2', false],
    t1: ['M-11 -4 Q0 10 11 -4 Q0 -1 -11 -4Z', true],
    t2: ['M-13 -5 Q0 15 13 -5 Q0 -2 -13 -5Z', true, true],
    t3: ['M-15 -6 Q0 19 15 -6 Q0 -3 -15 -6Z', true, true],
    t4: ['M-7 -6 Q0 -9 7 -6 Q9 6 0 9 Q-9 6 -7 -6Z', true],
  };
  const TALK = ['t0', 't1', 't1', 't2', 't2', 't3', 't4', 't1'];
  // Arms: degrees from hanging straight down (left arm positive swings out).
  // brows: [lift px, tilt deg] for the left brow; the right one mirrors it.
  const MOODS = {
    happy: { mouth: 'grin', brows: [0, 0], arms: [30, -30] },
    thinking: { mouth: 'flat', brows: [-2, -8], browR: [-6, -4], arms: [30, 58], look: [5, -6], tilt: 4, extra: 'think' },
    surprised: { mouth: 'o', brows: [-9, 0], arms: [62, -62], eyes: 'wide', anim: 'hop' },
    celebrating: { mouth: 'grin', brows: [-5, 0], arms: [152, -152], eyes: 'happy', extra: 'spark', anim: 'jump', back: 2600 },
    encouraging: { mouth: 'smile', brows: [-3, 0], arms: [30, -140], anim: 'nod', back: 3500 },
    curious: { mouth: 'smallo', brows: [-8, -10], browR: [0, 0], arms: [30, -30], look: [-4, -2], tilt: -8, extra: 'q' },
    oops: { mouth: 'wobble', brows: [-2, -14], arms: [18, -18], extra: 'sweat', anim: 'wobble', back: 3000 },
    listening: { mouth: 'smile', brows: [-3, 0], arms: [30, -148], tilt: 7, extra: 'waves' },
    waving: { mouth: 'grin', brows: [-2, 0], arms: [30, -150], anim: 'wave', back: 2600 },
    proud: { mouth: 'smile', brows: [-1, 0], arms: [50, -50], eyes: 'happy', back: 3000 },
  };
  const MOOD_ALIAS = { celebrate: 'celebrating', cheer: 'celebrating', yay: 'celebrating', think: 'thinking',
    surprise: 'surprised', wow: 'surprised', encourage: 'encouraging', curiosity: 'curious', sad: 'oops',
    listen: 'listening', wave: 'waving', hello: 'waving', hi: 'waving', smile: 'happy' };
  const moodName = (m) => { const k = String(m || '').toLowerCase(); return MOODS[k] ? k : MOOD_ALIAS[k] || null; };

  const sparkle = (x, y, r) => `<path d="M${x} ${y - r} Q${x + r * 0.2} ${y - r * 0.2} ${x + r} ${y} Q${x + r * 0.2} ${y + r * 0.2} ${x} ${y + r} Q${x - r * 0.2} ${y + r * 0.2} ${x - r} ${y} Q${x - r * 0.2} ${y - r * 0.2} ${x} ${y - r}Z"/>`;
  const eye = (x) => `<g transform="translate(${x} 108)"><g class="kd-blink"><g class="kd-eyesize">
      <ellipse class="kd-white" rx="16" ry="19"/>
      <g class="kd-pupil"><circle r="9.5" class="kd-ink"/><circle cx="3.6" cy="-4.2" r="3.4" fill="#fff"/><circle cx="-3" cy="3.5" r="1.4" fill="#fff" opacity=".8"/></g>
    </g></g><path class="kd-happy" d="M-13 5 Q0 -11 13 5"/></g>`;
  const arm = (x, side) => `<g transform="translate(${x} 130)"><g class="kd-arm kd-arm-${side}"><rect class="kd-limb" x="-12" y="-6" width="24" height="56" rx="12"/></g></g>`;
  const MASCOT_SVG = `<svg class="kd-svg" viewBox="0 0 200 220" width="${M_W}" height="${M_H}" aria-hidden="true">
    <defs><clipPath id="kd-mclip"><path class="kd-mouth-clip"/></clipPath></defs>
    <ellipse class="kd-shadow" cx="100" cy="211" rx="58" ry="8"/>
    <g class="kd-tilt"><g class="kd-breath">
      <ellipse class="kd-limb" cx="73" cy="199" rx="21" ry="12"/>
      <ellipse class="kd-limb" cx="127" cy="199" rx="21" ry="12"/>
      <g transform="translate(100 48)"><g class="kd-sprout">
        <path d="M0 2 C0 -8 2 -16 4 -24" fill="none" stroke="#2FA866" stroke-width="5" stroke-linecap="round"/>
        <path d="M4 -22 C-4 -38 -26 -40 -32 -29 C-22 -18 -6 -17 4 -22Z" fill="#5BE49B"/>
        <path d="M4 -24 C14 -40 34 -40 37 -29 C28 -19 13 -19 4 -24Z" fill="#8CF2BC"/>
      </g></g>
      <path class="kd-main" d="M100 44 C151 44 175 83 175 127 C175 173 142 201 100 201 C58 201 25 173 25 127 C25 83 49 44 100 44Z"/>
      <ellipse class="kd-belly" cx="100" cy="162" rx="45" ry="31"/>
      <ellipse fill="#fff" opacity=".24" cx="68" cy="76" rx="21" ry="11" transform="rotate(-32 68 76)"/>
      ${arm(42, 'l')}${arm(158, 'r')}
      <ellipse class="kd-cheek" cx="56" cy="137" rx="12" ry="7.5"/>
      <ellipse class="kd-cheek" cx="144" cy="137" rx="12" ry="7.5"/>
      ${eye(74)}${eye(126)}
      <g transform="translate(74 80)"><path class="kd-brow kd-brow-l" d="M-11 2 Q0 -5 11 2"/></g>
      <g transform="translate(126 80)"><path class="kd-brow kd-brow-r" d="M-11 2 Q0 -5 11 2"/></g>
      <g transform="translate(100 143)"><path class="kd-mouth"/><ellipse class="kd-tongue" cx="0" cy="9" rx="7" ry="4.5" clip-path="url(#kd-mclip)"/></g>
      <g class="kd-x kd-x-think"><circle cx="164" cy="44" r="5"/><circle cx="176" cy="27" r="7"/><circle cx="191" cy="7" r="9"/></g>
      <g class="kd-x kd-x-q"><text x="168" y="54">?</text></g>
      <g class="kd-x kd-x-spark">${sparkle(24, 42, 11)}${sparkle(178, 34, 9)}${sparkle(14, 98, 7)}${sparkle(190, 92, 6)}</g>
      <g class="kd-x kd-x-sweat"><path d="M154 70 C160 80 162 86 156 90 C150 92 147 86 149 80 Z"/></g>
      <g class="kd-x kd-x-waves"><path d="M182 84 Q190 96 182 108"/><path d="M190 76 Q202 96 190 116"/></g>
    </g></g>
  </svg>`;

  class Mascot {
    constructor(b) {
      this.b = b;
      this.el = make('div', 'kd-mascot', MASCOT_SVG);
      this.svg = this.el.firstElementChild;
      this.q = (sel) => this.svg.querySelector(sel);
      this.pos = { ...HOME };
      this.home = true;
      this.mood = 'happy';
      this.talkUntil = 0;
      this.el.style.left = `${HOME.x}px`;
      this.el.style.top = `${HOME.y}px`;
      layer(b).appendChild(this.el);
      this.setColor('#FF9F5A');
      this.setMood('happy', true);
      this.blinkLoop();
    }

    alive() { return this.el.isConnected && isKids(); }

    setColor(c) {
      const hex = c ? color(c) : '#FF9F5A';
      const main = hex === COLORS.ink ? '#FF9F5A' : hex;
      this.svg.style.setProperty('--kd-main', main);
      this.svg.style.setProperty('--kd-dark', shade(main, -0.22));
      this.svg.style.setProperty('--kd-belly', shade(main, 0.42));
    }

    setArms(l, r) {
      this.q('.kd-arm-l').style.transform = `rotate(${l}deg)`;
      this.q('.kd-arm-r').style.transform = `rotate(${r}deg)`;
    }

    look(dx = 0, dy = 1) {
      const len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / 6) * 6 / len;
      for (const p of this.svg.querySelectorAll('.kd-pupil')) p.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    }

    // Eyes toward a point on the board (board px).
    lookAt(x, y) {
      const ex = this.pos.x + 100 * M_SCALE, ey = this.pos.y + 108 * M_SCALE;
      this.look(x - ex, y - ey);
    }

    setMouth(key) {
      const [d, fill, tongue] = MOUTHS[key] || MOUTHS.smile;
      const m = this.q('.kd-mouth');
      m.setAttribute('d', d);
      m.classList.toggle('kd-open', !!fill);
      this.q('.kd-mouth-clip').setAttribute('d', d);
      this.q('.kd-tongue').style.display = tongue ? '' : 'none';
    }

    setMood(name, quiet = false) {
      const key = moodName(name) || 'happy';
      const m = MOODS[key];
      this.mood = key;
      clearTimeout(this.backTimer);
      this.svg.classList.remove('x-think', 'x-q', 'x-spark', 'x-sweat', 'x-waves', 'eyes-happy', 'eyes-wide');
      if (m.extra) this.svg.classList.add(`x-${m.extra}`);
      if (m.eyes) this.svg.classList.add(`eyes-${m.eyes}`);
      const [ly, lr] = m.brows, [ry, rr] = m.browR || [ly, -lr];
      this.q('.kd-brow-l').style.transform = `translateY(${ly}px) rotate(${lr}deg)`;
      this.q('.kd-brow-r').style.transform = `translateY(${ry}px) rotate(${rr}deg)`;
      if (!this.pointing) this.setArms(...m.arms);
      if (!this.pointing) this.look(...(m.look || [0, 1]));
      this.q('.kd-tilt').style.transform = `rotate(${m.tilt || 0}deg)`;
      if (!this.talking) this.setMouth(m.mouth);
      if (!quiet && m.anim) this.play(m.anim);
      // Short-lived moods settle back to happy on their own.
      if (m.back) this.backTimer = setTimeout(() => { if (this.mood === key) this.setMood('happy', true); }, m.back);
    }

    play(kind) {
      const s = this.svg, e = { easing: 'cubic-bezier(.3,.7,.4,1)' };
      if (kind === 'jump') {
        s.animate([{ transform: 'translateY(0) scale(1,1)' }, { transform: 'translateY(4px) scale(1.08,.9)', offset: 0.15 },
          { transform: 'translateY(-46px) scale(.95,1.06)', offset: 0.45 }, { transform: 'translateY(0) scale(1.06,.94)', offset: 0.75 },
          { transform: 'translateY(0) scale(1,1)' }], { duration: 760, iterations: 2, ...e });
        this.q('.kd-sprout').animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-25deg)' }, { transform: 'rotate(20deg)' }, { transform: 'rotate(0)' }], { duration: 760, iterations: 2 });
      } else if (kind === 'hop') {
        s.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-18px)', offset: 0.4 }, { transform: 'translateY(0)' }], { duration: 420, ...e });
      } else if (kind === 'nod') {
        this.q('.kd-breath').animate([{ transform: 'translateY(0)' }, { transform: 'translateY(6px)' }, { transform: 'translateY(0)' }], { duration: 380, iterations: 2 });
      } else if (kind === 'wobble') {
        s.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(5deg)' }, { transform: 'rotate(-3deg)' }, { transform: 'rotate(0)' }], { duration: 900, easing: 'ease-in-out' });
      } else if (kind === 'wave') {
        this.q('.kd-arm-r').animate([{ transform: 'rotate(-150deg)' }, { transform: 'rotate(-118deg)' }, { transform: 'rotate(-150deg)' }], { duration: 360, iterations: 4, easing: 'ease-in-out' });
      }
    }

    blinkLoop() {
      clearTimeout(this.blinkTimer);
      this.blinkTimer = setTimeout(() => {
        if (!this.el.isConnected) return;
        this.svg.classList.add('blink');
        setTimeout(() => this.svg.classList.remove('blink'), 130);
        if (Math.random() < 0.18) setTimeout(() => { this.svg.classList.add('blink'); setTimeout(() => this.svg.classList.remove('blink'), 120); }, 260);
        this.blinkLoop();
      }, rand(2200, 5200));
    }

    // Talking: the mouth runs through open/closed shapes at a syllable-ish
    // rate for about as long as the sentence takes to say.
    say(text) {
      const n = String(text || '').replace(/\s+/g, ' ').trim().length;
      const ms = clamp(n * 70, 700, 14000);
      this.talkUntil = Date.now() + ms;
      if (['thinking', 'listening', 'curious'].includes(this.mood)) this.setMood('happy', true);
      if (this.talking) return;
      this.talking = true;
      this.svg.classList.add('talking');
      let last = '';
      const tick = () => {
        if (!this.talking) return;
        if (Date.now() > this.talkUntil || !this.el.isConnected) { this.hush(); return; }
        let k;
        do k = TALK[Math.floor(Math.random() * TALK.length)]; while (k === last);
        last = k;
        this.setMouth(k);
        this.talkTimer = setTimeout(tick, rand(85, 150));
      };
      tick();
    }

    hush() {
      this.talking = false;
      clearTimeout(this.talkTimer);
      this.svg.classList.remove('talking');
      this.setMouth(MOODS[this.mood].mouth);
    }

    moveTo(x, y, ms = 650) {
      x = clamp(x, 4, W - M_W - 4);
      y = clamp(y, this.b.top - 10, H - M_H - 4);
      this.pos = { x, y };
      if (window.gsap) gsap.to(this.el, { left: x, top: y, duration: ms / 1000, ease: 'power3.inOut' });
      else Object.assign(this.el.style, { left: `${x}px`, top: `${y}px` });
      this.el.animate([{ transform: 'rotate(0)' }, { transform: `rotate(${x < parseFloat(this.el.style.left) ? -6 : 6}deg)` }, { transform: 'rotate(0)' }], { duration: ms });
      settleMascot(this.b);
    }

    goHome() {
      this.pointing = null;
      this.home = true;
      this.moveTo(HOME.x, HOME.y);
      const m = MOODS[this.mood];
      this.setArms(...m.arms);
      this.look(...(m.look || [0, 1]));
    }

    // Stand beside a box on the board (screen px) and point an arm at it.
    // Stand beside a box on the board (screen px) and point an arm at it.
    // Of the spots around it, take the one that covers the least of the
    // target and of everything else on the board.
    pointAt(box, others = []) {
      this.home = false;
      const gap = 12, cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      const spots = [
        [box.x - M_W - gap, cy - M_H * 0.6], [box.x + box.w + gap, cy - M_H * 0.6],
        [cx - M_W / 2, box.y + box.h + gap], [cx - M_W / 2, box.y - M_H - gap],
        [box.x - M_W * 0.7, box.y + box.h - M_H * 0.3], [box.x + box.w - M_W * 0.3, box.y + box.h - M_H * 0.3],
      ];
      const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      let best = null;
      spots.forEach(([x0, y0], i) => {
        const x = clamp(x0, 4, W - M_W - 4), y = clamp(y0, this.b.top - 10, H - M_H - 4);
        const me = { x: x + 20, y: y + 10, w: M_W - 40, h: M_H - 14 };   // the body, not the empty corners
        let cost = area(me, box) * 4 + i * 400 + Math.hypot(x - x0, y - y0) * 20;
        for (const o of others) cost += area(me, o);
        if (!best || cost < best.cost) best = { x, y, cost };
      });
      this.moveTo(best.x, best.y);
      const p = this.pos;
      const side = cx >= p.x + M_W / 2 ? 'r' : 'l';
      const sx = p.x + (side === 'r' ? 158 : 42) * M_SCALE, sy = p.y + 130 * M_SCALE;
      const tx = clamp(sx, box.x + 6, box.x + box.w - 6), ty = clamp(sy, box.y + 6, box.y + box.h - 6);
      const ang = Math.atan2(ty - sy, tx - sx) * 180 / Math.PI - 90;
      this.pointing = { side, ang };
      const rest = MOODS[this.mood].arms;
      if (side === 'r') this.setArms(rest[0], ang); else this.setArms(ang, rest[1]);
      this.lookAt(cx, cy);
    }

    tag(text, cls = 'kd-name', ms = 3200) {
      this.el.querySelector(`.${cls}`)?.remove();
      if (!has(text)) return;
      const t = make('div', cls, esc(text));
      applyBidi(t);
      if (textDir(String(text)) === 'rtl') t.dir = 'rtl';
      this.el.appendChild(t);
      pop(t);
      setTimeout(() => {
        const a = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
        a.onfinish = () => t.remove();
      }, ms);
    }

    show(on) { this.el.classList.toggle('kd-hidden', !on); }
  }

  function mascot(b, create = true) {
    const s = st(b);
    if ((!s.mascot || !s.mascot.el.isConnected) && create) {
      s.mascot = new Mascot(b);
      pop(s.mascot.el);
    }
    return s.mascot && s.mascot.el.isConnected ? s.mascot : null;
  }

  // Board box of an element id, as it shows on screen (after framing).
  function screenBox(b, id) {
    const g = b.targetBox({ target: id }) || b.groupBox(id);
    if (!g) return null;
    const v = b.zoom || b.view, bb = g.bbox;
    return { x: bb.x * v.s + v.tx, y: bb.y * v.s + v.ty, w: bb.w * v.s, h: bb.h * v.s };
  }

  // ============================================================ confetti
  // A short burst: ~60 bits of candy-coloured paper and little stars thrown
  // up from a point, falling under gravity, gone in under two seconds.
  function burst(b, x, y, n = 60, spread = 1) {
    const L = layer(b);
    for (let i = 0; i < n; i++) {
      const p = make('i', 'kd-bit');
      const shape = i % 5;
      const c = CANDY[i % CANDY.length];
      if (shape === 0) p.innerHTML = `<svg viewBox="-10 -10 20 20" width="18" height="18"><path d="M0 -9 L2.6 -2.8 9 -2.8 3.9 1.2 5.8 8 0 4 -5.8 8 -3.9 1.2 -9 -2.8 -2.6 -2.8Z" fill="${c}"/></svg>`;
      else Object.assign(p.style, { background: c, width: `${shape === 1 ? 8 : 12}px`, height: `${shape === 1 ? 8 : 6}px`, borderRadius: shape === 1 ? '50%' : '2px' });
      Object.assign(p.style, { left: `${x}px`, top: `${y}px` });
      L.appendChild(p);
      const ang = (-90 + rand(-70, 70) * spread) * Math.PI / 180, v = rand(260, 560);
      const vx = Math.cos(ang) * v, vy = Math.sin(ang) * v, g = 900, T = rand(1.1, 1.8), spin = rand(-720, 720);
      const frames = [];
      for (let k = 0; k <= 8; k++) {
        const t = (k / 8) * T;
        frames.push({ transform: `translate(${vx * t * 0.8}px, ${vy * t + 0.5 * g * t * t}px) rotate(${spin * t}deg)`, opacity: k > 5 ? 1 - (k - 5) / 3 : 1 });
      }
      p.animate(frames, { duration: T * 1000, easing: 'linear', fill: 'forwards' }).onfinish = () => p.remove();
    }
  }

  // ========================================================== star meter
  const STAR_PATH = 'M0 -10 L2.9 -3.4 10 -3.1 4.6 1.6 6.2 8.6 0 4.9 -6.2 8.6 -4.6 1.6 -10 -3.1 -2.9 -3.4Z';
  const starSvg = (px, cls = '') => `<svg class="kd-star ${cls}" viewBox="-11 -11 22 22" width="${px}" height="${px}"><path d="${STAR_PATH}" stroke-linejoin="round"/><path class="kd-star-shine" d="M-3.5 -2.6 L-1.4 -6.4"/></svg>`;

  function meter(b) {
    const s = st(b);
    if (!s.meter || !s.meter.isConnected) {
      s.meter = make('div', 'kd-stars');
      layer(b).appendChild(s.meter);
    }
    const m = s.meter, rtl = s.rtl;
    m.dir = rtl ? 'rtl' : 'ltr';
    if (s.goal > 0) {
      const slots = Math.max(s.goal, s.stars);
      m.innerHTML = Array.from({ length: slots }, (_, i) => starSvg(30, i < s.stars ? 'on' : 'off')).join('');
    } else {
      m.innerHTML = `${starSvg(34, 'on')}<b>${digits(s.stars, rtl)}</b>`;
    }
    m.classList.toggle('kd-hidden', !s.stars && !s.goal);
    return m;
  }

  // The slot the next star lands in, in board px.
  function slotPos(b) {
    const s = st(b), m = meter(b);
    const stars = m.querySelectorAll('.kd-star');
    const idx = s.goal > 0 ? clamp(s.stars, 0, stars.length - 1) : 0;
    const el = stars[idx];
    if (!el) return { x: W - 40, y: 30 };
    // Measured on screen and mapped back to board px (the board is scaled).
    const L = layer(b).getBoundingClientRect(), r = el.getBoundingClientRect(), k = W / (L.width || W);
    return { x: (r.left + r.width / 2 - L.left) * k, y: (r.top + r.height / 2 - L.top) * k };
  }

  function earnStar(b, from) {
    const s = st(b);
    const L = layer(b);
    const start = from || { x: W / 2, y: H / 2 };
    meter(b).classList.remove('kd-hidden');
    const end = slotPos(b);
    const big = make('div', 'kd-flystar', starSvg(96, 'on'));
    Object.assign(big.style, { left: `${start.x - 48}px`, top: `${start.y - 48}px` });
    L.appendChild(big);
    const dx = end.x - start.x, dy = end.y - start.y;
    const lift = Math.min(-60, dy * 0.5 - 80);
    big.animate([
      { transform: 'translate(0,0) scale(0) rotate(-90deg)', opacity: 0 },
      { transform: 'translate(0,0) scale(1.25) rotate(0deg)', opacity: 1, offset: 0.25 },
      { transform: 'translate(0,0) scale(1) rotate(0deg)', offset: 0.42 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(.7) rotate(180deg)`, offset: 0.72 },
      { transform: `translate(${dx}px, ${dy}px) scale(.32) rotate(360deg)`, opacity: 1 },
    ], { duration: 1500, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' }).onfinish = () => {
      big.remove();
      s.stars += 1;
      const m = meter(b);
      const stars = m.querySelectorAll('.kd-star.on');
      const landed = s.goal > 0 ? stars[s.stars - 1] : m;
      landed?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.6)' }, { transform: 'scale(1)' }], { duration: 420, easing: 'ease-out' });
      burst(b, end.x, end.y, 18, 1.6);
      if (s.goal > 0 && s.stars === s.goal) {   // the meter is full: a proper party
        setTimeout(() => { burst(b, W * 0.3, H * 0.75, 70); burst(b, W * 0.7, H * 0.75, 70); }, 200);
        mascot(b, false)?.setMood('celebrating');
      }
    };
  }

  // ================================================================ ops
  const baseBox = Board.prototype.box;
  const baseClear = Board.prototype.op_clear;
  const baseSetView = Board.prototype.setView;
  const baseFit = Board.prototype.fitContent;
  const baseSpot = Board.prototype.op_spot;
  const baseVeil = Board.prototype.veil;
  const baseUnveil = Board.prototype.unveil;

  // The mascot floats in front of the board on its own layer: content is
  // framed over the full board and never makes room for it. When a drawing
  // runs under its corner, it steps back a little (smaller, slightly see-
  // through) so it doesn't hide the picture.
  function settleMascot(b) {
    const ma = mascot(b, false);
    if (!ma) return;
    let over = false;
    if (isKids() && ma.home) {
      const v = b.zoom || b.view;
      const me = { x: HOME.x + 14, y: HOME.y + 10, w: M_W - 28, h: M_H - 16 };
      for (const rec of b.els.values()) {
        const bb = rec.bbox;
        if (!(bb.w > 0 && bb.h > 0) || rec.solid === false) continue;
        if (b.overlaps({ x: bb.x * v.s + v.tx, y: bb.y * v.s + v.ty, w: bb.w * v.s, h: bb.h * v.s }, me)) { over = true; break; }
      }
    }
    ma.el.classList.toggle('kd-over', over);
  }

  // One picture with an optional label, centred in a cell (board px).
  function stickerEl(item, px, labelSize) {
    const fig = make('figure', 'kd-sticker');
    const count = clamp(Math.round(num(item.count, 1)), 1, 12);
    let inner;
    if (count > 1) {   // several of the same thing, for counting
      const cols = count <= 3 ? count : count <= 4 ? 2 : count <= 6 ? 3 : 4;
      const each = Math.round(px * 1.5 / Math.max(1.8, cols));
      inner = `<div class="kd-pic kd-many" style="width:${cols * (each + 8)}px">${
        Array.from({ length: count }, () => pic(item.emoji, item.src, each)).join('')}</div>`;
    } else {
      inner = `<div class="kd-pic">${pic(item.emoji, item.src, px)}</div>`;
    }
    const label = has(item.label) ? `<figcaption style="font-size:${labelSize}px;color:${color(item.color || 'ink')}">${esc(item.label)}</figcaption>` : '';
    fig.innerHTML = inner + label;
    return fig;
  }

  function placeAbs(b, el, x, y, w) {
    el.style.visibility = 'hidden';
    if (w) el.style.width = `${w}px`;
    b.addHtml(el);
    const bw = el.offsetWidth, bh = el.offsetHeight;
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, visibility: '' });
    return { x, y, w: bw, h: bh };
  }

  Object.assign(Board.prototype, {
    // ------------------------------------------------- speech contract
    // app.js calls onSay(text, speaker) as each sentence starts playing and
    // onSilence() when speech stops or is cut off. Both are no-ops outside
    // kids mode.
    onSay(text, speaker) {
      if (!isKids()) return;
      const m = mascot(this);
      m.say(text, speaker);
    },

    onSilence() {
      const m = mascot(this, false);
      if (!m) return;
      m.hush();
      // A choice is waiting for an answer: show it's the kid's turn.
      if (isKids() && st(this).awaiting && !m.pointing) m.setMood('listening', true);
    },

    // The kid asked something: the mascot thinks while the answer is
    // prepared. No big copy of her sentence over the board (the subtitle
    // line already shows what was heard); the board just steps back a little.
    veil(text) {
      if (!isKids()) { baseVeil.call(this, text); return; }
      this.unveil();
      const v = make('div', 'veil kd-veil');
      this.root.appendChild(v);
      this.veilEl = v;
      const m = mascot(this);
      if (!m.home) m.goHome();
      m.setMood('thinking');
    },

    unveil() {
      const was = !!this.veilEl;
      baseUnveil.call(this);
      const m = was && isKids() && mascot(this, false);
      if (m && m.mood === 'thinking') m.setMood('happy', true);
    },

    setView(v) { baseSetView.call(this, v); settleMascot(this); },
    fitContent() { baseFit.call(this); settleMascot(this); },

    // Kids mode draws boxes as soft, rounded candy cards instead of sketchy
    // strokes. Every template built on boxes (row, stack, flow) gets it.
    box(cmd, delay = 0) {
      if (!isKids()) return baseBox.call(this, cmd, delay);
      const x = cmd.x ?? 40, w = cmd.w || 180, h = cmd.h || 80;
      const y = Math.max(cmd.y ?? this.cursorY, this.top);
      const c = color(cmd.color || 'blue');
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'kd-card');
      const r = Math.min(22, h / 3, w / 4);
      const rect = (dy, attrs) => {
        const n = document.createElementNS(SVGNS, 'rect');
        for (const [k, val] of Object.entries({ x, y: y + dy, width: w, height: h, rx: r, ...attrs })) n.setAttribute(k, val);
        n.dataset.static = '1';
        g.appendChild(n);
      };
      rect(5, { fill: shade(c, -0.45), opacity: 0.55 });
      rect(0, { fill: cmd.fill === false ? 'none' : shade(c, -0.62), stroke: c, 'stroke-width': 3.5 });
      g.style.transformOrigin = `${x + w / 2}px ${y + h / 2}px`;
      this.svg.appendChild(g);
      g.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.05)', offset: 0.7 }, { transform: 'scale(1)' }],
        { duration: 420, delay, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
      const nodes = [g];
      if (cmd.label != null || cmd.labelHtml != null) {
        nodes.push(this.label(cmd.label, { x, y, w, h }, { size: cmd.size, delay: delay + 150, html: cmd.labelHtml, color: 'ink' }));
      }
      return this.register(cmd.id, { nodes, bbox: { x, y, w, h }, shape: 'rect' });
    },

    op_clear(cmd) {
      const s = st(this);
      baseClear.call(this, cmd);
      s.awaiting = null;
      s.picks.clear();
      s.stories.clear();
      if (cmd.title != null) s.rtl = textDir(String(cmd.title)) === 'rtl';
      if (!isKids()) return;
      // Leave the corners to the star meter and the mascot.
      const hd = this.head.lastElementChild;
      if (hd && hd.classList.contains('heading') && hd.offsetWidth > 660) {
        hd.style.fontSize = `${Math.floor(parseFloat(hd.style.fontSize) * 660 / hd.offsetWidth)}px`;
        hd.style.left = `${500 - hd.offsetWidth / 2}px`;
      }
      const m = mascot(this, false);
      if (m && !m.home) m.goHome();
    },

    // In kids mode the mascot's eyes follow what the voice is talking about.
    op_spot(cmd) {
      baseSpot.call(this, cmd);
      const m = isKids() && !cmd.clear && mascot(this, false);
      if (!m || m.pointing) return;
      const box = screenBox(this, cmd.target);
      if (box) m.lookAt(box.x + box.w / 2, box.y + box.h / 2);
    },

    // {"op":"mascot","mood":"happy","name":"Nuri","color":"amber","point":"<id>","go":"home","bubble":"Wow!"}
    op_mascot(cmd) {
      const m = mascot(this);
      if (cmd.hide) { m.show(false); return; }
      m.show(true);
      if (has(cmd.color)) m.setColor(cmd.color);
      if (has(cmd.name) && cmd.name !== st(this).name) { st(this).name = cmd.name; m.tag(cmd.name); }
      if (has(cmd.mood)) m.setMood(cmd.mood);
      const target = cmd.point || cmd.target;
      if (has(target)) {
        const box = screenBox(this, target);
        const g = this.groupBox(target);
        const mine = new Set(g ? g.ids : [target]);
        const others = [...this.els.keys()].filter((k) => !mine.has(k) && this.els.get(k).solid !== false)
          .map((k) => screenBox(this, k)).filter(Boolean);
        if (box) m.pointAt(box, others);
      } else if (has(cmd.go)) {
        const g = cmd.go;
        if (Array.isArray(g)) { m.home = false; m.pointing = null; m.moveTo(+g[0] - M_W / 2, +g[1] - M_H / 2); }
        else if (g === 'home') m.goHome();
        else {
          const spots = { left: [14, H - M_H - 6], center: [W / 2 - M_W / 2, H - M_H - 6], right: [HOME.x, HOME.y] };
          const p = spots[g] || spots.right;
          m.home = g === 'right'; m.pointing = null;
          m.moveTo(p[0], p[1]);
        }
      }
      if (has(cmd.bubble)) m.tag(String(cmd.bubble).split(/\s+/).slice(0, 3).join(' '), 'kd-bubble', 2600);
      this.fitContent();
    },

    // {"op":"sticker","id":"<id>","emoji":"🦁","label":"<1-3 words>","x":400,"y":120,"size":"l","count":1}
    op_sticker(cmd) {
      const px = sizeOf(cmd.size, 170);
      const fig = stickerEl(cmd, px, Math.round(clamp(px * 0.2, 24, 40)));
      fig.style.visibility = 'hidden';
      this.addHtml(fig);
      const w = Math.max(fig.offsetWidth, 120);
      const x = cmd.x ?? (W - w) / 2;
      fig.style.width = `${w}px`;
      const h = fig.offsetHeight;
      const y = this.avoid({ x, y: Math.max(cmd.y ?? this.cursorY, this.top), w, h });
      Object.assign(fig.style, { left: `${x}px`, top: `${y}px`, visibility: '' });
      pop(fig.querySelector('.kd-pic'), num(cmd.delay, 0) * 1000);
      this.register(cmd.id, { nodes: [fig], bbox: { x, y, w, h } });
      if (isKids() && /^(celebrat|surpris)/.test(String(cmd.mood || ''))) mascot(this).setMood(cmd.mood);
    },

    // {"op":"stickers","id":"<id>","items":[{"emoji":"🍎","label":"<word>"},...],"y":140,"size":"m"}
    // A row of pictures spread across the board, ids <id>1..<id>N.
    op_stickers(cmd) {
      const items = (cmd.items || []).slice(0, 6).map((it) => (typeof it === 'string' ? { emoji: it } : it));
      if (!items.length) return;
      const n = items.length, id = cmd.id || 'stk';
      const x0 = cmd.x ?? 40, total = cmd.w ?? (W - 2 * x0);
      const cell = total / n;
      const px = Math.min(sizeOf(cmd.size, 150), cell * 0.82);
      const rtl = readsRtl(this, items.map((i) => i.label));
      const y = Math.max(cmd.y ?? this.cursorY, this.top);
      items.forEach((it, i) => {
        const slot = rtl ? n - 1 - i : i;
        const fig = stickerEl(it, px, Math.round(clamp(px * 0.2, 22, 36)));
        const bb = placeAbs(this, fig, x0 + slot * cell, y, cell);
        pop(fig.querySelector('.kd-pic'), i * 350);
        fig.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: i * 350, fill: 'backwards' });
        this.register(`${id}${i + 1}`, { nodes: [fig], bbox: bb });
      });
    },

    // {"op":"pick","id":"<id>","q":"<short question>","choices":[{"emoji":"🐘","label":"<1-2 words>"},...]}
    // 2-4 big picture cards, each its own colour and number.
    op_pick(cmd) {
      const s = st(this);
      const choices = (cmd.choices || cmd.items || []).slice(0, 4).map((c) => (typeof c === 'string' ? { label: c } : c));
      if (choices.length < 2) return;
      const n = choices.length, id = cmd.id || 'pick';
      const rtl = readsRtl(this, [cmd.q, ...choices.map((c) => c.label)]);
      let y = Math.max(cmd.y ?? this.cursorY, this.top);
      const nodes = [];
      if (has(cmd.q)) {
        const q = make('div', 'kd-q', esc(cmd.q));
        const bb = placeAbs(this, q, 0, y, W - 80);
        q.style.left = `${(W - bb.w) / 2}px`;
        this.register(`${id}_q`, { nodes: [q], bbox: { ...bb, x: parseFloat(q.style.left) } });
        y += bb.h + 16;
      }
      const gap = 26, maxW = n === 2 ? 270 : n === 3 ? 240 : 200;
      const cw = Math.min(maxW, (W - 80 - gap * (n - 1)) / n);
      const x0 = (W - (cw * n + gap * (n - 1))) / 2;
      const px = Math.round(cw * 0.62);
      const cards = [];
      choices.forEach((c, i) => {
        const slot = rtl ? n - 1 - i : i;
        const col = color(c.color || CARD_COLORS[i % 4]);
        const card = make('div', 'kd-card-pick');
        card.style.setProperty('--kd-c', col);
        card.style.setProperty('--kd-c2', shade(col, -0.6));
        card.innerHTML = `<span class="kd-badge">${digits(i + 1, rtl)}</span>` +
          `<div class="kd-pic">${pic(c.emoji, c.src, px)}</div>` +
          (has(c.label) ? `<div class="kd-word">${esc(c.label)}</div>` : '');
        if (!has(c.emoji) && !has(c.src)) card.classList.add('kd-wordonly');
        const bb = placeAbs(this, card, x0 + slot * (cw + gap), y, cw);
        card.animate([{ opacity: 0, transform: 'translateY(40px) scale(.8)' }, { opacity: 1, transform: 'translateY(-6px) scale(1.03)', offset: 0.7 }, { transform: 'none' }],
          { duration: 520, delay: i * 260, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'backwards' });
        const rec = this.register(`${id}${i + 1}`, { nodes: [card], bbox: bb });
        cards.push(rec);
        nodes.push(card);
      });
      // Even heights, so the row reads as one set.
      const hMax = Math.max(...cards.map((r) => r.bbox.h));
      for (const r of cards) { r.nodes[0].style.height = `${hMax}px`; r.bbox.h = hMax; }
      s.picks.set(id, { ids: cards.map((r) => r.id), n });
      s.awaiting = id;
      if (isKids()) {
        const m = mascot(this);
        if (!m.talking) m.setMood('listening', true);
      }
    },

    // {"op":"answer","pick":"<id>","right":2,"chose":2}   (1-based; "retry":true keeps the answer hidden)
    op_answer(cmd) {
      const s = st(this);
      const id = cmd.pick || cmd.target || s.awaiting || [...s.picks.keys()].pop();
      const p = s.picks.get(id);
      if (!p) return;
      const right = clamp(Math.round(num(cmd.right, 0)), 0, p.n);
      const chose = clamp(Math.round(num(cmd.chose, 0)), 0, p.n);
      const correct = cmd.correct === true || (chose > 0 && chose === right);
      const card = (k) => this.els.get(`${id}${k}`)?.nodes[0];
      const m = isKids() ? mascot(this) : null;
      if (chose && !correct) {
        const c = card(chose);
        if (c) {
          c.classList.add('kd-wrong');
          c.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-12px) rotate(-2deg)' }, { transform: 'translateX(10px) rotate(2deg)' },
            { transform: 'translateX(-6px)' }, { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }], { duration: 560, easing: 'ease-in-out' });
        }
        m?.setMood(cmd.retry ? 'encouraging' : 'oops');
      }
      if (cmd.retry && !correct) return;   // try again: nothing revealed yet
      s.awaiting = null;
      for (let k = 1; k <= p.n; k++) {
        const c = card(k);
        if (!c) continue;
        if (k === right) {
          c.classList.add('kd-right');
          c.insertAdjacentHTML('beforeend', '<span class="kd-tick"><svg viewBox="0 0 24 24" width="38" height="38"><path d="M5 12.5 L10 17.5 L19 7" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>');
          c.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.12) rotate(-2deg)' }, { transform: 'scale(0.98) rotate(1deg)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }],
            { duration: 800, easing: 'ease-out' });
        } else if (k !== chose) c.classList.add('kd-dim');
      }
      if (correct) {
        const rec = this.els.get(`${id}${right || chose}`);
        const box = rec && screenBox(this, rec.id);
        const at = box ? { x: box.x + box.w / 2, y: box.y + box.h * 0.35 } : { x: W / 2, y: H / 2 };
        burst(this, at.x, at.y, 70);
        m?.setMood('celebrating');
        if (cmd.star !== false) setTimeout(() => earnStar(this, at), 500);
      }
    },

    // {"op":"stars","add":1}  {"op":"stars","goal":5}  {"op":"stars","set":0}
    op_stars(cmd) {
      const s = st(this);
      if (has(cmd.goal)) s.goal = clamp(Math.round(num(cmd.goal, 0)), 0, 10);
      if (has(cmd.set)) s.stars = clamp(Math.round(num(cmd.set, 0)), 0, 99);
      meter(this);
      const add = clamp(Math.round(num(cmd.add, 0)), 0, 3);
      const box = has(cmd.target) ? screenBox(this, cmd.target) : null;
      const from = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
      for (let i = 0; i < add; i++) setTimeout(() => earnStar(this, from), i * 700);
      if (add && isKids()) mascot(this).setMood('proud');
    },

    // {"op":"cheer"}  or  {"op":"cheer","target":"<id>"}: a confetti burst for a right answer.
    op_cheer(cmd) {
      const box = has(cmd.target) ? screenBox(this, cmd.target) : null;
      if (box) burst(this, box.x + box.w / 2, box.y + box.h / 2, 70);
      else { burst(this, W * 0.3, H * 0.7, 55); burst(this, W * 0.62, H * 0.7, 55); }
      if (isKids()) mascot(this).setMood('celebrating');
    },

    // {"op":"story","id":"<id>","frames":3}  then  {"op":"frame","story":"<id>","emoji":["🐢","🐇"],"text":"<few words>","bg":"grass"}
    // A comic strip: empty numbered panels, filled one per sentence.
    op_story(cmd) {
      const s = st(this);
      const frames = Array.isArray(cmd.frames) ? cmd.frames.slice(0, 4) : [];
      const n = clamp(Math.round(num(Array.isArray(cmd.frames) ? frames.length : cmd.frames, 3)), 2, 4);
      const id = cmd.id || 'story';
      const rtl = has(cmd.rtl) ? !!cmd.rtl : readsRtl(this, frames.map((f) => f && f.text));
      const top = Math.max(cmd.y ?? this.cursorY, this.top);
      const avail = { x: 30, y: top, w: W - 60, h: H - top - 20 };
      const grid = n === 4 ? [2, 2] : [n, 1];
      const gap = 18;
      const pw = (avail.w - gap * (grid[0] - 1)) / grid[0];
      const ph = Math.min(n === 4 ? (avail.h - gap) / 2 : 330, (avail.h - gap * (grid[1] - 1)) / grid[1]);
      const panels = [];
      for (let i = 0; i < n; i++) {
        const col = i % grid[0], row = Math.floor(i / grid[0]);
        const c = rtl ? grid[0] - 1 - col : col;
        const el = make('div', 'kd-panel kd-empty', `<span class="kd-badge">${digits(i + 1, rtl)}</span>`);
        const bb = placeAbs(this, el, avail.x + c * (pw + gap), avail.y + row * (ph + gap), pw);
        el.style.height = `${ph}px`;
        bb.h = ph;
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: i * 120, fill: 'backwards' });
        panels.push(this.register(`${id}${i + 1}`, { nodes: [el], bbox: bb }));
      }
      s.stories.set(id, { n, next: 1, rtl, ph, pw });
      this.cursorY = Math.max(this.cursorY, avail.y + ph * grid[1] + gap);
      frames.forEach((f, i) => setTimeout(() => this.op_frame({ ...(f || {}), story: id }), i * 900));
    },

    op_frame(cmd) {
      const s = st(this);
      const id = cmd.story || [...s.stories.keys()].pop();
      const story = s.stories.get(id);
      if (!story) return;
      const k = has(cmd.n) ? clamp(Math.round(num(cmd.n, 1)), 1, story.n) : story.next;
      if (k > story.n) return;
      story.next = Math.max(story.next, k + 1);
      const rec = this.els.get(`${id}${k}`);
      if (!rec) return;
      const el = rec.nodes[0];
      const pics = (Array.isArray(cmd.emoji) ? cmd.emoji : has(cmd.emoji) ? [cmd.emoji] : []).slice(0, 4);
      const srcs = cmd.srcs || [];
      const bg = /^(sky|grass|sea|space|night|desert|home|school|city|plain)$/.test(cmd.bg || '') ? cmd.bg : 'plain';
      const textH = has(cmd.text) ? 52 : 0;
      const room = story.ph - textH - 24;
      const big = Math.min(room * 0.86, (story.pw - 30) / Math.max(1, pics.length * 0.82));
      el.className = `el kd-panel kd-bg-${bg}`;
      el.innerHTML = `<span class="kd-badge">${digits(k, story.rtl)}</span>` +
        `<div class="kd-cast">${pics.map((p, i) => `<span class="kd-actor" style="--d:${i * 260}ms">${pic(p, srcs[i], Math.round(i === 0 ? big : big * 0.82))}</span>`).join('')}</div>` +
        (has(cmd.text) ? `<div class="kd-cap">${esc(cmd.text)}</div>` : '');
      applyBidi(el);
      el.querySelectorAll('.kd-actor').forEach((a, i) => pop(a, 120 + i * 260));
      // The panel being told stands out; the earlier ones stay as the recap.
      for (let i = 1; i <= story.n; i++) this.els.get(`${id}${i}`)?.nodes[0].classList.toggle('kd-now', i === k);
    },
  });

  // ------------------------------------------------------- mode switch
  // body.kids on: the mascot pops in and waves from its corner; off: the
  // kids layer hides and the board goes back to its normal self.
  const boards = () => {
    try { return typeof board !== 'undefined' && board instanceof Board ? [board] : []; } catch { return []; }
  };
  let was = isKids();
  new MutationObserver(() => {
    const on = isKids();
    if (on === was) return;
    was = on;
    for (const b of boards()) {
      const s = st(b);
      if (on) {
        layer(b).classList.remove('kd-hidden');
        const fresh = !mascot(b, false);
        const m = mascot(b);
        m.show(true);
        if (fresh) setTimeout(() => m.setMood('waving'), 500);
        meter(b);
      } else if (s.layer) {
        s.layer.classList.add('kd-hidden');
        s.mascot?.hush();
      }
      b.fitContent();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
