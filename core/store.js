'use strict';
/*
 * Where the notes live and how they get onto disk.
 *
 * Notes are ordinary .txt files in one folder, so they can be copied, backed up
 * or opened in Notepad like anything else. Writes go through a temp file and a
 * rename, with a short retry: a sync client or an antivirus scanner can hold
 * the target open for a moment, and losing a sealed note to that would be
 * unrecoverable.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sealed = require('./sealed');

const BAD_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function safeName(name) {
  let base = String(name || '').replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim();
  base = base.replace(/[. ]+$/, '');
  if (!base || RESERVED.test(base)) base = 'note';
  if (base.length > 80) base = base.slice(0, 80).trim();
  return base;
}

// "Grocery list" -> Grocery list.txt, then Grocery list (2).txt, ...
function freePath(dir, name) {
  const base = safeName(name);
  let candidate = path.join(dir, base + '.txt');
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, base + ' (' + n + ').txt');
    n++;
  }
  return candidate;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function defaultDir() {
  const docs = path.join(os.homedir(), 'Documents');
  const base = fs.existsSync(docs) ? docs : os.homedir();
  return path.join(base, 'Waxseal Notes');
}

function writeAtomic(file, text) {
  const tmp = file + '.writing';
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') {
        try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean */ }
        throw e;
      }
      sleepSync(60 * (i + 1));
    }
  }
  // Still held after a second of trying: keep a copy, then overwrite in place.
  try { fs.copyFileSync(file, file + '.bak'); } catch (e) { /* no prior file */ }
  fs.writeFileSync(file, text, 'utf8');
  try { fs.unlinkSync(tmp); } catch (e) { /* already gone */ }
  return file;
}

function readNote(file) {
  const text = fs.readFileSync(file, 'utf8');
  return sealed.parse(text);
}

function saveNote(file, payload) {
  return writeAtomic(file, sealed.serialize(payload));
}

// Everything in the folder, with the public half of each note. Files that are
// not Waxseal notes are reported too, so the shelf can say so instead of
// silently hiding them.
function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const entry of names) {
    if (!/\.txt$/i.test(entry)) continue;
    const file = path.join(dir, entry);
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile()) continue;
    } catch (e) {
      continue;
    }
    const row = { file: file, filename: entry, bytes: stat.size, mtime: stat.mtimeMs };
    try {
      Object.assign(row, sealed.publicInfo(readNote(file)), { sealed: true });
    } catch (e) {
      row.sealed = false;
      row.name = entry.replace(/\.txt$/i, '');
      row.problem = e.message;
      row.sealedAt = stat.birthtimeMs || stat.mtimeMs;
      row.updatedAt = stat.mtimeMs;
    }
    out.push(row);
  }
  out.sort((a, b) => (Number(b.sealed) - Number(a.sealed)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
  return out;
}

module.exports = {
  safeName: safeName,
  freePath: freePath,
  ensureDir: ensureDir,
  defaultDir: defaultDir,
  writeAtomic: writeAtomic,
  readNote: readNote,
  saveNote: saveNote,
  list: list,
};
