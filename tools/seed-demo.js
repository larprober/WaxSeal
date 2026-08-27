'use strict';
/*
 * Fills a folder with sealed notes for looking at the app during development.
 * Usage: node tools/seed-demo.js <folder>      (password for all of them: demo)
 */

const fs = require('fs');
const path = require('path');
const sealed = require('../core/sealed');
const store = require('../core/store');

const dir = process.argv[2] || path.join(require('os').tmpdir(), 'waxseal-demo');
const DAY = 86400000;

const NOTES = [
  {
    name: 'Bank stuff',
    text: 'Card ending 4417, expires 09/29.\r\n\r\nRecovery codes are folded inside the printer manual, bottom drawer.\r\n\r\nDo not keep any of this in a browser note.',
    age: 12,
    log: [
      { kind: 'opened', user: 'larprober', ago: 9 * DAY },
      { kind: 'wrong-password', user: 'misafir', typed: 'password123', ago: 4 * DAY },
      { kind: 'wrong-password', user: 'misafir', typed: 'hunter2', ago: 4 * DAY - 40000 },
      { kind: 'wrong-password', user: 'misafir', typed: 'qwerty', ago: 4 * DAY - 95000 },
      { kind: 'opened', user: 'larprober', ago: 2 * DAY },
      { kind: 'edited', user: 'larprober', ago: 2 * DAY - 300000 },
      { kind: 'password-changed', user: 'larprober', ago: 5400000 },
    ],
  },
  {
    name: 'Letter to myself, 2031',
    text: 'If you are reading this you kept the password for five years. Well done.',
    age: 40,
    log: [],
  },
  {
    name: 'Wifi and router password',
    text: 'SSID: TurkTelekom_ZR4Q\r\nKey: 881-hazel-moth-kettle\r\nRouter admin: 192.168.1.1',
    age: 3,
    log: [{ kind: 'opened', user: 'larprober', ago: DAY }],
  },
];

(async () => {
  store.ensureDir(dir);
  const host = 'DESKTOP-DEMO';
  for (const spec of NOTES) {
    const made = await sealed.create({ name: spec.name, password: 'demo', text: spec.text });
    made.payload.sealedAt = Date.now() - spec.age * DAY;
    sealed.record(made.payload, { at: made.payload.sealedAt, user: 'larprober', host: host, kind: 'sealed' });
    for (const e of spec.log) {
      sealed.record(made.payload, {
        at: Date.now() - e.ago, user: e.user, host: host, kind: e.kind,
        typed: e.typed,
      });
    }
    made.payload.updatedAt = Date.now() - (spec.log.length ? spec.log[spec.log.length - 1].ago : spec.age * DAY);
    store.saveNote(path.join(dir, store.safeName(spec.name) + '.txt'), made.payload);
  }
  fs.writeFileSync(path.join(dir, 'shopping.txt'), 'milk, eggs, coffee\r\n', 'utf8');
  console.log('seeded ' + NOTES.length + ' sealed notes in ' + dir + ' (password: demo)');
})();
