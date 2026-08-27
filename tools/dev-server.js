'use strict';
/*
 * Serves the renderer with a stand-in for the preload bridge, so the window can
 * be looked at in a browser without packaging Electron. Nothing here ships.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'renderer');
const PORT = Number(process.env.PORT) || 4321;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const MOCK = `
(function () {
  const now = Date.now(), day = 86400000;
  const who = { user: 'larprober', host: 'DESKTOP-DEMO' };
  const log = [
    { i: 0, at: now - day * 12, user: 'larprober', host: 'DESKTOP-DEMO', kind: 'sealed' },
    { i: 1, at: now - day * 9, user: 'larprober', host: 'DESKTOP-DEMO', kind: 'opened' },
    { i: 2, at: now - day * 4, user: 'misafir', host: 'DESKTOP-DEMO', kind: 'wrong-password', typed: 'password123', shot: 'a1' },
    { i: 3, at: now - day * 4 + 40000, user: 'misafir', host: 'DESKTOP-DEMO', kind: 'wrong-password', typed: 'hunter2', shot: 'a2' },
    { i: 4, at: now - day * 4 + 95000, user: 'misafir', host: 'DESKTOP-DEMO', kind: 'wrong-password', typed: 'qwerty', shot: 'a3' },
    { i: 5, at: now - day * 2, user: 'larprober', host: 'DESKTOP-DEMO', kind: 'opened', shot: 'b1' },
    { i: 6, at: now - day * 2 + 300000, user: 'larprober', host: 'DESKTOP-DEMO', kind: 'edited' },
    { i: 7, at: now - 5400000, user: 'larprober', host: 'DESKTOP-DEMO', kind: 'password-changed' },
  ];
  const rows = [
    { file: 'D:/n/Bank stuff.txt', filename: 'Bank stuff.txt', name: 'Bank stuff', sealed: true, bytes: 3183, sealedAt: now - day * 12, updatedAt: now - 5400000, attempts: 8 },
    { file: 'D:/n/Letter to myself.txt', filename: 'Letter to myself.txt', name: 'Letter to myself, 2031', sealed: true, bytes: 2410, sealedAt: now - day * 40, updatedAt: now - day * 40, attempts: 1 },
    { file: 'D:/n/Wifi.txt', filename: 'Wifi.txt', name: 'Wifi and router password', sealed: true, bytes: 1902, sealedAt: now - day * 3, updatedAt: now - day * 3, attempts: 2, elsewhere: true },
    { file: 'D:/n/shopping.txt', filename: 'shopping.txt', name: 'shopping', sealed: false, bytes: 88, sealedAt: now - day, updatedAt: now - day, attempts: 0, problem: 'not a Waxseal note' },
  ];
  const ok = (o) => Promise.resolve(Object.assign({ ok: true }, o));
  const info = (r) => ({ file: r.file, filename: r.filename, name: r.name, sealedAt: r.sealedAt, updatedAt: r.updatedAt, attempts: r.attempts });
  const FACE = (id) => {
    const n = parseInt((id || '1').replace(/D/g, '') || '1', 10);
    const hue = (n * 63) % 360;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">' +
      '<rect width="320" height="240" fill="hsl(' + hue + ',20%,15%)"/>' +
      '<circle cx="160" cy="92" r="48" fill="hsl(' + hue + ',24%,34%)"/>' +
      '<rect x="92" y="150" width="136" height="120" rx="64" fill="hsl(' + hue + ',24%,30%)"/>' +
      '<text x="160" y="230" fill="rgba(255,255,255,.45)" font-family="monospace" font-size="15" text-anchor="middle">preview ' + id + '</text>' +
      '</svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  };

  window.waxseal = {
    info: () => ok({ version: '1.0.0', dir: 'C:\\\\Users\\\\larprober\\\\Documents\\\\Waxseal Notes', who: who, idleMinutes: 15 }),
    shelf: {
      list: () => ok({ dir: 'C:\\\\Users\\\\larprober\\\\Documents\\\\Waxseal Notes', rows: rows }),
      reveal: () => ok({}), chooseFolder: () => ok({ changed: false }), addExisting: () => ok({ added: false }),
    },
    note: {
      create: (a) => { rows.unshift({ file: 'D:/n/' + a.name + '.txt', filename: a.name + '.txt', name: a.name, sealed: true, bytes: 1400, sealedAt: Date.now(), updatedAt: Date.now(), attempts: 1 }); return ok({ info: info(rows[0]) }); },
      unlock: (a) => {
        const row = rows.find((r) => r.file === a.file) || rows[0];
        if (a.password !== 'demo') return Promise.resolve({ ok: false, error: 'Wrong password.', code: 'WRONG_PASSWORD' });
        return ok({ session: 's1', text: 'Paragraph 1. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 2. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 3. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 4. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 5. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 6. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 7. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 8. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.\\n\\nParagraph 9. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back. The seal holds because nobody but the holder of the password can lift it, and every hand that tries leaves a mark under the wax that only that same password can read back.', info: info(row), log: log });
      },
      peek: () => ok({}), log: () => ok({ log: log }),
      save: (a) => ok({ info: info(rows[0]), log: log }),
      rename: (a) => ok({ info: Object.assign(info(rows[0]), { name: a.name }), file: rows[0].file }),
      changePassword: () => ok({ info: info(rows[0]), log: log }),
      remove: () => ok({}), lock: () => ok({}), touch: () => ok({ alive: true }),
      shot: (a) => ok({ dataUrl: FACE(a.id) }),
    },
    onSessionExpired: () => {},
  };
})();
`;

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/mock.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(MOCK);
  }
  const file = path.join(ROOT, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    let body = buf;
    if (file.endsWith('index.html')) {
      body = Buffer.from(String(buf).replace('<script src="app.js">', '<script src="mock.js"></script>\n  <script src="app.js">'));
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' });
    res.end(body);
  });
}).listen(PORT, '127.0.0.1', () => console.log('renderer preview on http://127.0.0.1:' + PORT));
