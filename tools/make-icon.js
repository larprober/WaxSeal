'use strict';
/*
 * Draws build/icon.ico from the same wax geometry the app uses on screen.
 *
 * There is no image library here and none is wanted, so the seal is described
 * analytically - a wobbling radius around a centre - and sampled 4x4 per pixel.
 * That gives clean edges at 256px and still-readable wax at 16px, where the
 * milled ring and the tick marks are dropped because they only turn to mud.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [256, 128, 64, 48, 32, 16];
const SS = 4;                     // samples per pixel edge
const OUT = path.join(__dirname, '..', 'build', 'icon.ico');

/* ------------------------------------------------------------- geometry */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

// The same wobble sequence as the on-screen mark, read back as r(theta).
function wobble(r, count, amount, seed) {
  const rand = mulberry32(seed);
  const radii = [];
  for (let i = 0; i < count; i++) radii.push(r * (1 - amount / 2 + rand() * amount));
  return function (theta) {
    const f = ((theta / (Math.PI * 2)) % 1 + 1) % 1 * count;
    const i = Math.floor(f);
    const t = f - i;
    const at = (k) => radii[((k % count) + count) % count];
    return catmull(at(i - 1), at(i), at(i + 1), at(i + 2), t);
  };
}

const disc = wobble(38, 22, 0.09, 20260827);
const inner = wobble(29, 18, 0.05, 77);
const drips = [
  { x: 41, y: 89, r: wobble(5.4, 12, 0.16, 5) },
  { x: 46, y: 96, r: wobble(2.7, 10, 0.25, 13) },
];

const inBlob = (x, y, cx, cy, rf) => {
  const dx = x - cx, dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy) <= rf(Math.atan2(dy, dx));
};

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const TICKS = [];
for (let i = 0; i < 28; i++) {
  const a = (i / 28) * Math.PI * 2 - Math.PI / 2;
  TICKS.push([50 + Math.cos(a) * 24, 50 + Math.sin(a) * 24, 50 + Math.cos(a) * 27.5, 50 + Math.sin(a) * 27.5]);
}

/* --------------------------------------------------------------- colour */

const STOPS = [[0, [216, 71, 79]], [0.45, [176, 39, 52]], [1, [94, 17, 28]]];

function wax(x, y) {
  const t = Math.min(1, Math.hypot(x - 34, y - 28) / 78);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i];
      const k = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((j) => c0[j] + (c1[j] - c0[j]) * k);
    }
  }
  return STOPS[STOPS.length - 1][1].slice();
}

const over = (base, colour, alpha) => [0, 1, 2].map((j) => base[j] + (colour[j] - base[j]) * alpha);

/*
 * One sample in the 0..100 design space. Returns [r,g,b,a] with a in 0..1.
 * `detail` drops the fine pressing on the small sizes.
 */
function sample(x, y, detail) {
  let colour = null;

  if (inBlob(x, y, 50, 50, disc)) colour = wax(x, y);
  else {
    for (const d of drips) {
      if (inBlob(x, y, d.x, d.y, d.r)) { colour = wax(x, y); break; }
    }
    if (!colour) return [0, 0, 0, 0];
  }

  const onDisc = inBlob(x, y, 50, 50, disc);

  // the highlight where the light would sit in the pour
  if (onDisc) {
    const hx = (x - 34) / 27, hy = (y - 26) / 18;
    const t = Math.sqrt(hx * hx + hy * hy);
    if (t < 1) colour = over(colour, [255, 255, 255], 0.15 * (1 - t) * (1 - t));
  }

  if (detail && onDisc) {
    const theta = Math.atan2(y - 50, x - 50);
    const d = Math.hypot(x - 50, y - 50);
    if (Math.abs(d - inner(theta)) <= 1.1) colour = over(colour, [76, 13, 22], 0.55);
    for (const t of TICKS) {
      if (distToSegment(x, y, t[0], t[1], t[2], t[3]) <= 0.75) {
        colour = over(colour, [76, 13, 22], 0.4);
        break;
      }
    }
  }

  // the keyhole: a bore and the tapering slot beneath it
  const bore = detail ? 7.8 : 9.5;
  const inBore = Math.hypot(x - 50, y - 43) <= bore;
  const slotTop = detail ? 48 : 49;
  const slotBottom = detail ? 64 : 66;
  let inSlot = false;
  if (y >= slotTop && y <= slotBottom) {
    const k = (y - slotTop) / (slotBottom - slotTop);
    const halfWidth = (detail ? 3.8 : 4.6) + k * (detail ? 3.0 : 3.6);
    inSlot = Math.abs(x - 50) <= halfWidth;
  }
  if (inBore || inSlot) colour = over(colour, [69, 11, 19], 0.92);

  return [colour[0], colour[1], colour[2], 1];
}

function render(size) {
  const detail = size >= 48;
  const px = Buffer.alloc(size * size * 4);
  const step = 100 / (size * SS);

  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const s = sample((pxi * SS + sx + 0.5) * step, (py * SS + sy + 0.5) * step, detail);
          r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
        }
      }
      const n = SS * SS;
      const o = (py * size + pxi) * 4;
      if (a > 0) {
        px[o] = Math.round(r / a);
        px[o + 1] = Math.round(g / a);
        px[o + 2] = Math.round(b / a);
      }
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

/* ------------------------------------------------------------------ png */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;    // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ ico */

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);           // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach((img, i) => {
    const e = i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0;                     // palette
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);        // planes
    dir.writeUInt16LE(32, e + 6);       // bits per pixel
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  });
  return Buffer.concat([header, dir].concat(images.map((i) => i.data)));
}

const images = SIZES.map((size) => ({ size: size, data: png(size, render(size)) }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico(images));

// A standalone 256px png is handy for readmes and for eyeballing the result.
fs.writeFileSync(path.join(path.dirname(OUT), 'icon.png'), images[0].data);
console.log('wrote ' + OUT + ' (' + SIZES.join(', ') + ') and icon.png');
