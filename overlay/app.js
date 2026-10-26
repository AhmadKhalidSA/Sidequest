// Panel wiring: engine events -> board / captions / status; buttons -> engine.
// Runs in the Electron overlay (window.sq bridge) or, with ?mirror=1, as a
// view-only page on a phone/tablet fed by server-sent events.

const $ = (id) => document.getElementById(id);
const mirror = new URLSearchParams(location.search).has('mirror');

const bridge = window.sq || {
  onEngine(cb) { new EventSource('/events').onmessage = (m) => cb(JSON.parse(m.data)); },
  onUi() {},
  send(cmd) { fetch('/cmd', { method: 'POST', body: JSON.stringify(cmd) }).catch(() => {}); },
  ui() {},
  pathForFile() { return null; },
};
if (mirror) document.body.classList.add('mirror');

const board = new Board($('board'), (title) => { $('boardTitle').textContent = title || ''; });
let keys = { mute: 'Mouse 5', interact: 'F8', hide: 'F9' };
let earsOn = true;
let plan = null;
let progress = null;
let outline = '';
let interactive = false;
let state = 'loading';
let captionTimer = null, noticeTimer = null, quizTimer = null;

// ------------------------------------------------------------------ layout
// Fit the 1000x600 board inside the stage, centred. In the docked panel the
// stage is exactly 5:3; in full screen it can be any shape.
function fit() {
  const st = $('stage');
  const s = Math.min(st.clientWidth / 1000, st.clientHeight / 600);
  const dx = (st.clientWidth - 1000 * s) / 2, dy = (st.clientHeight - 600 * s) / 2;
  $('board').style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
}
new ResizeObserver(fit).observe($('stage'));

// Buttons stay clickable while the rest of the panel is click-through: tell
// the main process where the visible .hot elements are; it watches the cursor.
function reportHot() {
  const rects = [...document.querySelectorAll('.hot')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.getBoundingClientRect())
    .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
  bridge.ui({ hotRects: rects });
}
new ResizeObserver(reportHot).observe(document.body);
setInterval(reportHot, 1000);

// ------------------------------------------------------------------ status
const STATUS = {
  loading: (d) => d || 'Loading...',
  idle: (d) => d || (earsOn ? 'Listening · just talk' : 'Mic off · click Mic or press ' + keys.mute),
  listening: (d) => d || 'Hearing you...',
  transcribing: () => 'Understanding...',
  thinking: (d) => d || 'Thinking...',
  speaking: () => 'Speaking · just talk to cut in',
  paused: (d) => d || 'Paused · say "continue"',
};

function setStatus(s, detail) {
  state = s;
  $('dot').className = `dot ${s}`;
  $('status').textContent = (STATUS[s] || (() => s))(detail);
  document.body.classList.toggle('listening', s === 'listening');
  if (s !== 'speaking') fadeCaption();
}

function fadeCaption() {
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => $('caption').classList.add('faded'), 2500);
}

// Notices go in the small line above the caption, never over the board.
function notice(text, kind = 'notice', ms = 5000) {
  const el = $('heard');
  el.textContent = text;
  el.className = kind;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, ms);
}

// --------------------------------------------------------- plan / progress
function renderProgress() {
  const total = plan?.sections?.length || 0;
  const idx = progress?.section || 0;
  if (total && idx) {
    const title = plan.sections[idx - 1]?.title || '';
    $('section').textContent = `${idx}/${total} · ${title}`;
    $('pbar').firstElementChild.style.width = `${(Math.max(0, idx - 1) / total) * 100}%`;
  } else if (total) {
    $('section').textContent = `${total} sections`;
    $('pbar').firstElementChild.style.width = '0';
  } else {
    $('section').textContent = '';
  }
  const asked = progress?.asked || 0;
  $('score').textContent = asked ? `${progress.correct || 0}/${asked}` : '';
  if (!$('index').hidden) renderIndex();
}

function renderIndex() {
  const list = $('ixList');
  list.innerHTML = '';
  if (!plan?.sections?.length) {
    $('ixTitle').textContent = 'No plan yet';
    $('ixBig').textContent = 'Say "let\'s start" (or press Start in F8) and the planner will build the course. ' +
      'To plan from your course\'s headers, open Course outline and paste them in.';
    return;
  }
  $('ixTitle').textContent = plan.title || 'Course index';
  $('ixBig').textContent = plan.bigPicture || '';
  const cur = progress?.section || 0;
  const done = new Set(progress?.done || []);
  plan.sections.forEach((s, i) => {
    const n = i + 1;
    const li = document.createElement('li');
    if (done.has(n) || (cur && n < cur)) li.classList.add('done');
    if (n === cur) li.classList.add('current');
    const mark = li.classList.contains('done') ? '✓' : n === cur ? '▶' : `${n}`;
    const steps = (s.steps || []).map(escapeHtml).join(' · ');
    li.innerHTML = `<span class="num">${mark}</span><span class="t">${escapeHtml(s.title || '')}</span>` +
      (s.goal ? `<span class="g">${escapeHtml(s.goal)}</span>` : '') +
      (steps ? `<span class="steps">${steps}</span>` : '');
    li.title = 'Jump to this section';
    li.addEventListener('click', () => {
      bridge.send({ cmd: 'goto', index: n });
      toggleIndex(false);
    });
    list.appendChild(li);
  });
  list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
}

function toggleIndex(show = $('index').hidden) {
  $('index').hidden = !show;
  if (show) renderIndex();
  reportHot();
}

function openOutline() {
  $('index').hidden = true;
  $('outlineText').value = outline;
  $('outlineBox').hidden = false;
  bridge.ui({ interactive: true });   // typing needs keyboard focus
  setTimeout(() => $('outlineText').focus(), 80);
}

// --------------------------------------------------------------- settings
// Each row edits one config.json path. "panel" rows are window settings and
// apply instantly; the rest go to the engine on Save (most apply live).
const SETTINGS = [
  ['Lesson', [
    { path: 'lesson.autoContinue', label: 'Talk mode', type: 'select',
      options: [[true, 'Lecture: keeps teaching while you\'re quiet'], [false, 'Wait: answers, then waits for you']] },
    { path: 'lesson.autoContinueSeconds', label: 'Quiet seconds before it continues', type: 'number', min: 1, max: 30, step: 1, help: 'Lecture mode only' },
    { path: 'lesson.maxAutoChunks', label: 'Stop after this many chunks without hearing you', type: 'number', min: 0, max: 99, step: 1, help: '0 = never stop (until you talk)' },
  ]],
  ['Voice', [
    { path: 'tts.voice', label: 'Voice', type: 'select', options: 'voices', help: 'af_ / bf_ = female, am_ / bm_ = male (b = British)' },
    { path: 'tts.speed', label: 'Speaking speed', type: 'range', min: 0.7, max: 1.6, step: 0.05 },
  ]],
  ['Listening', [
    { path: 'audio.endSilenceMs', label: 'Pause that ends your sentence (ms)', type: 'number', min: 300, max: 3000, step: 50, help: 'Raise it if it cuts you off mid-thought' },
    { path: 'keys.mute', label: 'Mic mute key', type: 'text', help: 'e.g. MOUSE5, MOUSE4, F7, INSERT' },
    { path: 'keys.interact', label: 'Controls key', type: 'text' },
    { path: 'keys.hide', label: 'Hide / show key', type: 'text' },
    { path: 'keys.big', label: 'Full screen key', type: 'text' },
    { path: 'keys.mode', label: 'Lecture / Wait key', type: 'text' },
  ]],
  ['Brains', [
    { path: 'brain.model', label: 'Tutor model', type: 'select', options: [['sonnet', 'Sonnet (fast, recommended)'], ['haiku', 'Haiku'], ['opus', 'Opus (smartest, slower)']] },
    { path: 'brain.thinking', label: 'Tutor thinks before answering', type: 'select', options: [[false, 'Off (faster replies)'], [true, 'On (deeper, slower)']] },
    { path: 'brain.plannerModel', label: 'Course planner model', type: 'select', options: [['opus', 'Opus (best plans)'], ['sonnet', 'Sonnet (faster)']] },
    { path: 'brain.directorModel', label: 'Illustrator model', type: 'select', help: 'Builds the rich animated scenes in the background',
      options: [['sonnet', 'Sonnet (balanced)'], ['opus', 'Opus (richest, slower)'], ['haiku', 'Haiku (fastest)']] },
    { path: 'stt.model', label: 'Speech recognition model', type: 'select', help: 'Needs an engine restart',
      options: [['distil-large-v3', 'distil-large-v3 (accurate)'], ['small.en', 'small.en (light)'], ['base.en', 'base.en (lightest)'], ['large-v3', 'large-v3 (multilingual)']] },
    { path: 'stt.device', label: 'Speech recognition runs on', type: 'select', help: 'Needs an engine restart',
      options: [['auto', 'GPU if available'], ['cpu', 'CPU (leave the GPU to the game)']] },
  ]],
  ['Panel', [
    { panel: 'size', label: 'Size', type: 'select', options: [['S', 'Small'], ['M', 'Medium'], ['L', 'Large'], ['XL', 'Extra large']] },
    { panel: 'corner', label: 'Dock position', type: 'select', help: 'Where the panel sits on screen',
      options: [['tr', 'Top right'], ['tc', 'Top centre'], ['tl', 'Top left'], ['mr', 'Right edge, middle'], ['ml', 'Left edge, middle'],
        ['br', 'Bottom right'], ['bc', 'Bottom centre'], ['bl', 'Bottom left']] },
    { action: 'dock', label: 'Dock now', type: 'button', text: 'Dock', help: 'Snap back to the dock position (after dragging or full screen)' },
    { panel: 'opacity', label: 'Background opacity', type: 'range', min: 0.35, max: 1, step: 0.01 },
    { path: 'mirror.enabled', label: 'Phone / tablet mirror', type: 'select', options: [[false, 'Off'], [true, 'On (needs app restart)']] },
  ]],
];
let settingsData = null;
let uiState = {};
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

function openSettings() {
  $('index').hidden = true;
  $('settings').hidden = false;
  $('stNote').textContent = '';
  bridge.ui({ interactive: true });    // inputs need keyboard focus
  bridge.send({ cmd: 'get_settings' });
}

function closeSettings() {
  $('settings').hidden = true;
  bridge.ui({ interactive: false });
}

function renderSettings() {
  const body = $('stBody');
  body.innerHTML = '';
  for (const [group, rows] of SETTINGS) {
    const g = document.createElement('div');
    g.className = 'st-group';
    g.textContent = group;
    body.appendChild(g);
    for (const row of rows) {
      const value = row.panel ? uiState[row.panel] : row.path ? getPath(settingsData.cfg, row.path) : null;
      const wrap = document.createElement('div');
      wrap.className = 'st-row';
      const label = document.createElement('label');
      label.innerHTML = escapeHtml(row.label) + (row.help ? `<span class="help">${escapeHtml(row.help)}</span>` : '');
      let input;
      if (row.type === 'button') {
        input = document.createElement('button');
        input.textContent = row.text;
        input.addEventListener('click', () => bridge.ui({ corner: uiState.corner || 'tr' }));
      } else if (row.type === 'select') {
        input = document.createElement('select');
        const opts = row.options === 'voices' ? settingsData.voices.map((v) => [v, v]) : row.options;
        for (const [v, text] of opts) {
          const o = document.createElement('option');
          o.value = JSON.stringify(v);
          o.textContent = text;
          if (JSON.stringify(v) === JSON.stringify(value)) o.selected = true;
          input.appendChild(o);
        }
      } else {
        input = document.createElement('input');
        input.type = row.type;
        for (const k of ['min', 'max', 'step']) if (row[k] != null) input[k] = row[k];
        input.value = value ?? '';
      }
      input.dataset.path = row.path || '';
      input.dataset.panel = row.panel || '';
      input.dataset.type = row.type;
      const cell = document.createElement('div');
      cell.appendChild(input);
      if (row.type === 'range') {
        const rv = document.createElement('span');
        rv.className = 'rv';
        rv.textContent = ` ${input.value}`;
        input.addEventListener('input', () => { rv.textContent = ` ${input.value}`; });
        cell.appendChild(rv);
      }
      if (row.panel) {
        // Window settings apply as you change them.
        input.addEventListener('change', () => {
          const v = row.type === 'select' ? JSON.parse(input.value) : parseFloat(input.value);
          bridge.ui({ [row.panel]: v });
        });
      }
      wrap.append(label, cell);
      body.appendChild(wrap);
    }
  }
}

function saveSettings() {
  const patch = {};
  for (const input of $('stBody').querySelectorAll('[data-path]')) {
    const path = input.dataset.path;
    if (!path) continue;
    let v;
    if (input.dataset.type === 'select') v = JSON.parse(input.value);
    else if (input.dataset.type === 'number' || input.dataset.type === 'range') v = parseFloat(input.value);
    else v = input.value.trim().toUpperCase();
    if (JSON.stringify(v) === JSON.stringify(getPath(settingsData.cfg, path))) continue;
    const keys = path.split('.');
    let o = patch;
    keys.slice(0, -1).forEach((k) => { o = o[k] = o[k] || {}; });
    o[keys[keys.length - 1]] = v;
  }
  if (!Object.keys(patch).length) { closeSettings(); return; }
  bridge.send({ cmd: 'save_settings', patch });
  $('stNote').textContent = 'Saving...';
}

// ------------------------------------------------------------------- quiz
function showQuiz(cmd) {
  clearTimeout(quizTimer);
  const q = $('quiz');
  q.className = '';
  q.querySelector('.q-head').firstChild.textContent = 'Checkpoint ';
  $('qText').innerHTML = richText(cmd.q || '');
  $('qChoices').innerHTML = (cmd.choices || [])
    .map((c, i) => `<span><b>${String.fromCharCode(65 + i)}</b>${richText(c)}</span>`).join('');
  $('qNote').textContent = '';
  q.hidden = false;
}

function showResult(cmd) {
  const q = $('quiz');
  q.hidden = false;
  q.className = cmd.correct ? 'correct' : 'wrong';
  q.querySelector('.q-head').firstChild.textContent = cmd.correct ? 'Correct ' : 'Not quite ';
  $('qNote').innerHTML = richText(cmd.note || '');
  clearTimeout(quizTimer);
  quizTimer = setTimeout(() => { q.hidden = true; }, 4000);
}

// ----------------------------------------------------------------- events
function onEngine(ev) {
  switch (ev.ev) {
    case 'ready':
      keys = ev.keys || keys;
      $('drawerHint').textContent =
        `Just talk, any time · say "pause" / "continue" · ${keys.mute} or the Mic button: mute mic · ${keys.interact}: close controls · ${keys.hide}: hide/show · ` +
        `Brain: Claude ${ev.model} · Ears: ${ev.stt} · Voice: ${ev.tts}`;
      break;
    case 'status':
      setStatus(ev.state, ev.detail);
      break;
    case 'ears':
      earsOn = !!ev.on;
      $('micBtn').className = `hot hbtn ${earsOn ? 'on' : 'off'}`;
      $('micBtn').textContent = earsOn ? 'Mic on' : 'Mic off';
      $('muteBtn').classList.toggle('on', !earsOn);
      $('muteBtn').textContent = earsOn ? 'Mute mic' : 'Unmute mic';
      if (state === 'idle') setStatus('idle');
      break;
    case 'mode':
      $('modeBtn').textContent = ev.auto ? 'Lecture' : 'Wait';
      $('modeBtn').classList.toggle('wait', !ev.auto);
      $('modeBtn').dataset.auto = ev.auto ? '1' : '';
      break;
    case 'settings':
      settingsData = ev;
      if (!$('settings').hidden) renderSettings();
      break;
    case 'settings_saved':
      if (ev.restart) {
        $('stNote').textContent = 'Saved. Press Restart engine to apply speech-recognition changes.';
      } else {
        closeSettings();
      }
      break;
    case 'planning':
      $('planning').hidden = !ev.on;
      $('planning').textContent = ev.detail || 'Planning...';
      $('planning').title = 'A separate, slower Claude is thinking about the big picture and designing the course';
      break;
    case 'level':
      $('meter').firstElementChild.style.width = `${Math.round(ev.v * 100)}%`;
      break;
    case 'heard':
      if (ev.text) notice(`You: ${ev.text}`, '', 6000);
      if (ev.turn && ev.text) board.veil(ev.text);
      break;
    case 'say':
      board.unveil();
      clearTimeout(captionTimer);
      $('caption').classList.remove('faded');
      $('caption').textContent = ev.text;
      break;
    case 'interrupted':
      $('caption').classList.add('faded');
      break;
    case 'board': {
      const cmd = ev.cmd || {};
      if (cmd.op === 'quiz') showQuiz(cmd);
      else if (cmd.op === 'result') showResult(cmd);
      else if (cmd.op === 'section') {
        progress = { ...(progress || {}), section: cmd.index };
        $('quiz').hidden = true;
        renderProgress();
      } else {
        if (cmd.op === 'clear') $('quiz').hidden = true;
        board.apply(cmd);
      }
      break;
    }
    case 'plan':
      plan = ev.plan;
      progress = ev.progress;
      renderProgress();
      break;
    case 'progress':
      progress = ev.progress;
      renderProgress();
      break;
    case 'outline':
      outline = ev.text || '';
      break;
    case 'courses': {
      const sel = $('course');
      sel.innerHTML = (ev.list.length ? '' : '<option value="">(no courses yet)</option>') +
        ev.list.map((c) => `<option ${c === ev.current ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
      if (!ev.current) {
        $('caption').textContent = ev.list.length
          ? `Press ${keys.interact} and pick a course to start.`
          : `Press ${keys.interact}, create a course, and drop your notes onto this panel.`;
      }
      break;
    }
    case 'toast':
      notice(ev.text);
      break;
    case 'error':
      notice(ev.text, 'error', 9000);
      break;
  }
}

function onUi(msg) {
  interactive = !!msg.interactive;
  uiState = msg;
  document.body.classList.toggle('interactive', interactive);
  document.body.classList.toggle('full', !!msg.big);
  $('drawer').hidden = !interactive || !$('outlineBox').hidden || !$('settings').hidden;
  if (!interactive) { $('newCourse').hidden = true; $('outlineBox').hidden = true; $('settings').hidden = true; }
  $('bigBtn').classList.toggle('on', !!msg.big);
  $('bigBtn').title = msg.big ? 'Exit full screen (F10)' : 'Full screen (F10)';
  setTimeout(reportHot, 50);
  if (typeof msg.opacity === 'number') {
    document.documentElement.style.setProperty('--alpha', msg.opacity);
    $('opacity').value = msg.opacity;
  }
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('on', b.dataset.size === msg.size));
  document.querySelectorAll('[data-corner]').forEach((b) => b.classList.toggle('on', b.dataset.corner === msg.corner));
  if (interactive && msg.mirror && !$('drawerHint').textContent.includes('Phone')) {
    $('drawerHint').textContent += ` · Phone view: ${msg.mirror}`;
  }
  if (interactive && $('outlineBox').hidden && $('settings').hidden) setTimeout(() => $('ask').focus(), 50);
}

bridge.onEngine(onEngine);
bridge.onUi(onUi);
bridge.ui({ hello: true });

// -------------------------------------------------------------- controls
$('micBtn').addEventListener('click', () => bridge.send({ cmd: 'mute' }));
$('screenBtn').addEventListener('click', () => bridge.send({ cmd: 'button', name: 'screen' }));
$('modeBtn').addEventListener('click', () => bridge.send({ cmd: 'mode', auto: !$('modeBtn').dataset.auto }));
$('dockBtn').addEventListener('click', () => bridge.ui({ dock: true }));
$('bigBtn').addEventListener('click', () => bridge.ui({ big: !uiState.big }));
$('gearBtn').addEventListener('click', () => ($('settings').hidden ? openSettings() : closeSettings()));
$('stClose').addEventListener('click', closeSettings);
$('stSave').addEventListener('click', saveSettings);
$('stRestart').addEventListener('click', () => { bridge.ui({ restartEngine: true }); $('stNote').textContent = 'Restarting the engine (about 15 s)...'; });
$('muteBtn').addEventListener('click', () => bridge.send({ cmd: 'mute' }));
$('indexBtn').addEventListener('click', () => toggleIndex());
$('ixClose').addEventListener('click', () => toggleIndex(false));
$('drawerIndex').addEventListener('click', () => toggleIndex(true));
$('ixOutline').addEventListener('click', openOutline);
$('drawerOutline').addEventListener('click', openOutline);
$('ixReplan').addEventListener('click', () => { bridge.send({ cmd: 'replan' }); toggleIndex(false); });
$('outlineSave').addEventListener('click', () => {
  bridge.send({ cmd: 'outline', text: $('outlineText').value });
  $('outlineBox').hidden = true;
  bridge.ui({ interactive: false });
});
$('outlineCancel').addEventListener('click', () => {
  $('outlineBox').hidden = true;
  bridge.ui({ interactive: false });
});

document.querySelectorAll('[data-btn]').forEach((b) => {
  b.addEventListener('click', () => bridge.send({ cmd: 'button', name: b.dataset.btn }));
});
$('course').addEventListener('change', (e) => bridge.send({ cmd: 'course', name: e.target.value }));
$('newCourseBtn').addEventListener('click', () => { $('newCourse').hidden = false; $('newCourseName').focus(); });
function createCourse() {
  const name = $('newCourseName').value.trim();
  if (!name) return;
  bridge.send({ cmd: 'new_course', name });
  $('newCourseName').value = '';
  $('newCourse').hidden = true;
}
$('newCourseOk').addEventListener('click', createCourse);
$('newCourseName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createCourse(); });
$('ask').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    bridge.send({ cmd: 'text', text: e.target.value.trim() });
    e.target.value = '';
  }
});
$('opacity').addEventListener('input', (e) => {
  document.documentElement.style.setProperty('--alpha', e.target.value);
});
$('opacity').addEventListener('change', (e) => bridge.ui({ opacity: parseFloat(e.target.value) }));
document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => bridge.ui({ size: b.dataset.size })));
document.querySelectorAll('[data-corner]').forEach((b) => b.addEventListener('click', () => bridge.ui({ corner: b.dataset.corner })));
$('hideBtn').addEventListener('click', () => bridge.ui({ hide: true }));
$('quitBtn').addEventListener('click', () => bridge.ui({ quit: true }));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('settings').hidden) closeSettings();
  else if (!$('outlineBox').hidden) { $('outlineBox').hidden = true; bridge.ui({ interactive: false }); }
  else if (interactive) bridge.ui({ interactive: false });
});

// Drag-and-drop materials onto the panel (interact mode).
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropzone').hidden = false; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => bridge.pathForFile(f)).filter(Boolean);
  if (paths.length) bridge.send({ cmd: 'add_files', paths });
});

fit();
