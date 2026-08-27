'use strict';
/*
 * The drawing kit.
 *
 * Every glyph is a 24x24 stroke of currentColor at a single weight, so icons
 * take their colour and size from whatever they sit inside. The seal itself is
 * generated rather than drawn by hand: a deterministic wobble around a circle
 * smoothed into cubics, so the wax has an organic edge that is identical on
 * every run and at every size.
 */

(function (global) {
  /* -------------------------------------------------------- wax geometry */

  // Deterministic noise, so the seal is the same shape every launch.
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

  // Catmull-Rom through the wobbled points, converted to cubic beziers.
  function blobPath(cx, cy, r, count, wobble, seed) {
    const rand = mulberry32(seed);
    const pts = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const rr = r * (1 - wobble / 2 + rand() * wobble);
      pts.push([cx + Math.cos(angle) * rr, cy + Math.sin(angle) * rr]);
    }
    const at = (i) => pts[(i + pts.length) % pts.length];
    let d = 'M' + at(0)[0].toFixed(2) + ' ' + at(0)[1].toFixed(2);
    for (let i = 0; i < pts.length; i++) {
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += 'C' + c1[0].toFixed(2) + ' ' + c1[1].toFixed(2) + ',' +
           c2[0].toFixed(2) + ' ' + c2[1].toFixed(2) + ',' +
           p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
    return d + 'Z';
  }

  // Notches around the stamped ring, like the milled edge of a signet.
  function ticks(cx, cy, r1, r2, count) {
    let d = '';
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      d += 'M' + (cx + Math.cos(a) * r1).toFixed(2) + ' ' + (cy + Math.sin(a) * r1).toFixed(2) +
           'L' + (cx + Math.cos(a) * r2).toFixed(2) + ' ' + (cy + Math.sin(a) * r2).toFixed(2);
    }
    return d;
  }

  const WAX = blobPath(50, 50, 38, 22, 0.09, 20260827);
  const WAX_INNER = blobPath(50, 50, 29, 18, 0.05, 77);
  const DRIP_A = blobPath(41, 89, 5.4, 12, 0.16, 5);
  const DRIP_C = blobPath(46, 96, 2.7, 10, 0.25, 13);

  let uid = 0;

  /*
   * The mark: a poured disc of wax with a signet pressed into it. The keyhole
   * in the middle is the whole idea of the app - the name on the outside is
   * public, the keyhole is not. One still highlight where the light would sit,
   * and nothing else moving.
   */
  function sealMark(size, opts) {
    const o = opts || {};
    const id = 'wax' + (++uid);
    return '' +
    '<svg class="mark" width="' + size + '" height="' + size + '" viewBox="0 0 100 100" aria-hidden="true">' +
      '<defs>' +
        '<radialGradient id="' + id + 'g" cx="34%" cy="28%" r="78%">' +
          '<stop offset="0%" stop-color="#d8474f"/>' +
          '<stop offset="45%" stop-color="#b02734"/>' +
          '<stop offset="100%" stop-color="#5e111c"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + id + 'h" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="#fff" stop-opacity=".17"/>' +
          '<stop offset="100%" stop-color="#fff" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<clipPath id="' + id + 'c"><path d="' + WAX + '"/></clipPath>' +
      '</defs>' +

      // wax that ran before it set, drawn first so the disc sits on top of it
      '<g fill="url(#' + id + 'g)">' +
        '<path d="' + DRIP_A + '"/><path d="' + DRIP_C + '"/>' +
      '</g>' +

      '<path d="' + WAX + '" fill="url(#' + id + 'g)"/>' +
      '<g clip-path="url(#' + id + 'c)">' +
        '<ellipse cx="34" cy="26" rx="27" ry="18" fill="url(#' + id + 'h)"/>' +
      '</g>' +

      // the signet pressed into it: a milled ring, then the keyhole
      '<path d="' + WAX_INNER + '" fill="none" stroke="#4c0d16" stroke-width="2.2" opacity=".55"/>' +
      '<path d="' + ticks(50, 50, 24, 27.5, 28) + '" stroke="#4c0d16" stroke-width="1.5" opacity=".4" stroke-linecap="round"/>' +
      '<g fill="#450b13" opacity=".92">' +
        '<circle cx="50" cy="43" r="7.8"/>' +
        '<path d="M46.2 48 L43.2 64 Q50 67 56.8 64 L53.8 48Z"/>' +
      '</g>' +

      // the break, drawn only on a note that has been forced at
      (o.cracked
        ? '<path d="M50 12 L46 30 L54 40 L44 52 L52 66 L45 88" fill="none" stroke="#2a0a10" ' +
          'stroke-width="2.2" stroke-linejoin="round" opacity=".8"/>'
        : '') +
    '</svg>';
  }

  /* -------------------------------------------------------------- glyphs */

  const P = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    key: '<circle cx="8.5" cy="15.5" r="3.5"/><path d="M11 13 19.5 4.5M17 7l2.5 2.5M14.5 9.5 17 12"/>',
    lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14v2.5"/>',
    unlock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 7.7-1.5"/><path d="M12 14v2.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M4 4.5 20 19.5"/><path d="M9.6 6.1A9.9 9.9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 3.9M6.4 8.2A17.4 17.4 0 0 0 2.5 12S6 18.5 12 18.5a9.7 9.7 0 0 0 3.3-.6"/><path d="M10 10a3 3 0 0 0 4 4"/>',
    log: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4h4"/><path d="M12 8v4.4l3 1.8"/>',
    folder: '<path d="M3.5 7.2a1.7 1.7 0 0 1 1.7-1.7h3.4l2 2.4h8.2a1.7 1.7 0 0 1 1.7 1.7v8.9a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7Z"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9"/>',
    trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5"/><path d="M10.5 10v7M13.5 10v7"/>',
    check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
    back: '<path d="M19 12H5.5M11 5.5 4.5 12l6.5 6.5"/>',
    fwd: '<path d="M5 12h13.5M13 5.5 19.5 12 13 18.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    pencil: '<path d="M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10Z"/><path d="M14.5 6.5l3 3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3.5 21.5 20h-19Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.4" r=".9" fill="currentColor" stroke="none"/>',
    user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>',
    pc: '<rect x="3" y="5" width="18" height="11.5" rx="1.8"/><path d="M8.5 20h7M12 16.5V20"/>',
    save: '<path d="M5 4.5h11L19.5 8v11.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"/><path d="M8 4.5v5h7v-5"/><rect x="7.5" y="13" width="9" height="7.5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 4v4.5H16"/>',
    external: '<path d="M14 4.5h5.5V10"/><path d="M19 5 12 12"/><path d="M18.5 14v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 6 5.5h4.5"/>',
    shield: '<path d="M12 3.5 19.5 6v6c0 4.3-3.1 7.4-7.5 8.5C7.6 19.4 4.5 16.3 4.5 12V6Z"/><path d="M9 12l2.2 2.2L15.4 10"/>',
    note: '<path d="M6 3.5h8.5L19 8v12.5H6Z"/><path d="M14 3.5V8h4.6"/><path d="M9 12h7M9 15.5h5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.3 2"/>',
    cam: '<path d="M4.5 8h2.2l1.3-2h7.9l1.3 2h2.3a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-8A1.5 1.5 0 0 1 4.5 8Z"/><circle cx="12" cy="13" r="3.6"/>',
    camOff: '<path d="M4 4.5 20 20"/><path d="M8.4 6H16l1.3 2h2.2A1.5 1.5 0 0 1 21 9.5v8c0 .2 0 .4-.1.6M17 17H4.5A1.5 1.5 0 0 1 3 15.5v-6A1.5 1.5 0 0 1 4.5 8h1.6"/><path d="M9.6 10.6A3.6 3.6 0 0 0 14.4 15.4"/>',
    dots: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  };

  function icon(name, size) {
    const body = P[name];
    if (!body) return '';
    const s = size || 18;
    return '<svg class="ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + body + '</svg>';
  }

  /* A small flat seal for list rows - reads at 22px where the full mark does not. */
  function sealChip(size, cracked) {
    const id = 'chip' + (++uid);
    const s = size || 22;
    return '<svg class="chip-seal' + (cracked ? ' is-cracked' : '') + '" width="' + s + '" height="' + s + '" viewBox="0 0 100 100" aria-hidden="true">' +
      '<defs><radialGradient id="' + id + '" cx="34%" cy="28%" r="78%">' +
        '<stop offset="0%" stop-color="#d8474f"/><stop offset="45%" stop-color="#b02734"/>' +
        '<stop offset="100%" stop-color="#5e111c"/></radialGradient></defs>' +
      '<path d="' + WAX + '" fill="url(#' + id + ')"/>' +
      '<path d="' + WAX_INNER + '" fill="none" stroke="#4c0d16" stroke-opacity=".5" stroke-width="2.6"/>' +
      '<g fill="#450b13" opacity=".92"><circle cx="50" cy="43" r="8.4"/>' +
      '<path d="M46 48 L43 64 Q50 67 57 64 L54 48Z"/></g>' +
      (cracked ? '<path d="M50 10 L45 31 L55 41 L43 53 L52 67 L44 90" fill="none" stroke="#1b0509" stroke-width="2.6" opacity=".75"/>' : '') +
      '</svg>';
  }

  global.ICONS = { icon: icon, sealMark: sealMark, sealChip: sealChip, blobPath: blobPath };
})(window);
