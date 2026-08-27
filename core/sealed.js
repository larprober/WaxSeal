'use strict';
/*
 * The Waxseal file format.
 *
 * A sealed note is a .txt file that says its own name out loud and keeps
 * everything else shut. Open one in Notepad and you get the name, the date it
 * was sealed, and a wall of base64.
 *
 * Two keys live in every file:
 *
 *   - a password-derived key (scrypt) that unwraps the letter itself;
 *   - an X25519 keypair whose PUBLIC half sits in the clear.
 *
 * The public half is what makes the attempt log work. Anyone who touches the
 * note - right password or wrong - can seal a record of that attempt to the
 * public key without holding any secret. Reading those records back needs the
 * private half, which is wrapped under the password. So an intruder writes into
 * the log by trying, and cannot read or unpick what they wrote.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const MAX_LOG = 2000;              // ring buffer; oldest attempts fall off the end
const MAX_PHOTOS = 30;             // photos are heavy, so far fewer are kept than log lines
const PAD_TO = 256;                // hide the true length of the letter
const HKDF_INFO = Buffer.from('waxseal/log/v1');

const BEGIN = 'WAXSEAL1:';
const END = ':ENDWAXSEAL';
const RULE = '-'.repeat(66);

/* ------------------------------------------------------------------ bytes */

const b64 = (b) => Buffer.from(b).toString('base64');
const unb64 = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'base64'));

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext)), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

function decrypt(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv));
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(unb64(box.tag));
  return Buffer.concat([d.update(unb64(box.ct)), d.final()]);
}

// Length-prefixed then padded with noise, so ciphertext size only reveals a
// rough bucket rather than the exact number of characters written.
function pad(text) {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  const total = Math.ceil((body.length + 5) / PAD_TO) * PAD_TO;
  return Buffer.concat([head, body, crypto.randomBytes(total - body.length - 4)]);
}

function unpad(buf) {
  const len = buf.readUInt32LE(0);
  if (len > buf.length - 4) throw new Error('corrupt payload');
  return buf.subarray(4, 4 + len).toString('utf8');
}

/* ------------------------------------------------------- sealing to a key */

function seal(pubB64, plaintext) {
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' });
  const shared = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: crypto.createPublicKey({ key: unb64(pubB64), type: 'spki', format: 'der' }),
  });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, epk, HKDF_INFO, 32));
  return Object.assign({ epk: b64(epk) }, encrypt(key, plaintext));
}

function unseal(privDer, box) {
  const epk = unb64(box.epk);
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({ key: unb64(privDer), type: 'pkcs8', format: 'der' }),
    publicKey: crypto.createPublicKey({ key: epk, type: 'spki', format: 'der' }),
  });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, epk, HKDF_INFO, 32));
  return decrypt(key, box);
}

/* ----------------------------------------------------------- the envelope */

function serialize(payload) {
  const blob = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const lines = blob.match(/.{1,76}/g) || [''];
  return [
    'WAXSEAL SEALED NOTE',
    'Name:   ' + payload.name,
    'Sealed: ' + new Date(payload.sealedAt).toISOString(),
    RULE,
    'The name above is public. Everything below is encrypted with AES-256-GCM',
    'and opens only with this note password. Every attempt to open it - right',
    'or wrong - is recorded inside this file, readable only by whoever knows',
    'that password. Editing the block below destroys the note.',
    RULE,
    BEGIN,
  ].concat(lines, [END, '']).join('\r\n');
}

function parse(text) {
  const start = text.indexOf(BEGIN);
  const stop = text.indexOf(END, start + 1);
  if (start < 0 || stop < 0) throw new Error('not a Waxseal note');
  const blob = text.slice(start + BEGIN.length, stop).replace(/\s+/g, '');
  let payload;
  try {
    payload = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('this note is damaged and cannot be read');
  }
  if (!payload || payload.v !== VERSION) throw new Error('unsupported note version');
  for (const field of ['name', 'kdf', 'pub', 'wrapPriv', 'wrapBody', 'body']) {
    if (!payload[field]) throw new Error('this note is damaged and cannot be read');
  }
  if (!Array.isArray(payload.log)) payload.log = [];
  if (!Array.isArray(payload.photos)) payload.photos = [];
  return payload;
}

// What anybody on this PC is allowed to know without the password.
function publicInfo(payload) {
  return {
    name: payload.name,
    sealedAt: payload.sealedAt,
    updatedAt: payload.updatedAt || payload.sealedAt,
    attempts: payload.log.length,
    photos: (payload.photos || []).length,
    // rounded up to the padding bucket - a hint at length, never the real one
    approxBytes: Math.max(0, unb64(payload.body.ct).length - 4),
  };
}

/* -------------------------------------------------------------- lifecycle */

async function passKey(password, kdf) {
  return scrypt(Buffer.from(password, 'utf8'), unb64(kdf.salt), 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem,
  });
}

async function create(opts) {
  const salt = crypto.randomBytes(16);
  const kdf = { salt: b64(salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  const pk = await passKey(opts.password, kdf);

  const kp = crypto.generateKeyPairSync('x25519');
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
  const pub = kp.publicKey.export({ type: 'spki', format: 'der' });
  const bodyKey = crypto.randomBytes(32);
  const at = Date.now();

  const payload = {
    v: VERSION,
    name: String(opts.name),
    sealedAt: at,
    updatedAt: at,
    kdf: kdf,
    pub: b64(pub),
    wrapPriv: encrypt(pk, priv, 'waxseal/priv'),
    wrapBody: encrypt(pk, bodyKey, 'waxseal/body-key'),
    body: encrypt(bodyKey, pad(opts.text || '')),
    log: [],
    photos: [],
  };
  pk.fill(0);
  return { payload: payload, keys: { priv: priv, bodyKey: bodyKey } };
}

// Returns the letter plus the keys needed to write it back. A wrong password
// throws: the GCM tag is the only check, so there is no password hash sitting
// in the file for someone to grind separately.
async function open(payload, password) {
  const pk = await passKey(password, payload.kdf);
  let priv, bodyKey;
  try {
    priv = decrypt(pk, payload.wrapPriv, 'waxseal/priv');
    bodyKey = decrypt(pk, payload.wrapBody, 'waxseal/body-key');
  } catch (e) {
    const err = new Error('wrong password');
    err.code = 'WRONG_PASSWORD';
    throw err;
  } finally {
    pk.fill(0);
  }
  return { keys: { priv: priv, bodyKey: bodyKey }, text: unpad(decrypt(bodyKey, payload.body)) };
}

function writeBody(payload, keys, text) {
  payload.body = encrypt(keys.bodyKey, pad(text));
  payload.updatedAt = Date.now();
  return payload;
}

async function changePassword(payload, keys, newPassword) {
  const salt = crypto.randomBytes(16);
  const kdf = { salt: b64(salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p };
  const pk = await passKey(newPassword, kdf);
  payload.kdf = kdf;
  payload.wrapPriv = encrypt(pk, keys.priv, 'waxseal/priv');
  payload.wrapBody = encrypt(pk, keys.bodyKey, 'waxseal/body-key');
  payload.updatedAt = Date.now();
  pk.fill(0);
  return payload;
}

function rename(payload, name) {
  payload.name = String(name);
  payload.updatedAt = Date.now();
  return payload;
}

/* ------------------------------------------------------------- the tripwire */

function record(payload, entry) {
  payload.log.push(seal(payload.pub, JSON.stringify(entry)));
  if (payload.log.length > MAX_LOG) payload.log.splice(0, payload.log.length - MAX_LOG);
  return payload;
}

function readLog(payload, priv) {
  return payload.log.map(function (box, i) {
    try {
      return Object.assign({ i: i }, JSON.parse(unseal(priv, box).toString('utf8')));
    } catch (e) {
      return { i: i, at: null, kind: 'unreadable', damaged: true };
    }
  });
}

/* --------------------------------------------------------- the camera */

// A photo is sealed to the note's public key exactly like a log line, so the
// face at the lock is written down the moment someone tries and can be read
// back by nobody but the password holder. The photo lives in its own ring so
// its weight never pushes the written record out.
function addPhoto(payload, jpeg, kind) {
  if (!Array.isArray(payload.photos)) payload.photos = [];
  const id = crypto.randomBytes(6).toString('hex');
  payload.photos.push(Object.assign(
    { id: id, at: Date.now(), kind: kind || 'attempt' },
    seal(payload.pub, jpeg)
  ));
  // When the ring is full, drop a routine open before ever dropping a face
  // that was caught on a wrong password.
  while (payload.photos.length > MAX_PHOTOS) {
    let i = payload.photos.findIndex(function (p) { return p.kind !== 'wrong-password'; });
    if (i < 0) i = 0;
    payload.photos.splice(i, 1);
  }
  return id;
}

function readPhoto(payload, priv, id) {
  const shot = (payload.photos || []).find(function (p) { return p.id === id; });
  if (!shot) return null;
  return unseal(priv, shot);
}

module.exports = {
  VERSION: VERSION, SCRYPT: SCRYPT, MAX_LOG: MAX_LOG,
  create: create, open: open, parse: parse, serialize: serialize, publicInfo: publicInfo,
  writeBody: writeBody, changePassword: changePassword, rename: rename,
  record: record, readLog: readLog,
  addPhoto: addPhoto, readPhoto: readPhoto, MAX_PHOTOS: MAX_PHOTOS,
  seal: seal, unseal: unseal, encrypt: encrypt, decrypt: decrypt, b64: b64, unb64: unb64,
};
