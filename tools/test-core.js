'use strict';
/* Round-trip checks for the file format. Run with: npm test */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sealed = require('../core/sealed');
const store = require('../core/store');

let passed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

const LETTER = 'Dear nobody,\r\n\r\nthe key is under the third stone. 🔑\r\n';

test('seal, write to disk, parse back, open with the password', async () => {
  const made = await sealed.create({ name: 'Letter', password: 'correct horse', text: LETTER });
  const onDisk = sealed.serialize(made.payload);

  assert.ok(onDisk.includes('Name:   Letter'), 'the name is visible in the raw file');
  assert.ok(!onDisk.includes('third stone'), 'the letter never appears in the clear');

  const back = sealed.parse(onDisk);
  const opened = await sealed.open(back, 'correct horse');
  assert.strictEqual(opened.text, LETTER);
});

test('a wrong password is refused but the name still reads', async () => {
  const made = await sealed.create({ name: 'Diary', password: 'right', text: 'secret' });
  const back = sealed.parse(sealed.serialize(made.payload));

  assert.strictEqual(sealed.publicInfo(back).name, 'Diary');
  await assert.rejects(() => sealed.open(back, 'wrong'), (e) => e.code === 'WRONG_PASSWORD');
});

test('an intruder writes to the log without being able to read it', async () => {
  const made = await sealed.create({ name: 'Vault', password: 'open sesame', text: 'gold' });
  let note = sealed.parse(sealed.serialize(made.payload));

  // The intruder holds nothing but the file, and still leaves a mark.
  sealed.record(note, { at: 1000, user: 'guest', host: 'PC', kind: 'wrong-password', typed: 'hunter2' });
  sealed.record(note, { at: 2000, user: 'guest', host: 'PC', kind: 'wrong-password', typed: 'letmein' });
  note = sealed.parse(sealed.serialize(note));

  assert.strictEqual(sealed.publicInfo(note).attempts, 2, 'attempt count is public');
  const raw = sealed.serialize(note);
  assert.ok(!raw.includes('hunter2'), 'what they typed is not sitting in the file');

  const owner = await sealed.open(note, 'open sesame');
  const log = sealed.readLog(note, owner.keys.priv);
  assert.deepStrictEqual(log.map((e) => e.typed), ['hunter2', 'letmein']);
  assert.strictEqual(log[0].kind, 'wrong-password');
});

test('a photo is sealed to the note and readable only with the password', async () => {
  const made = await sealed.create({ name: 'Camera', password: 'pw', text: 'x' });
  let note = made.payload;

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]);
  const id = sealed.addPhoto(note, jpeg, 'wrong-password');
  sealed.record(note, { at: 1000, user: 'guest', host: 'PC', kind: 'wrong-password', shot: id });
  note = sealed.parse(sealed.serialize(note));

  assert.strictEqual(sealed.publicInfo(note).photos, 1, 'the photo count is public');
  const raw = sealed.serialize(note);
  assert.ok(!raw.includes(jpeg.toString('base64')), 'the raw photo bytes are not in the file');

  const owner = await sealed.open(note, 'pw');
  const back = sealed.readPhoto(note, owner.keys.priv, id);
  assert.deepStrictEqual([...back], [...jpeg], 'the owner gets the exact bytes back');
});

test('routine opens never evict an intruder face from the photo ring', async () => {
  const made = await sealed.create({ name: 'Ring', password: 'pw', text: '' });
  const note = made.payload;
  const face = Buffer.from([1, 2, 3]);

  const intruder = sealed.addPhoto(note, Buffer.from([9, 9, 9]), 'wrong-password');
  for (let i = 0; i < sealed.MAX_PHOTOS + 10; i++) sealed.addPhoto(note, face, 'opened');

  assert.strictEqual(note.photos.length, sealed.MAX_PHOTOS, 'the ring is bounded');
  const opened = await sealed.open(note, 'pw');
  assert.ok(sealed.readPhoto(note, opened.keys.priv, intruder), 'the wrong-password face survived');
});

test('editing the letter keeps the log and the password', async () => {
  const made = await sealed.create({ name: 'Notes', password: 'pw', text: 'v1' });
  let note = made.payload;
  sealed.record(note, { at: 1, kind: 'sealed' });

  const opened = await sealed.open(note, 'pw');
  sealed.writeBody(note, opened.keys, 'v2 much longer text '.repeat(40));
  note = sealed.parse(sealed.serialize(note));

  const again = await sealed.open(note, 'pw');
  assert.ok(again.text.startsWith('v2'));
  assert.strictEqual(sealed.readLog(note, again.keys.priv).length, 1);
});

test('changing the password retires the old one and keeps the log readable', async () => {
  const made = await sealed.create({ name: 'Rotate', password: 'old', text: 'body' });
  let note = made.payload;
  sealed.record(note, { at: 1, kind: 'wrong-password', typed: 'guess' });

  const opened = await sealed.open(note, 'old');
  await sealed.changePassword(note, opened.keys, 'new');
  note = sealed.parse(sealed.serialize(note));

  await assert.rejects(() => sealed.open(note, 'old'), (e) => e.code === 'WRONG_PASSWORD');
  const fresh = await sealed.open(note, 'new');
  assert.strictEqual(fresh.text, 'body');
  assert.strictEqual(sealed.readLog(note, fresh.keys.priv)[0].typed, 'guess');
});

test('padding hides the true length of short letters', async () => {
  const a = await sealed.create({ name: 'a', password: 'p', text: 'x' });
  const b = await sealed.create({ name: 'b', password: 'p', text: 'x'.repeat(200) });
  assert.strictEqual(
    sealed.publicInfo(a.payload).approxBytes,
    sealed.publicInfo(b.payload).approxBytes,
    'one character and two hundred look the same from outside'
  );
});

test('a tampered ciphertext refuses to open', async () => {
  const made = await sealed.create({ name: 'Tamper', password: 'pw', text: 'original' });
  const note = sealed.parse(sealed.serialize(made.payload));
  const ct = sealed.unb64(note.body.ct);
  ct[0] ^= 0xff;
  note.body.ct = sealed.b64(ct);
  await assert.rejects(() => sealed.open(note, 'pw'));
});

test('a file that is not a note is rejected clearly', () => {
  assert.throws(() => sealed.parse('just some text\r\nnothing to see'), /not a Waxseal note/);
});

test('the log is a ring buffer, not an unbounded pile', async () => {
  const made = await sealed.create({ name: 'Ring', password: 'pw', text: '' });
  const note = made.payload;
  for (let i = 0; i < sealed.MAX_LOG + 5; i++) sealed.record(note, { at: i, kind: 'wrong-password' });
  assert.strictEqual(note.log.length, sealed.MAX_LOG);
  const opened = await sealed.open(note, 'pw');
  assert.strictEqual(sealed.readLog(note, opened.keys.priv)[0].at, 5, 'oldest fell off the front');
});

test('filenames are made safe and never collide', () => {
  assert.strictEqual(store.safeName('my/secret: plan?'), 'my secret plan');
  assert.strictEqual(store.safeName('   '), 'note');
  assert.strictEqual(store.safeName('CON'), 'note');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waxseal-'));
  const first = store.freePath(dir, 'Plan');
  fs.writeFileSync(first, 'x');
  const second = store.freePath(dir, 'Plan');
  assert.strictEqual(path.basename(first), 'Plan.txt');
  assert.strictEqual(path.basename(second), 'Plan (2).txt');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the shelf lists sealed notes and flags anything else', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waxseal-'));
  const made = await sealed.create({ name: 'Shelf test', password: 'pw', text: 'hi' });
  store.saveNote(path.join(dir, 'Shelf test.txt'), made.payload);
  fs.writeFileSync(path.join(dir, 'shopping.txt'), 'milk, eggs');

  const rows = store.list(dir);
  assert.strictEqual(rows.length, 2);
  const note = rows.find((r) => r.sealed);
  const plain = rows.find((r) => !r.sealed);
  assert.strictEqual(note.name, 'Shelf test');
  assert.strictEqual(plain.name, 'shopping');
  assert.ok(plain.problem);
  fs.rmSync(dir, { recursive: true, force: true });
});

(async () => {
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log('  ok   ' + name);
    } catch (e) {
      console.log('  FAIL ' + name + '\n       ' + (e && e.message));
      process.exitCode = 1;
    }
  }
  console.log('\n' + passed + '/' + cases.length + ' passed');
})();
