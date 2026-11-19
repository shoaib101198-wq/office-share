'use strict';
// Office Share — Electron main process: tray, auto-start, notifications, IPC.
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, Notification,
  clipboard, nativeImage, powerMonitor,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Engine } = require('./src/core/engine');

const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let engine = null;
let quitting = false;
let pendingSend = [];
let trayHintShown = false;

app.setAppUserModelId('com.highskygo.officeshare');
// Optional separate profile (lets you run two copies on one PC for testing).
if (process.env.OFFICE_SHARE_PROFILE) app.setPath('userData', path.resolve(process.env.OFFICE_SHARE_PROFILE));

/* ---------- single instance + "Send to" handling ---------- */

function filesFromArgv(argv) {
  const skip = new Set([process.execPath, app.getAppPath(), path.resolve('.')]);
  return argv.slice(1).filter((a) => {
    if (!a || a.startsWith('-')) return false;
    const abs = path.resolve(a);
    if (skip.has(abs) || abs.endsWith('main.js')) return false;
    try { return path.isAbsolute(a) && fs.existsSync(abs); } catch { return false; }
  });
}

function queueSend(files) {
  if (!files.length) return;
  pendingSend = [...new Set(files)];
  send('pending', pendingSend);
  showWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    if (files.length) queueSend(files); else showWindow();
  });
  app.on('open-file', (e, p) => { // macOS: drop on dock icon
    e.preventDefault();
    if (app.isReady()) queueSend([p]); else pendingSend.push(p);
  });
  app.whenReady().then(boot);
}

/* ---------- helpers ---------- */

function send(type, data) {
  if (win && !win.isDestroyed()) win.webContents.send('evt', { type, data });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function notify(title, body, onClick) {
  const s = engine.settings.data;
  if (!s.notifications || s.status === 'busy' || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: !s.sounds });
  n.on('click', () => { showWindow(); onClick && onClick(); });
  n.show();
}

function attention() {
  if (win && !win.isFocused() && process.platform !== 'darwin') win.flashFrame(true);
  if (process.platform === 'darwin' && app.dock) app.dock.bounce('informational');
}

function exePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE || process.execPath;
}

function applyLoginItem(enabled) {
  if (!app.isPackaged) return; // don't register the dev Electron binary
  try {
    if (process.platform === 'linux') {
      const dir = path.join(os.homedir(), '.config', 'autostart');
      const file = path.join(dir, 'office-share.desktop');
      if (enabled) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Office Share\nExec="${exePath()}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
      } else fs.rmSync(file, { force: true });
    } else {
      app.setLoginItemSettings({ openAtLogin: !!enabled, path: exePath(), args: ['--hidden'] });
    }
  } catch (e) { console.error('login item', e); }
}

function installSendTo() {
  if (process.platform !== 'win32' || !app.isPackaged || !process.env.APPDATA) return;
  try {
    const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'SendTo', 'Office Share.lnk');
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      target: exePath(), args: '--send', description: 'Send with Office Share', icon: exePath(), iconIndex: 0,
    });
  } catch (e) { console.error('sendto', e); }
}

/** Only allow opening files we received/sent or inside the receive folder. */
function allowedPath(p) {
  if (typeof p !== 'string' || !p) return false;
  const abs = path.resolve(p);
  const root = path.resolve(engine.settings.get('receiveDir'));
  if (abs === root || abs.startsWith(root + path.sep)) return true;
  return engine.history.get('items').some((h) => (h.savedPaths || []).includes(abs) || (h.localPaths || []).includes(abs));
}

/* ---------- window + tray ---------- */

function createWindow(show) {
  win = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Office Share',
    icon: ICON,
    backgroundColor: '#0d1017',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'Office Share is still running', body: 'You can still receive files. Open it from the tray icon.', icon: ICON, silent: true }).show();
    }
  });
}

function trayImage() {
  let img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) img = nativeImage.createFromPath(ICON);
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img.resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
}

function updateTray() {
  if (!tray) return;
  const peers = engine.peers();
  const status = engine.settings.get('status');
  tray.setToolTip(`Office Share — ${peers.length} online`);
  const setStatus = (s) => { engine.updateSettings({ status: s }); send('state', fullState()); updateTray(); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Office Share', click: showWindow },
    { type: 'separator' },
    {
      label: `Online now (${peers.length})`,
      submenu: peers.length
        ? peers.map((p) => ({ label: `${p.name}${p.status !== 'available' ? ` (${p.status})` : ''}`, click: () => { showWindow(); send('select', p.id); } }))
        : [{ label: 'No one else yet', enabled: false }],
    },
    {
      label: 'My status',
      submenu: [
        { label: 'Available', type: 'radio', checked: status === 'available', click: () => setStatus('available') },
        { label: 'Busy (no popups)', type: 'radio', checked: status === 'busy', click: () => setStatus('busy') },
        { label: 'Away', type: 'radio', checked: status === 'away', click: () => setStatus('away') },
      ],
    },
    { label: 'Open received files', click: () => { fs.mkdirSync(engine.settings.get('receiveDir'), { recursive: true }); shell.openPath(engine.settings.get('receiveDir')); } },
    { type: 'separator' },
    { label: 'Quit Office Share', click: () => { quitting = true; app.quit(); } },
  ]));
}

function fullState() {
  return { ...engine.state(), pending: pendingSend, version: app.getVersion(), platform: process.platform, addresses: localIPs() };
}

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}

/* ---------- boot ---------- */

async function boot() {
  engine = new Engine({
    dataDir: app.getPath('userData'),
    defaultReceiveDir: path.join(app.getPath('downloads'), 'Office Share'),
  });

  engine.on('peers', () => { send('peers', { peers: engine.peers(), foreignCount: engine.foreignCount() }); updateTray(); });
  engine.on('transfer', (t) => send('transfer', t));
  engine.on('message', (m) => {
    send('message', m);
    if (m.direction === 'in') {
      attention();
      notify(`Message from ${m.peerName}`, m.text.slice(0, 180), () => send('select', m.peerId));
    }
  });
  engine.on('buzz', (p) => {
    send('buzz', p);
    attention();
    notify(`${p.name} buzzed you`, 'They need your attention.', () => send('select', p.id));
  });
  engine.on('ask', (t) => {
    send('ask', t);
    attention();
    notify(`${t.peerName} wants to send you files`, `${t.title} — open Office Share to accept`, () => send('ask', t));
  });
  engine.on('received', (t) => {
    send('received', t);
    attention();
    notify(`${t.peerName} sent you ${t.title}`, 'Click to show it in the folder', () => {
      if (t.savedPaths && t.savedPaths[0]) shell.showItemInFolder(t.savedPaths[0]);
    });
  });
  engine.on('warn', (e) => console.warn('engine', e.message));

  registerIpc();

  try { await engine.start(); } catch (e) {
    dialog.showErrorBox('Office Share', `Could not start networking: ${e.message}`);
  }

  pendingSend = [...new Set([...pendingSend, ...filesFromArgv(process.argv)])];
  createWindow(!startHidden || !engine.isConfigured() || pendingSend.length > 0);

  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();

  applyLoginItem(engine.settings.get('startAtLogin'));
  installSendTo();

  // Re-announce right after sleep or WiFi change so we show up instantly.
  powerMonitor.on('resume', () => setTimeout(() => engine.discovery && engine.discovery.announce('hello'), 2000));
  powerMonitor.on('unlock-screen', () => engine.discovery && engine.discovery.announce('hello'));

  app.on('activate', showWindow);
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (engine && engine.server) {
    e.preventDefault();
    engine.stop().finally(() => { engine.server = null; app.exit(0); });
  }
});

/* ---------- IPC ---------- */

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, data: await fn(arg || {}) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });

  h('state', () => fullState());

  h('setup', async ({ passphrase, deviceName }) => {
    await engine.setup({ passphrase, deviceName });
    updateTray();
    return fullState();
  });

  h('settings:update', async (patch) => {
    const before = engine.settings.get('startAtLogin');
    const s = await engine.updateSettings(patch);
    if ('startAtLogin' in patch && patch.startAtLogin !== before) applyLoginItem(patch.startAtLogin);
    updateTray();
    return s;
  });

  h('send:paths', ({ peerIds, paths }) => engine.sendPaths(peerIds, paths.filter((p) => typeof p === 'string' && p)));

  h('send:pick', async ({ peerIds, folder }) => {
    const r = await dialog.showOpenDialog(win, {
      title: folder ? 'Choose a folder to send' : 'Choose files to send',
      properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return [];
    return engine.sendPaths(peerIds, r.filePaths);
  });

  h('send:text', ({ peerIds, text }) => engine.sendText(peerIds, text));

  h('send:clipboard', ({ peerIds }) => {
    const text = clipboard.readText();
    if (!text.trim()) throw new Error('Clipboard has no text');
    return engine.sendText(peerIds, text);
  });

  h('buzz', ({ peerId }) => engine.buzz(peerId));
  h('cancel', ({ id }) => engine.cancel(id));
  h('respond', ({ id, accept }) => engine.respond(id, accept));
  h('history:clear', () => engine.clearHistory());
  h('pending:clear', () => { pendingSend = []; });
  h('clipboard:write', ({ text }) => clipboard.writeText(String(text || '')));

  h('open:path', ({ p }) => { if (!allowedPath(p)) throw new Error('Not allowed'); return shell.openPath(p); });
  h('show:path', ({ p }) => { if (!allowedPath(p)) throw new Error('Not allowed'); shell.showItemInFolder(p); });
  h('open:receiveDir', () => {
    const d = engine.settings.get('receiveDir');
    fs.mkdirSync(d, { recursive: true });
    return shell.openPath(d);
  });
  h('pick:receiveDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Save received files to…', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return engine.publicSettings();
    return engine.updateSettings({ receiveDir: r.filePaths[0] });
  });
}
