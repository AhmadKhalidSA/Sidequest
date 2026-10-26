// Board templates for lesson mechanics (rewind, boss, checklist, role card,
// rapid-fire, pronunciation, session card) and right-to-left text.
// Extends Board.prototype; loaded after board.js.
//
// The learner is mid-game and only glances at the board, so every template is
// big, high-contrast and still; motion only marks a change (a hit, a tick, time
// running out). Right-to-left text is handled in board.js (applyBidi, run by
// addHtml), so every op gets it; the cards here only set the direction of
// their frame and leave content spans (data-bidi) to it.
(() => {
  const HISTORY = 12;          // boards kept for rewind
  const REPLAY_MS = 20000;     // a replay returns to live on its own after this
  const HUD_Y = 88;            // boss and rapid-fire cards sit just under the title zone
  const RANKS = ['new', 'bronze', 'silver', 'gold', 'diamond'];

  const st = (b) => b._mx || (b._mx = { history: [], lists: new Map(), seq: 0 });
  const make = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const esc = (s) => escapeHtml(s ?? '');
  const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
  const int = (v, d = 0) => (has(v) && Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // One-off motion via the Web Animations API: never fights the CSS entry
  // animations or GSAP, and replays cleanly on every call.
  const pop = (n) => n?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.38)' }, { transform: 'scale(1)' }],
    { duration: 460, easing: 'ease-out' });
  const slideIn = (n, dx = 18) => n.animate([{ opacity: 0, transform: `translateX(${dx}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' });
  // The frame of a card reads one way (its labels and layout); content spans
  // marked data-bidi get their own direction from board.js.
  const frameDir = (card, dir) => {
    for (const n of [card, ...card.querySelectorAll('div')]) if (!n.hasAttribute('data-bidi')) n.dir = dir;
  };

  // --------------------------------------------------------------- rewind
  // A "board" is what was showing just before a clear: op_clear calls
  // beforeClear, which keeps a frozen DOM clone (no listeners or timers, a
  // few hundred nodes). A replay covers the live board, which keeps applying
  // ops underneath, so nothing that arrives meanwhile is lost.
  function renameIds(root, prefix) {
    // Clones must not share ids with the live board (clip paths, markers,
    // motion paths, Mermaid's id-scoped styles).
    const map = new Map();
    for (const n of root.querySelectorAll('[id]')) { map.set(n.id, prefix + n.id); n.id = prefix + n.id; }
    if (!map.size) return;
    const urls = (v) => v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q, id) => (map.has(id) ? `url(#${map.get(id)})` : m));
    for (const n of root.querySelectorAll('*')) {
      for (const a of n.attributes) {
        if (a.name === 'id') continue;
        if (/(^|:)href$/.test(a.name) && a.value.startsWith('#')) { if (map.has(a.value.slice(1))) a.value = `#${map.get(a.value.slice(1))}`; }
        else if (a.value.includes('url(')) a.value = urls(a.value);
      }
      if (n.localName === 'style') n.textContent = n.textContent.replace(/#([\w-]+)/g, (m, id) => (map.has(id) ? `#${map.get(id)}` : m));
    }
  }

  // Stop a rapid-fire clock bar where it stands (the CSS animation holds its state).
  function freezeClock(c, bar) {
    const left = clamp(1 - (Date.now() - c.start) / (c.secs * 1000), 0, 1);
    bar.style.animation = 'none';
    bar.style.transform = `scaleX(${left})`;
    bar.style.background = color(left > 0.45 ? 'green' : left > 0.15 ? 'amber' : 'red');
  }

  function snapshot(b) {
    if (!b.els.size) return;   // a blank board isn't worth replaying
    const s = st(b);
    const wrap = make('div', 'mx-snap');
    wrap.append(b.viewport.cloneNode(true), b.head.cloneNode(true));
    if (s.hud?.isConnected && s.hud.childElementCount) {   // the boss / rapid cards as they stood
      const h = s.hud.cloneNode(true);
      const bar = h.querySelector('.mx-rapid:not(.mx-done) .mx-timer i');
      if (bar && s.rapid) freezeClock(s.rapid, bar);
      wrap.appendChild(h);
    }
    wrap.querySelectorAll('.follow-pointer, .cursor, .ripple').forEach((n) => n.remove());
    wrap.querySelectorAll('.soft-dim, .spot-glow, .pulse').forEach((n) => n.classList.remove('soft-dim', 'spot-glow', 'pulse'));
    // One-shot dots (msg arrows) would travel again and then sit on the arrowhead.
    wrap.querySelectorAll('circle[data-static] > animateMotion[repeatCount="1"]').forEach((a) => a.parentNode.remove());
    // Strokes caught mid-draw show finished.
    wrap.querySelectorAll('[style*="stroke-dashoffset"]').forEach((n) => { n.style.strokeDashoffset = '0'; });
    renameIds(wrap, `rw${++s.seq}-`);
    s.history.push(wrap);
    if (s.history.length > HISTORY) s.history.shift();
  }

  function endReplay(b, instant = false) {
    const s = st(b);
    clearTimeout(s.replayTimer);
    b.root.classList.remove('mx-rewinding');
    const box = s.replay;
    s.replay = null;
    if (!box) return;
    if (instant) { box.remove(); return; }
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 220);
  }

  const REWIND_ICON = '<svg viewBox="0 0 24 16" width="26" height="17" aria-hidden="true"><path d="M11 1.5 L1.5 8 L11 14.5 Z M22.5 1.5 L13 8 L22.5 14.5 Z" fill="currentColor"/></svg>';

  // ------------------------------------------------------------------ HUD
  // The boss card and the rapid-fire bar live in their own untransformed
  // layer: framing and zoom never move or scale them, and they never count as
  // content. Instead, the content is framed into the space beside them.
  function hud(b) {
    const s = st(b);
    if (!s.hud || !s.hud.isConnected) { s.hud = make('div', 'mx-hud'); b.root.appendChild(s.hud); }
    return s.hud;
  }

  function layoutHud(b) {
    const s = st(b);
    let y = HUD_Y;
    for (const c of [s.rapid, s.boss]) {
      if (!c) continue;
      c.el.style.top = `${y}px`;
      c.rect = { x: c.el.offsetLeft, y, w: c.el.offsetWidth, h: c.el.offsetHeight };
      y += c.rect.h + 10;
    }
    b.setView(b.view);
  }

  function dropCard(b, kind, instant = false) {
    const s = st(b), c = s[kind];
    if (!c) return;
    s[kind] = null;
    clearTimeout(c.timer); clearTimeout(c.expire);
    if (instant) c.el.remove();
    else {
      const a = c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
      a.onfinish = () => c.el.remove();
    }
    layoutHud(b);
    b.fitContent();
  }

  // At a clear, a finished (or forgotten) card goes with the old board; a
  // fight or a round still in progress carries on over the new one.
  function tidyHud(b) {
    const s = st(b), now = Date.now();
    if (s.boss && (s.boss.over || now - s.boss.at > 10 * 60000)) dropCard(b, 'boss', true);
    if (s.rapid && (s.rapid.done || now - s.rapid.start > (s.rapid.secs + 30) * 1000)) dropCard(b, 'rapid', true);
  }

  // Framing with HUD cards up: if the content would land under one, fit it
  // into the free area instead (beside the boss card, or below it, whichever
  // shows it bigger; always below the rapid-fire bar).
  function clearOfHud(b, v) {
    const s = st(b);
    if (!(s.rapid?.rect || s.boss?.rect)) return v;
    let l = Infinity, t = Infinity, r = -Infinity, bt = -Infinity;
    for (const rec of b.els.values()) {
      const bb = rec.bbox;
      if (!(bb.w > 0 || bb.h > 0)) continue;
      l = Math.min(l, bb.x); t = Math.min(t, bb.y); r = Math.max(r, bb.x + bb.w); bt = Math.max(bt, bb.y + bb.h);
    }
    if (!Number.isFinite(l)) return v;
    const shown = { x: l * v.s + v.tx, y: t * v.s + v.ty, w: (r - l) * v.s, h: (bt - t) * v.s };
    if (![s.rapid?.rect, s.boss?.rect].some((rc) => rc && b.overlaps(shown, rc))) return v;
    const pad = 24, cw = Math.max(r - l, 1), ch = Math.max(bt - t, 1);
    const top = s.rapid?.rect ? Math.max(b.top, s.rapid.rect.y + s.rapid.rect.h + 12) : b.top;
    const areas = [];
    const boss = s.boss?.rect;
    if (boss) {
      areas.push({ x: pad, y: top, w: boss.x - 16 - pad, h: H - pad - top });
      const below = Math.max(top, boss.y + boss.h + 12);
      areas.push({ x: pad, y: below, w: W - 2 * pad, h: H - pad - below });
    } else {
      areas.push({ x: pad, y: top, w: W - 2 * pad, h: H - pad - top });
    }
    let best = null;
    for (const a of areas) {
      if (a.w < 80 || a.h < 60) continue;
      const sc = Math.min(1.75, a.w / cw, a.h / ch);
      if (!best || sc > best.s) {
        best = { s: sc, tx: a.x + (a.w - cw * sc) / 2 - l * sc, ty: a.y + Math.max(0, (a.h - ch * sc) / 2) - t * sc };
      }
    }
    return best || v;
  }
  const baseSetView = Board.prototype.setView;

  // ------------------------------------------------------------- checklist
  // Mostly-RTL rows share a right edge, so their boxes line up.
  function alignRtl(recs) {
    const rtl = recs.filter((r) => r && r.nodes[0].dir === 'rtl');
    if (!rtl.length) return;
    const right = Math.max(...rtl.map((r) => r.bbox.x + r.bbox.w));
    for (const r of rtl) { r.bbox.x = right - r.bbox.w; r.nodes[0].style.left = `${r.bbox.x}px`; }
  }

  function markItem(b, key, rec, hit, delay) {
    const row = rec.nodes[0], box = row.querySelector('.mx-cl-box'), text = row.querySelector('.mx-cl-text');
    row.querySelector('.mx-cl-again')?.remove();
    const w0 = row.offsetWidth;
    row.classList.toggle('mx-hit', hit);
    row.classList.toggle('mx-miss', !hit);
    row.style.color = color(hit ? 'ink' : 'amber');
    row.style.transitionDelay = `${delay}ms`;
    if (!hit) row.insertAdjacentHTML('beforeend', '<span class="mx-cl-again" title="we\'ll revisit">↺</span>');
    const dw = row.offsetWidth - w0;   // the ↺ widens the row; RTL rows grow leftwards
    if (dw) {
      if (row.dir === 'rtl') rec.bbox.x -= dw;
      rec.bbox.w += dw;
      row.style.left = `${rec.bbox.x}px`;
    }
    const bb = rec.bbox;
    const bx = bb.x + box.offsetLeft, by = bb.y + box.offsetTop, bw = box.offsetWidth, bh = box.offsetHeight;
    const g = hit
      ? b.rc.linearPath([[bx + bw * 0.1, by + bh * 0.5], [bx + bw * 0.42, by + bh * 0.9], [bx + bw * 1.1, by - bh * 0.3]],
        { stroke: COLORS.green, strokeWidth: 4.6, roughness: 0.9, bowing: 1 })
      : b.rc.line(bb.x + text.offsetLeft - 2, bb.y + text.offsetTop + text.offsetHeight,
        bb.x + text.offsetLeft + text.offsetWidth + 4, bb.y + text.offsetTop + text.offsetHeight + 2,
        { stroke: COLORS.amber, strokeWidth: 3.4, roughness: 1.6, bowing: 1.6 });
    b.addSvg(g, delay);
    b.register(`${key}_mark`, { nodes: [g], bbox: { x: bx, y: by, w: bw, h: bh }, solid: false });
  }

  // ------------------------------------------------------------------ ops
  Object.assign(Board.prototype, {
    beforeClear() {
      snapshot(this);
      tidyHud(this);
    },

    setView(v) { baseSetView.call(this, clearOfHud(this, v)); },

    // {"op":"rewind","steps":1}: the board as it was 1 board ago. {"op":"rewind","steps":0}: back to live.
    op_rewind(cmd) {
      const s = st(this);
      const steps = Math.max(0, int(cmd.steps));
      if (!steps || !s.history.length) { endReplay(this); return; }
      const back = Math.min(steps, s.history.length);   // more than we have: the oldest
      endReplay(this, true);
      const box = make('div', 'mx-replay');
      box.appendChild(s.history[s.history.length - back].cloneNode(true));
      box.appendChild(make('div', 'mx-replay-frame'));
      const badge = make('div', 'mx-replay-badge', `${REWIND_ICON}<span>Replay · ${back} back</span><i></i>`);
      badge.querySelector('i').style.animationDuration = `${REPLAY_MS}ms`;   // runs down to the return to live
      box.appendChild(badge);
      this.root.appendChild(box);
      this.root.classList.add('mx-rewinding');
      s.replay = box;
      s.replayTimer = setTimeout(() => endReplay(this), REPLAY_MS);
    },

    // {"op":"boss","id":"boss","title":"<name>","hp":5,"max":5,"streak":0}
    // Same id again: a lower hp drains a segment and shakes the card, a higher
    // streak pulses the counter; "defeated":true or "escaped":true ends it.
    op_boss(cmd) {
      const s = st(this);
      const id = cmd.id || 'boss';
      let c = s.boss;
      if (c && c.id !== id) { dropCard(this, 'boss', true); c = null; }
      const max = clamp(int(cmd.max, c?.max || 5), 1, 10);
      const hp = clamp(int(cmd.hp, c ? c.hp : max), 0, max);
      const streak = Math.max(0, int(cmd.streak, c?.streak ?? 0));
      const fresh = !c;
      if (fresh) {
        const e = make('div', 'mx-card mx-boss',
          '<div class="mx-boss-head"><span class="mx-tag">Boss</span><span class="mx-boss-name" data-bidi></span></div>' +
          '<div class="mx-hp"></div><div class="mx-stamp"><span></span></div>' +
          '<div class="mx-boss-foot"><span class="mx-streak"><b></b> in a row</span><span class="mx-hpnum"></span></div>');
        e.dir = 'ltr';
        hud(this).appendChild(e);
        slideIn(e);
        c = s.boss = { id, el: e, max: 0, hp: max, streak, over: false };
      }
      const e = c.el;
      if (fresh || cmd.title != null) {
        const n = e.querySelector('.mx-boss-name');
        n.textContent = cmd.title ?? '';
        n.removeAttribute('dir');
        applyBidi(n);
      }
      const bar = e.querySelector('.mx-hp');
      if (c.max !== max) { bar.innerHTML = '<i><b></b></i>'.repeat(max); c.max = max; c.hp = Math.min(c.hp, max); }
      [...bar.children].forEach((seg, i) => {
        const lost = i >= hp;
        if (lost && !fresh && i < c.hp) {   // just lost: flash, then drain
          seg.animate([{ background: 'rgba(255,255,255,0.9)' }, { background: 'rgba(255,255,255,0.9)', offset: 0.3 }, {}], { duration: 650 });
        }
        seg.classList.toggle('mx-lost', lost);
      });
      if (!fresh && hp < c.hp) {
        e.animate([0, -10, 9, -7, 5, -3, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 420, easing: 'ease-out' });
      }
      const sk = e.querySelector('.mx-streak');
      sk.firstElementChild.textContent = streak;
      sk.classList.toggle('mx-zero', streak === 0);
      if (!fresh && streak > c.streak) pop(sk);
      e.querySelector('.mx-hpnum').textContent = `${hp}/${max}`;
      const won = !!cmd.defeated || (hp === 0 && !cmd.escaped);
      const fled = !won && !!cmd.escaped;
      const ending = (won || fled) && !c.over;
      const settle = () => {
        if (st(this).boss !== c) return;
        e.classList.toggle('mx-won', won);
        e.classList.toggle('mx-fled', fled);
        const stamp = e.querySelector('.mx-stamp span');
        stamp.textContent = won ? 'Defeated' : fled ? 'Escaped' : '';
        if (ending) {
          const tilt = won ? -4 : 0;   // the CSS resting angle
          stamp.animate([{ opacity: 0, transform: `scale(1.6) rotate(${tilt}deg)` }, { opacity: 1, transform: `scale(1) rotate(${tilt}deg)` }],
            { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
        }
        layoutHud(this);
      };
      // A finishing blow drains its segment first, then the stamp replaces the bar.
      if (ending && !fresh && hp < c.hp) setTimeout(settle, 700); else settle();
      Object.assign(c, { hp, streak, over: won || fled, at: Date.now() });
    },

    // {"op":"checklist","id":"<id>","items":["<point>",...],"x":60,"y":110,"title":"<optional>"}
    // Items start grey; ids <id>1.. so tick (and spot/highlight) can find them.
    op_checklist(cmd) {
      const id = cmd.id || 'check';
      const x = cmd.x ?? 60, size = cmd.size || 28;
      let y = cmd.y ?? this.cursorY;
      const recs = [];
      if (has(cmd.title)) {
        const t = make('div', 'mx-cl-title', richText(cmd.title));
        const bb = this.place(t, { x, y, size: Math.round(size * 0.8), color: 'muted' });
        recs.push(this.register(`${id}_title`, { nodes: [t], bbox: bb }));
        y = bb.y + bb.h + Math.round(size * 0.3);
      }
      const items = [].concat(cmd.items || []).filter(has).slice(0, 10);
      items.forEach((text, i) => {
        const row = make('div', 'mx-cl-item', `<span class="mx-cl-box"></span><span class="mx-cl-text">${richText(text)}</span>`);
        const bb = this.place(row, { x, y, size, color: 'muted' });
        row.style.animationDelay = `${i * 140}ms`;
        recs.push(this.register(`${id}${i + 1}`, { nodes: [row], bbox: bb }));
        y = bb.y + bb.h + Math.round(size * 0.4);
      });
      alignRtl(recs);
      st(this).lists.set(id, { gen: this.gen, n: items.length });
    },

    // {"op":"tick","list":"<id>","hit":[1,3],"miss":[2]}   (1-based)
    op_tick(cmd) {
      const s = st(this);
      let id = cmd.list || cmd.id;
      if (!id || !this.els.has(`${id}1`)) {   // unknown list: the newest one on this board
        id = [...s.lists.entries()].reverse().find(([k, l]) => l.gen === this.gen && this.els.has(`${k}1`))?.[0];
        if (!id) return;
      }
      const marks = [...[].concat(cmd.hit ?? []).map((i) => [int(i), true]), ...[].concat(cmd.miss ?? []).map((i) => [int(i), false])]
        .sort((a, b) => a[0] - b[0]);
      let k = 0;
      for (const [i, hit] of marks) {
        const rec = this.els.get(`${id}${i}`);
        if (rec && rec.nodes[0].classList.contains('mx-cl-item')) markItem(this, `${id}${i}`, rec, hit, 260 * k++);
      }
    },

    // {"op":"rolecard","id":"<id>","scene":"<setting>","role":"<your role>","character":"<who the tutor plays>",
    //  "goal":"<what you must achieve>","phrases":["<useful phrase>",...]}
    op_rolecard(cmd) {
      const w = clamp(int(cmd.w, 780), 380, 960);
      const line = (k, v, cls = '') => (has(v)
        ? `<div class="mx-rc-line ${cls}"><span class="mx-k">${k}</span><span class="mx-v" data-bidi>${richText(v)}</span></div>` : '');
      const phrases = [].concat(cmd.phrases || []).filter(has).slice(0, 3);
      const card = make('div', 'mx-card mx-role',
        `<div class="mx-rc-top"><span class="mx-tag">Role-play</span>${has(cmd.scene) ? `<span class="mx-rc-scene" data-bidi>${richText(cmd.scene)}</span>` : ''}</div>` +
        (has(cmd.role) || has(cmd.character) ? `<div class="mx-rc-cast">${line('You', cmd.role)}${line('Me', cmd.character)}</div>` : '') +
        line('Goal', cmd.goal, 'mx-rc-goal') +
        (phrases.length ? `<div class="mx-chips">${phrases.map((p) => `<span class="mx-chip" data-bidi>${richText(p)}</span>`).join('')}</div>` : ''));
      // The frame reads in the language of the setup; phrases can differ (the target language).
      frameDir(card, textDir([cmd.scene, cmd.role, cmd.character, cmd.goal].filter(has).join(' ')) === 'rtl' ? 'rtl' : 'ltr');
      card.style.width = `${w}px`;
      const bbox = this.place(card, { x: cmd.x ?? (W - w) / 2, y: cmd.y, size: cmd.size || 26 }, { color: 'ink' });
      this.register(cmd.id, { nodes: [card], bbox });
    },

    // {"op":"rapid","id":"rapid","n":1,"of":5,"streak":0,"secs":60}; same id updates
    // n/streak and keeps the clock; "done":true,"score":4 shows the score briefly.
    op_rapid(cmd) {
      const s = st(this);
      const id = cmd.id || 'rapid';
      let c = s.rapid;
      if (c && (c.id !== id || (c.done && !cmd.done))) { dropCard(this, 'rapid', true); c = null; }
      const fresh = !c;
      if (fresh) {
        const secs = clamp(Number(cmd.secs) || 60, 5, 900);
        const e = make('div', 'mx-card mx-rapid',
          '<span class="mx-tag">Rapid fire</span><span class="mx-q">Q <b></b><small></small></span>' +
          '<span class="mx-streak"><b></b> in a row</span><span class="mx-timer"><i></i></span><span class="mx-score"></span>');
        e.dir = 'ltr';
        e.querySelector('.mx-timer i').style.animationDuration = `${secs}s`;
        hud(this).appendChild(e);
        slideIn(e, 0);
        c = s.rapid = { id, el: e, secs, start: Date.now(), n: 0, of: 5, streak: 0 };
        c.expire = setTimeout(() => e.classList.add('mx-timeup'), secs * 1000);
      }
      const e = c.el;
      const of = Math.max(1, int(cmd.of, c.of));
      const n = clamp(int(cmd.n, c.n || 1), 0, 999);
      const streak = Math.max(0, int(cmd.streak, c.streak));
      const q = e.querySelector('.mx-q'), sk = e.querySelector('.mx-streak');
      q.querySelector('b').textContent = n;
      q.querySelector('small').textContent = `/${of}`;
      sk.firstElementChild.textContent = streak;
      sk.classList.toggle('mx-zero', streak === 0);
      if (!fresh && n !== c.n) pop(q);
      if (!fresh && streak > c.streak) pop(sk);
      Object.assign(c, { n, of, streak });
      if (cmd.done && !c.done) {
        c.done = true;
        clearTimeout(c.expire);
        freezeClock(c, e.querySelector('.mx-timer i'));
        const score = int(cmd.score, n);
        const sc = e.querySelector('.mx-score');
        sc.innerHTML = `Score <b>${score}</b><small>/${of}</small>`;
        sc.classList.toggle('mx-good', score >= of * 0.8);
        e.classList.add('mx-done');
        pop(sc);
        c.timer = setTimeout(() => { if (st(this).rapid === c) dropCard(this, 'rapid'); }, 6000);
      }
      layoutHud(this);
    },

    // {"op":"pron","id":"pron","lang":"en|ar","score":82,"words":[{"w":"<word>","ok":true,"sounds":[["<ipa>",true],["<ipa>",false]]}]}
    op_pron(cmd) {
      const id = cmd.id || 'pron';
      const prev = this.els.get(id);
      const anchor = prev?.anchor;   // a retry replaces the last result in place
      if (prev) this.remove(id, true);
      const words = [].concat(cmd.words || []).filter((w) => w && has(w.w));
      const rtl = cmd.lang ? /^(ar|fa|ur|he|ps|yi)/i.test(cmd.lang) : textDir(words.map((w) => w.w).join(' ')) === 'rtl';
      const score = has(cmd.score) ? clamp(int(cmd.score), 0, 100) : null;
      const tone = score == null ? '' : score >= 80 ? 'mx-green' : score >= 60 ? 'mx-amber' : 'mx-red';
      const chips = words.map((w) => {
        const sounds = Array.isArray(w.sounds) && w.sounds.length
          ? `<span class="mx-snds" dir="ltr">${w.sounds.map((sd) => {   // IPA always reads left to right
            const [ipa, ok] = Array.isArray(sd) ? sd : [sd?.ipa ?? sd?.p ?? sd, sd?.ok];
            return `<span class="${ok === false ? 'bad' : 'ok'}" dir="ltr">${esc(ipa)}</span>`;
          }).join('')}</span>` : '';
        return `<span class="mx-word ${w.ok === false ? 'bad' : 'ok'}"><span class="mx-w" dir="${rtl ? 'rtl' : 'ltr'}">${esc(w.w)}</span>${sounds}</span>`;
      }).join('');
      const card = make('div', 'mx-card mx-pron',
        (score != null ? `<div class="mx-pron-score ${tone}"><b>${score}</b><small>score</small></div>` : '') +
        `<div class="mx-words" dir="${rtl ? 'rtl' : 'ltr'}">${chips}</div>`);
      card.dir = 'ltr';
      const a = anchor || { x: cmd.x ?? 500, y: cmd.y, align: cmd.x != null ? 'left' : 'center' };
      const bbox = this.place(card, { x: a.x, y: a.y, size: cmd.size || 28, align: a.align }, { free: !!anchor });
      this.register(id, { nodes: [card], bbox, anchor: { x: a.x, y: bbox.y, align: a.align } });
    },

    // {"op":"sessioncard","title":"<course>","minutes":34,"recalled":7,"asked":9,
    //  "ranks":[{"title":"<section>","from":"Bronze","to":"Silver"}],"due":4,"streak":12,"next":"<section>"}
    // The app's end-of-session summary, on a fresh board. Any field may be missing.
    op_sessioncard(cmd) {
      this.op_clear({ title: has(cmd.title) ? cmd.title : 'Session complete' });
      const tiles = [];
      if (has(cmd.minutes)) tiles.push(['mx-ink', int(cmd.minutes), int(cmd.minutes) === 1 ? 'minute' : 'minutes']);
      if (has(cmd.recalled) && has(cmd.asked)) tiles.push(['mx-green', `${int(cmd.recalled)}<small>/${int(cmd.asked)}</small>`, 'recalled']);
      else if (has(cmd.recalled)) tiles.push(['mx-green', int(cmd.recalled), 'recalled']);
      else if (has(cmd.asked)) tiles.push(['mx-green', int(cmd.asked), 'asked']);
      if (has(cmd.due)) tiles.push(['mx-amber', int(cmd.due), 'due tomorrow']);
      if (has(cmd.streak)) tiles.push(['mx-purple', int(cmd.streak), 'day streak']);
      const rank = (name) => {
        const key = String(name ?? '').trim().toLowerCase();
        return `<span class="mx-rank mx-rank-${RANKS.includes(key) ? key : 'new'}">${esc(name)}</span>`;
      };
      const ranks = [].concat(cmd.ranks || []).filter((r) => r && has(r.to)).slice(0, 4);
      const extra = [].concat(cmd.ranks || []).filter((r) => r && has(r.to)).length - ranks.length;
      const html =
        (has(cmd.title) ? '<div class="mx-tag mx-ses-tag">Session complete</div>' : '') +
        (tiles.length ? `<div class="mx-tiles">${tiles.map(([c, v, k]) => `<div class="mx-tile ${c}"><b>${v}</b><span>${k}</span></div>`).join('')}</div>` : '') +
        (ranks.length ? `<div class="mx-ranks">${ranks.map((r) =>
          `<span class="mx-rank-t" data-bidi>${esc(r.title)}</span>` +
          (has(r.from) ? `${rank(r.from)}<span class="mx-arrow">→</span>` : '<span></span><span></span>') +
          rank(r.to)).join('')}${extra > 0 ? `<span class="mx-rank-more">+${extra} more</span>` : ''}</div>` : '') +
        (has(cmd.next) ? `<div class="mx-next"><span class="mx-k">Next</span><span class="mx-v" data-bidi>${esc(cmd.next)}</span></div>` : '');
      if (!tiles.length && !ranks.length && !has(cmd.next)) return;
      const card = make('div', 'mx-card mx-session', html);
      frameDir(card, 'ltr');
      card.style.width = '860px';
      const bbox = this.place(card, { x: 70, y: this.top + 6, size: 26 }, { color: 'ink' });
      this.register(cmd.id || 'session', { nodes: [card], bbox });
    },
  });
})();
