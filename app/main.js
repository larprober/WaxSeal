'use strict';
/*
 * Waxseal - main process.
 *
 * Holds the only copy of an unlocked note's keys. The window never sees a key,
 * only a session id that the main process trades back for the letter; the
 * session dies on lock, on idle, and on quit.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pkg = require('../package.json');

const sealed = require('../core/sealed');
const store = require('../core/store');

const IDLE_MS = 10 * 60 * 1000;   // an unlocked note relocks itself after 10 idle minutes
const WRONG_DELAY_MS = 700;       // slow guessing down; never refuse to log
const WHO = { user: os.userInfo().username, host: os.hostname() };
const ICON = path.join(__dirname, '..', 'build', 'icon.ico');

let win = null;
let settings = null;
const sessions = new Map();       // id -> { file, payload, keys, timer }

/* ------------------------------------------------------------- settings */

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (e) { /* first run */ }
  settings = {
    dir: typeof saved.dir === 'string' && saved.dir ? saved.dir : store.defaultDir(),
    extras: Array.isArray(saved.extras) ? saved.extras.filter((p) => typeof p === 'string') : [],
  };
  try { store.ensureDir(settings.dir); } catch (e) { /* reported when listing */ }
  return settings;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { /* a lost preference is not worth an error dialog */ }
}

/* ------------------------------------------------------------- sessions */

function touch(id) {
  const s = sessions.get(id);
  if (!s) return null;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    drop(id);
    if (win && !win.isDestroyed()) win.webContents.send('session:expired', id);
  }, IDLE_MS);
  return s;
}

function drop(id) {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.timer);
  try {
    s.keys.priv.fill(0);
    s.keys.bodyKey.fill(0);
  } catch (e) { /* already gone */ }
  sessions.delete(id);
}

function need(id) {
  const s = touch(id);
  if (!s) {
    const err = new Error('This note locked itself. Enter the password again.');
    err.code = 'NO_SESSION';
    throw err;
  }
  return s;
}

/* ---------------------------------------------------------------- shelf */

function shelfRows() {
  const rows = store.list(settings.dir);
  const seen = new Set(rows.map((r) => r.file.toLowerCase()));

  for (const file of settings.extras) {
    if (seen.has(file.toLowerCase())) continue;
    try {
      const stat = fs.statSync(file);
      const payload = store.readNote(file);
      rows.push(Object.assign(
        { file: file, filename: path.basename(file), bytes: stat.size, mtime: stat.mtimeMs, sealed: true, elsewhere: true },
        sealed.publicInfo(payload)
      ));
    } catch (e) { /* moved or deleted since it was opened */ }
  }
  rows.sort((a, b) => (Number(b.sealed) - Number(a.sealed)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  return rows;
}

// Every touch of a note leaves a record, sealed to the note's own public key.
function mark(payload, kind, extra) {
  return sealed.record(payload, Object.assign({
    at: Date.now(), user: WHO.user, host: WHO.host, kind: kind,
  }, extra || {}));
}

function summary(file, payload) {
  return Object.assign({ file: file, filename: path.basename(file) }, sealed.publicInfo(payload));
}

/* ------------------------------------------------------------------ ipc */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, arg) => {
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'unknown window' };
    try {
      return Object.assign({ ok: true }, await fn(arg || {}));
    } catch (e) {
      return { ok: false, error: e.message || String(e), code: e.code || null };
    }
  });
}

handle('app:info', async () => ({
  version: pkg.version,
  dir: settings.dir,
  who: WHO,
  idleMinutes: IDLE_MS / 60000,
}));

handle('shelf:list', async () => ({ dir: settings.dir, rows: shelfRows() }));

handle('shelf:reveal', async (a) => {
  if (a.file) shell.showItemInFolder(a.file);
  else await shell.openPath(settings.dir);
  return {};
});

handle('shelf:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose where sealed notes are kept',
    defaultPath: settings.dir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return { changed: false, dir: settings.dir };
  settings.dir = res.filePaths[0];
  store.ensureDir(settings.dir);
  saveSettings();
  return { changed: true, dir: settings.dir };
});

handle('shelf:addExisting', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a sealed note from somewhere else',
    filters: [{ name: 'Text notes', extensions: ['txt'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { added: false };
  const file = res.filePaths[0];
  store.readNote(file);                       // throws if it is not a sealed note
  if (!settings.extras.includes(file) && path.dirname(file) !== settings.dir) {
    settings.extras.unshift(file);
    settings.extras = settings.extras.slice(0, 30);
    saveSettings();
  }
  return { added: true, file: file };
});

handle('note:create', async (a) => {
  const name = String(a.name || '').trim();
  if (!name) throw new Error('Give the note a name.');
  if (!a.password) throw new Error('Choose a password.');
  store.ensureDir(settings.dir);

  const made = await sealed.create({ name: name, password: a.password, text: a.text || '' });
  mark(made.payload, 'sealed');
  const file = store.freePath(settings.dir, name);
  store.saveNote(file, made.payload);
  return { file: file, info: summary(file, made.payload) };
});

// The one place a password is checked. Right or wrong, the attempt is written
// back into the file before this returns.
handle('note:unlock', async (a) => {
  const file = String(a.file || '');
  const payload = store.readNote(file);

  // Whoever is at the keyboard, right password or wrong: seal their photo to
  // the note before we even know if they got in. A missing camera is fine -
  // the attempt is logged either way.
  function snap(kind) {
    if (!a.photo) return null;
    try {
      return sealed.addPhoto(payload, Buffer.from(String(a.photo), 'base64'), kind);
    } catch (e) {
      return null;
    }
  }

  let opened = null;
  try {
    opened = await sealed.open(payload, String(a.password || ''));
  } catch (e) {
    if (e.code !== 'WRONG_PASSWORD') throw e;
    const shot = snap('wrong-password');
    mark(payload, 'wrong-password', { typed: String(a.password || ''), shot: shot });
    try { store.saveNote(file, payload); } catch (e2) { /* read-only copy; still refuse */ }
    await new Promise((r) => setTimeout(r, WRONG_DELAY_MS));
    const err = new Error('Wrong password.');
    err.code = 'WRONG_PASSWORD';
    throw err;
  }

  const shot = snap('opened');
  mark(payload, 'opened', { shot: shot });
  try { store.saveNote(file, payload); } catch (e) { /* opening a read-only copy still works */ }

  const id = crypto.randomUUID();
  sessions.set(id, { file: file, payload: payload, keys: opened.keys, timer: null });
  touch(id);
  return {
    session: id,
    text: opened.text,
    info: summary(file, payload),
    log: sealed.readLog(payload, opened.keys.priv),
  };
});

handle('note:log', async (a) => {
  const s = need(a.session);
  return { log: sealed.readLog(s.payload, s.keys.priv), info: summary(s.file, s.payload) };
});

// Decrypt one sealed photo, on demand, for the open note. The bytes only leave
// here as a data URL the window can show; they are never written back out.
handle('note:shot', async (a) => {
  const s = need(a.session);
  const jpeg = sealed.readPhoto(s.payload, s.keys.priv, String(a.id || ''));
  if (!jpeg) throw new Error('That photo is not in this note.');
  return { dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
});

handle('note:save', async (a) => {
  const s = need(a.session);
  sealed.writeBody(s.payload, s.keys, String(a.text == null ? '' : a.text));
  mark(s.payload, 'edited');
  store.saveNote(s.file, s.payload);
  return { info: summary(s.file, s.payload), log: sealed.readLog(s.payload, s.keys.priv) };
});

handle('note:rename', async (a) => {
  const s = need(a.session);
  const name = String(a.name || '').trim();
  if (!name) throw new Error('Give the note a name.');

  sealed.rename(s.payload, name);
  mark(s.payload, 'renamed', { to: name });

  // Keep the filename in step with the name, unless something is already there.
  const wanted = path.join(path.dirname(s.file), store.safeName(name) + '.txt');
  if (wanted.toLowerCase() !== s.file.toLowerCase()) {
    const target = fs.existsSync(wanted) ? store.freePath(path.dirname(s.file), name) : wanted;
    store.saveNote(s.file, s.payload);
    try {
      fs.renameSync(s.file, target);
      settings.extras = settings.extras.map((p) => (p === s.file ? target : p));
      saveSettings();
      s.file = target;
    } catch (e) { /* file is held open somewhere; the name inside is what counts */ }
  } else {
    store.saveNote(s.file, s.payload);
  }
  return { info: summary(s.file, s.payload), file: s.file };
});

handle('note:changePassword', async (a) => {
  const s = need(a.session);
  if (!a.password) throw new Error('Choose a password.');
  await sealed.changePassword(s.payload, s.keys, String(a.password));
  mark(s.payload, 'password-changed');
  store.saveNote(s.file, s.payload);
  return { info: summary(s.file, s.payload), log: sealed.readLog(s.payload, s.keys.priv) };
});

// Deleting through the app needs the password first, and goes to the Recycle
// Bin rather than straight out of existence.
handle('note:delete', async (a) => {
  const s = need(a.session);
  await shell.trashItem(s.file);
  settings.extras = settings.extras.filter((p) => p !== s.file);
  saveSettings();
  drop(a.session);
  return {};
});

handle('note:lock', async (a) => {
  drop(a.session);
  return {};
});

// The window says "someone is still here" while a letter is being typed, so a
// long writing session never gets relocked out from under an open editor.
handle('note:touch', async (a) => {
  return { alive: !!touch(a.session) };
});

handle('note:peek', async (a) => {
  const payload = store.readNote(String(a.file || ''));
  return { info: summary(String(a.file), payload) };
});

/* ---------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#14100e',
    autoHideMenuBar: true,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#17120f', symbolColor: '#e8dfd2', height: 46 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // ready-to-show does not always arrive; never leave the app running invisibly.
  const reveal = () => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  setTimeout(reveal, 2500);
  win.on('closed', () => {
    for (const id of Array.from(sessions.keys())) drop(id);
    win = null;
  });

  // Nothing in this app should be able to navigate away or spawn a window.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // The camera - and nothing else - is allowed, and only to our own page. The
  // OS still gates it; if Windows says no, getUserMedia fails and the attempt
  // is logged without a photo.
  const ses = win.webContents.session;
  const allow = (perm) => perm === 'media';
  ses.setPermissionRequestHandler((wc, perm, done) => done(allow(perm)));
  ses.setPermissionCheckHandler((wc, perm) => allow(perm));
}

// Keep dev and packaged runs pointed at the same settings folder.
app.setName('Waxseal');
// Without this Windows files the window under Electron rather than under Waxseal.
app.setAppUserModelId('com.larprober.waxseal');
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    for (const id of Array.from(sessions.keys())) drop(id);
  });
}
