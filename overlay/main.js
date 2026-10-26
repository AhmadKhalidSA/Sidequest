// Sidequest overlay: a transparent, click-through, always-on-top panel that
// sits over a borderless-windowed game. It spawns the Python engine and
// relays JSON lines both ways. It never touches the game process (no
// injection, no hooks, no memory reads), so it's just another window on the
// desktop, like Discord's or OBS's.

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');
const STATE_FILE = path.join(LOGS, 'overlay-state.json');
fs.mkdirSync(LOGS, { recursive: true });

// Dev: `--capture=DIR` renders offscreen (never appears on screen) and saves
// a PNG of the panel every 3 s, for testing the board without a display.
const captureArg = process.argv.find((a) => a.startsWith('--capture='));
const CAPTURE_DIR = captureArg ? captureArg.slice('--capture='.length) : null;

// The panel is designed at 640x478 CSS px (header 36 + board 384 + captions
// 58). Every size is that design zoomed, so S/M/L/XL/big all look the same.
const BASE_W = 640, BASE_H = 478;
const SIZES = { S: 480, M: 640, L: 820, XL: 1040 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
const cfg = readJson(path.join(ROOT, 'config.json'), {});
let state = Object.assign({ size: 'L', corner: 'tr', opacity: 0.82, hidden: false, big: false }, readJson(STATE_FILE, {}));
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

let win = null;
let tray = null;
let engine = null;
let interactive = false;
let quitting = false;
let restarting = false;

// Replay buffer: a reloaded renderer (or a phone joining the mirror
// mid-lesson) gets the current status, plan, and the board since its last clear.
const latest = {};
let boardLog = [];
const sseClients = new Set();

function broadcast(ev) {
  if (ev.ev === 'board') {
    if (ev.cmd && ev.cmd.op === 'clear') boardLog = [];
    boardLog.push(ev);
  } else if (['ready', 'status', 'courses', 'plan', 'progress'].includes(ev.ev)) {
    latest[ev.ev] = ev;
  }
  if (win && !win.isDestroyed()) win.webContents.send('engine', ev);
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function replayTo(send) {
  for (const key of ['ready', 'courses', 'plan', 'progress', 'status']) if (latest[key]) send(latest[key]);
  for (const ev of boardLog) send(ev);
}

// ------------------------------------------------------------------ window
function boundsFor() {
  const area = screen.getPrimaryDisplay().workArea;
  if (state.big) {
    // Full screen: the whole display, edge to edge (over the taskbar too).
    const full = (win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay()).bounds;
    return { x: full.x, y: full.y, width: full.width, height: full.height };
  }
  const w = SIZES[state.size] || SIZES.L;
  const h = Math.round(w * BASE_H / BASE_W);
  if (state.x != null && state.y != null) return { x: state.x, y: state.y, width: w, height: h };
  // Dock positions: corners (tl tr bl br), edge centres (tc bc ml mr).
  const m = 16;
  const c = state.corner || 'tr';
  const x = c === 'tc' || c === 'bc' ? area.x + Math.round((area.width - w) / 2)
    : c.endsWith('l') ? area.x + m : area.x + area.width - w - m;
  const y = c === 'ml' || c === 'mr' ? area.y + Math.round((area.height - h) / 2)
    : c.startsWith('t') ? area.y + m : area.y + area.height - h - m;
  return { x, y, width: w, height: h };
}

function createWindow() {
  win = new BrowserWindow({
    ...boundsFor(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: !!CAPTURE_DIR,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('did-finish-load', applyZoom);
  if (CAPTURE_DIR) {
    // SIDEQUEST_EVAL="ms:js" runs page JS at that time (e.g. open the index).
    const [at, ...code] = (process.env.SIDEQUEST_EVAL || '').split(':');
    if (code.length) setTimeout(() => win.webContents.executeJavaScript(code.join(':')), Number(at));
    let n = 0;
    setInterval(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(CAPTURE_DIR, `cap${String(n++).padStart(2, '0')}.png`), img.toPNG());
    }, 3000);
    return;
  }
  win.once('ready-to-show', () => { if (!state.hidden) win.showInactive(); });
  win.on('moved', () => {
    if (!interactive || state.big) return;
    const b = win.getBounds();
    state.x = b.x; state.y = b.y; saveState();
  });
  // Some games re-assert z-order on focus changes; keep the panel on top.
  setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver'); }, 5000);
  setInterval(pollHot, 40);
}

// The page is laid out at BASE_W x BASE_H and zoomed to the window. Full
// screen zooms to the screen's height and the panel stretches sideways.
function zoomFor(b) {
  return state.big ? Math.min(b.width / BASE_W, b.height / BASE_H) : b.width / BASE_W;
}

function applyZoom() {
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoomFor(win.getBounds()));
}

// Clickable buttons on a click-through panel: the page reports where its
// buttons are; while the cursor is over one, the window takes mouse input,
// everywhere else clicks fall through to the game. (Polling the cursor is
// more reliable on Windows than Electron's forwarded mouse events.) In-game
// the cursor is locked away from the panel, so this never triggers.
let hotRects = [];
let hotNow = false;
function pollHot() {
  if (!win || win.isDestroyed() || interactive || !win.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const z = zoomFor(b);
  const inside = hotRects.some((r) => p.x >= b.x + r.x * z && p.x <= b.x + (r.x + r.w) * z &&
    p.y >= b.y + r.y * z && p.y <= b.y + (r.y + r.h) * z);
  if (inside === hotNow) return;
  hotNow = inside;
  // Clickable needs both: mouse input, and permission to be activated by
  // the click (a non-focusable window can swallow it on Windows).
  win.setFocusable(inside);
  if (inside) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}

function sendUi() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('ui', { interactive, opacity: state.opacity, size: state.size, corner: state.corner, big: state.big, mirror: mirrorUrl });
}

function setInteractive(on) {
  interactive = on;
  hotNow = false;
  if (on && !win.isVisible()) { state.hidden = false; win.showInactive(); }
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
  win.setFocusable(on);
  if (on) {
    // Windows refuses focus to a background app (the game keeps it, and
    // the mouse); the engine takes it the sanctioned way, then we focus.
    sendToEngine({ cmd: 'focus_panel' });
    win.focus();
  } else {
    win.blur();
    sendToEngine({ cmd: 'restore_focus' });   // straight back to the game
  }
  sendUi();
}

function dock() {
  state.big = false;
  delete state.x; delete state.y;
  saveState();
  if (!win.isVisible()) { state.hidden = false; win.showInactive(); }
  relayout();
}

function toggleBig() {
  state.big = !state.big;
  saveState();
  if (!win.isVisible()) { state.hidden = false; win.showInactive(); }
  relayout();
}

function toggleHidden() {
  state.hidden = !state.hidden;
  saveState();
  if (state.hidden) { if (interactive) setInteractive(false); win.hide(); } else win.showInactive();
}

function relayout() {
  win.setBounds(boundsFor());
  applyZoom();
  sendUi();
}

// ------------------------------------------------------------------ engine
function sendToEngine(obj) {
  if (engine && engine.stdin.writable) engine.stdin.write(JSON.stringify(obj) + '\n');
}

function startEngine() {
  // config.json "python" if set, else the repo's own .venv (made by
  // setup.ps1), else whatever "python" is on PATH.
  const venvPy = path.join(ROOT, '.venv', 'Scripts', 'python.exe');
  const py = cfg.python || (fs.existsSync(venvPy) ? venvPy : 'python');
  if (cfg.python && !fs.existsSync(py)) {
    broadcast({ ev: 'error', text: `Python not found at ${py}. Fix "python" in config.json.` });
    return;
  }
  const logFile = fs.createWriteStream(path.join(LOGS, 'engine.log'), { flags: 'a' });
  logFile.write(`\n===== ${new Date().toISOString()} engine start =====\n`);
  engine = spawn(py, ['-u', path.join(ROOT, 'engine', 'main.py')], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  readline.createInterface({ input: engine.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { logFile.write(`[stdout] ${line}\n`); return; }
    if (ev.ev === 'key') {
      if (ev.name === 'interact') setInteractive(!interactive);
      else if (ev.name === 'hide') toggleHidden();
      else if (ev.name === 'big') toggleBig();
      else if (ev.name === 'dock') dock();
      else if (ev.name === 'full' && !state.big) toggleBig();
      return;
    }
    if (ev.ev === 'capture') {
      // Hide the panel while the engine screenshots the screen behind it.
      if (ev.on) win.hide();
      else if (!state.hidden) win.showInactive();
      return;
    }
    if (ev.ev === 'board' && ev.cmd && ev.cmd.op === 'clear') {
      // Keep a picture of every finished board in logs/boards (last 300).
      snapshotBoard().finally(() => broadcast(ev));
      return;
    }
    broadcast(ev);
  });
  engine.stderr.pipe(logFile);
  engine.on('exit', (code) => {
    engine = null;
    if (!quitting && !restarting) broadcast({ ev: 'error', text: `Engine stopped (exit ${code}). See logs/engine.log.` });
  });
}

// `npm run demo`: replay a scripted lesson instead of running the engine.
// Lines are engine events; "_delay" is milliseconds to wait before each one.
async function replay(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  for (;;) {
    for (const line of lines) {
      const ev = JSON.parse(line);
      await sleep(ev._delay ?? 0);
      delete ev._delay;
      broadcast(ev);
    }
    await sleep(4000);
  }
}

let lastSnapshot = 0;
async function snapshotBoard() {
  if (!win || win.isDestroyed() || !win.isVisible() || Date.now() - lastSnapshot < 4000) return;
  lastSnapshot = Date.now();
  try {
    const dir = path.join(LOGS, 'boards');
    fs.mkdirSync(dir, { recursive: true });
    const img = await win.webContents.capturePage();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(dir, `${stamp}.png`), img.toPNG());
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 300))) fs.unlinkSync(path.join(dir, f));
  } catch (e) { console.warn('board snapshot failed', e); }
}

function stopEngine() {
  if (!engine) return;
  const pid = engine.pid;
  try { engine.stdin.end(); } catch {}
  // /T takes down the Claude Code CLI child too.
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
}

// ------------------------------------------------------------------ mirror
// Optional: serve the same board to a phone/tablet/second monitor on the LAN.
let mirrorUrl = null;
function startMirror() {
  const m = cfg.mirror || {};
  if (!m.enabled) return;
  const port = m.port || 5199;
  const allowed = [
    ['/overlay/', path.join(ROOT, 'overlay')],
    ['/node_modules/katex/dist/', path.join(ROOT, 'node_modules', 'katex', 'dist')],
    ['/node_modules/roughjs/bundled/', path.join(ROOT, 'node_modules', 'roughjs', 'bundled')],
    ['/node_modules/gsap/dist/', path.join(ROOT, 'node_modules', 'gsap', 'dist')],
    ['/node_modules/mermaid/dist/', path.join(ROOT, 'node_modules', 'mermaid', 'dist')],
    ['/cache/', path.join(ROOT, 'cache')],
  ];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') { res.writeHead(302, { Location: '/overlay/index.html?mirror=1' }); return res.end(); }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      replayTo((ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`));
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (url.pathname === '/cmd' && req.method === 'POST') {
      if (!m.allowControl) { res.writeHead(403); return res.end(); }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => { try { sendToEngine(JSON.parse(body)); } catch {} res.writeHead(204); res.end(); });
      return;
    }
    for (const [prefix, dir] of allowed) {
      if (!url.pathname.startsWith(prefix)) continue;
      const file = path.normalize(path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length))));
      if (!file.startsWith(dir)) break;
      return fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, '0.0.0.0', () => {
    const ip = Object.values(os.networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    mirrorUrl = `http://${ip ? ip.address : 'localhost'}:${port}`;
    sendUi();
  });
}

// -------------------------------------------------------------------- tray
function trayIcon() {
  const size = 16, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5), i = (y * size + x) * 4;
    if (d < 7) { buf[i] = 0xff; buf[i + 1] = 0x8f; buf[i + 2] = 0xa6; buf[i + 3] = 0xff; } // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Sidequest');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Controls (F8)', click: () => setInteractive(!interactive) },
    { label: 'Show / hide (F9)', click: toggleHidden },
    { type: 'separator' },
    { label: 'Open courses folder', click: () => shell.openPath(path.join(ROOT, 'courses')) },
    { label: 'Open engine log', click: () => shell.openPath(path.join(LOGS, 'engine.log')) },
    { label: 'Settings (config.json)', click: () => shell.openPath(path.join(ROOT, 'config.json')) },
    { type: 'separator' },
    { label: 'Quit Sidequest', click: () => app.quit() },
  ]));
  tray.on('click', () => setInteractive(!interactive));
}

// --------------------------------------------------------------------- ipc
ipcMain.on('cmd', (_e, obj) => sendToEngine(obj));
ipcMain.on('ui', (_e, msg) => {
  if (msg.hello) { replayTo((ev) => win.webContents.send('engine', ev)); sendUi(); }
  if (msg.interactive === false) setInteractive(false);
  if (msg.interactive === true && !interactive) setInteractive(true);
  if (Array.isArray(msg.hotRects)) hotRects = msg.hotRects;
  if (msg.dock) dock();
  if (typeof msg.big === 'boolean' && msg.big !== state.big) toggleBig();
  if (msg.restartEngine) {
    restarting = true;
    stopEngine();
    setTimeout(() => { restarting = false; startEngine(); }, 1500);
  }
  if (msg.size && SIZES[msg.size]) { state.size = msg.size; state.big = false; saveState(); relayout(); }
  if (msg.corner) { state.corner = msg.corner; state.big = false; delete state.x; delete state.y; saveState(); relayout(); }
  if (typeof msg.opacity === 'number') { state.opacity = msg.opacity; saveState(); sendUi(); }
  if (msg.hide) toggleHidden();
  if (msg.quit) app.quit();
});

// --------------------------------------------------------------------- app
// Offscreen test runs get their own profile and skip the single-instance
// lock, so they never touch (or get handed to) a live Sidequest.
if (CAPTURE_DIR) app.setPath('userData', path.join(os.tmpdir(), `sidequest-capture-${process.pid}`));
if (!CAPTURE_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => setInteractive(true));
  app.whenReady().then(() => {
    createWindow();
    if (!CAPTURE_DIR) createTray();
    startMirror();
    if (process.argv.includes('--demo')) replay(process.env.SIDEQUEST_DEMO || path.join(__dirname, 'demo.jsonl'));
    else startEngine();
  });
  app.on('before-quit', () => { quitting = true; stopEngine(); });
  app.on('window-all-closed', () => app.quit());
}
