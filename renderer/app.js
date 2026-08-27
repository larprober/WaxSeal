'use strict';
/*
 * Waxseal - the window.
 *
 * Two states worth keeping straight: the shelf, which anyone on this PC can
 * look at (names only), and an opened note, which exists only while the main
 * process is still holding a session for it.
 */

const api = window.waxseal;
const { icon, sealMark, sealChip } = window.ICONS;

const $ = (sel, root) => (root || document).querySelector(sel);
const screenEl = $('#screen');
const modalsEl = $('#modals');
const toastsEl = $('#toasts');

const state = {
  dir: '',
  who: { user: '', host: '' },
  idleMinutes: 15,
  rows: [],
  query: '',
  open: null,        // { session, file, info, text, log, dirty, tab, filter }
  drafts: new Map(), // file -> unsaved text kept across an idle relock
  shotCache: new Map(), // photo id -> decrypted data URL, so it is fetched once
};

/* ------------------------------------------------------------- utilities */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function on(root, sel, ev, fn) {
  root.querySelectorAll(sel).forEach((node) => node.addEventListener(ev, fn));
}

function bytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateOf(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + (sameYear ? '' : ' ' + d.getFullYear());
}

function clockOf(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}

function toast(message, tone) {
  const node = el('<div class="toast ' + (tone || 'ok') + '">' +
    icon(tone === 'bad' ? 'alert' : 'check', 16) + '<span>' + esc(message) + '</span></div>');
  toastsEl.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, 2400);
}

// Every call goes through here so a thrown main-process error surfaces once,
// in one voice, instead of being swallowed into a dead button.
async function ask(fn, arg) {
  const res = await fn(arg);
  if (!res || !res.ok) {
    const err = new Error((res && res.error) || 'Something went wrong.');
    err.code = res && res.code;
    throw err;
  }
  return res;
}

/* ---------------------------------------------------------------- modals */

function closeModal() {
  disarmCamera();
  const veil = modalsEl.firstElementChild;
  if (veil) veil.remove();
  document.removeEventListener('keydown', escClose, true);
}

/* --------------------------------------------------------------- camera */

// One live capture at a time, started when the unlock dialog opens so the
// sensor is warm by the time a password is submitted, and stopped the moment
// the dialog closes. Everything here fails soft: no camera just means no photo.
let camera = null;

async function armCamera() {
  disarmCamera();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play().catch(() => {});
    camera = { stream: stream, video: video };
    return video;
  } catch (e) {
    camera = null;
    return null;
  }
}

// A downscaled JPEG as base64, or null if the sensor has no frame yet.
function grabFrame() {
  if (!camera || !camera.video || !camera.video.videoWidth) return null;
  const v = camera.video;
  const w = 320;
  const h = Math.max(1, Math.round((320 * v.videoHeight) / v.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(v, 0, 0, w, h);
  try {
    return canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
  } catch (e) {
    return null;
  }
}

function disarmCamera() {
  if (camera && camera.stream) {
    camera.stream.getTracks().forEach((t) => t.stop());
  }
  camera = null;
}

function escClose(e) {
  if (e.key === 'Escape') {
    const veil = modalsEl.firstElementChild;
    if (veil && veil.dataset.locked !== 'yes') closeModal();
  }
}

function showModal(node, opts) {
  closeModal();
  const veil = el('<div class="veil"></div>');
  if (opts && opts.locked) veil.dataset.locked = 'yes';
  veil.appendChild(node);
  veil.addEventListener('mousedown', (e) => {
    if (e.target === veil && !(opts && opts.locked)) closeModal();
  });
  modalsEl.appendChild(veil);
  document.addEventListener('keydown', escClose, true);
  const first = node.querySelector('input, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return node;
}

function passwordField(label, placeholder) {
  return '<div class="field"><label>' + esc(label) + '</label>' +
    '<div class="pw-wrap">' +
      '<input class="input pw" type="password" spellcheck="false" autocomplete="off" placeholder="' + esc(placeholder || '') + '" />' +
      '<button class="pw-peek" type="button" title="Show password">' + icon('eye', 17) + '</button>' +
    '</div></div>';
}

function wirePeek(root) {
  on(root, '.pw-peek', 'click', (e) => {
    const btn = e.currentTarget;
    const input = btn.parentElement.querySelector('.pw');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.innerHTML = icon(show ? 'eyeOff' : 'eye', 17);
    input.focus();
  });
}

/* Length first, then variety - and say why, rather than just colouring bars. */
function strength(pw) {
  if (!pw) return { score: 0, note: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^\w\s]/.test(pw)) score++;
  if (pw.length >= 20) score = 4;
  if (pw.length < 6) score = Math.min(score, 1);
  const notes = [
    'Too short to hold anything shut.',
    'Weak. A few words strung together beat a short password.',
    'Fair. Longer is worth more than stranger.',
    'Strong.',
    'Very strong.',
  ];
  return { score: score, note: notes[score] };
}

function wireMeter(root) {
  const input = root.querySelector('.pw');
  const meter = root.querySelector('.meter');
  const note = root.querySelector('.meter-note');
  if (!input || !meter) return;
  input.addEventListener('input', () => {
    const s = strength(input.value);
    meter.className = 'meter s' + s.score;
    note.textContent = s.note;
  });
}

/* ----------------------------------------------------------------- shelf */

async function refresh() {
  const res = await ask(api.shelf.list);
  state.dir = res.dir;
  state.rows = res.rows;
}

function matches(row) {
  const q = state.query.trim().toLowerCase();
  return !q || row.name.toLowerCase().includes(q) || row.filename.toLowerCase().includes(q);
}

function cardFor(row) {
  if (!row.sealed) {
    return '<div class="card plain" title="' + esc(row.problem || '') + '">' +
      '<div class="plain-glyph">' + icon('note', 24) + '</div>' +
      '<div class="body"><div class="name">' + esc(row.name) + '</div>' +
      '<div class="meta">Plain text &mdash; anyone can read this one</div>' +
      '<div class="tags"><span class="tag">' + icon('alert', 13) + 'Not sealed</span></div></div></div>';
  }

  const wrongish = row.attempts > 3;
  const tags = ['<span class="tag tag-wax">' + icon('lock', 13) + 'Sealed</span>'];
  if (row.attempts > 0) {
    tags.push('<span class="tag' + (wrongish ? ' tag-brass' : '') + '">' + icon('log', 13) +
      row.attempts + (row.attempts === 1 ? ' record' : ' records') + '</span>');
  }
  if (row.elsewhere) tags.push('<span class="tag">' + icon('external', 13) + 'Elsewhere</span>');

  return '<button class="card" data-file="' + esc(row.file) + '">' +
    sealChip(38, wrongish) +
    '<div class="body">' +
      '<div class="name">' + esc(row.name) + '</div>' +
      '<div class="meta"><span>Sealed ' + dateOf(row.sealedAt) + '</span>' +
        '<i class="dot"></i><span>' + bytes(row.bytes) + '</span></div>' +
      (row.updatedAt > row.sealedAt + 60000
        ? '<div class="meta sub">Last touched ' + ago(row.updatedAt) + '</div>' : '') +
      '<div class="tags">' + tags.join('') + '</div>' +
    '</div></button>';
}

function renderShelf() {
  state.open = null;
  const visible = state.rows.filter(matches);
  const sealedCount = state.rows.filter((r) => r.sealed).length;

  const body = visible.length
    ? '<div class="grid">' + visible.map(cardFor).join('') + '</div>'
    : (state.query
        ? '<div class="empty"><h2>Nothing by that name</h2><p>No note on this shelf matches &ldquo;' + esc(state.query) + '&rdquo;.</p></div>'
        : '<div class="empty">' + sealMark(96) +
          '<h2>The shelf is empty</h2>' +
          '<p>A sealed note is an ordinary .txt file. Its name stays readable to anyone using this PC; ' +
          'the writing inside opens only with the password &mdash; and every attempt at it is recorded in the file itself.</p>' +
          '<button class="btn btn-wax" id="first-note">' + icon('plus', 17) + 'Seal your first note</button></div>');

  const view = el('<div class="screen"><div class="wrap">' +
    '<div class="shelf-head">' +
      '<h1>The shelf<em>' + sealedCount + (sealedCount === 1 ? ' note' : ' notes') + '</em></h1>' +
      '<div class="search">' + icon('search', 16) +
        '<input class="input" id="q" type="search" placeholder="Search names" value="' + esc(state.query) + '" />' +
      '</div>' +
      '<button class="btn" id="add-existing" title="Open a sealed note kept somewhere else">' + icon('external', 17) + '</button>' +
      '<button class="btn btn-wax" id="new-note">' + icon('plus', 17) + 'New note</button>' +
    '</div>' +
    '<div class="folderbar">' + icon('folder', 16) +
      '<span class="path">' + esc(state.dir) + '</span>' +
      '<button class="btn" id="reveal">Open folder</button>' +
      '<button class="btn" id="change-folder">Change</button>' +
    '</div>' + body +
  '</div></div>');

  const q = $('#q', view);
  q.addEventListener('input', () => {
    state.query = q.value;
    const at = q.selectionStart;
    renderShelf();
    const next = $('#q');
    next.focus();
    next.setSelectionRange(at, at);
  });

  on(view, '.card[data-file]', 'click', (e) => {
    const file = e.currentTarget.dataset.file;
    askPassword(state.rows.find((r) => r.file === file));
  });

  const newNote = $('#new-note', view);
  if (newNote) newNote.addEventListener('click', composeNote);
  const first = $('#first-note', view);
  if (first) first.addEventListener('click', composeNote);

  $('#reveal', view).addEventListener('click', () => api.shelf.reveal({}));
  $('#change-folder', view).addEventListener('click', async () => {
    const res = await ask(api.shelf.chooseFolder);
    if (res.changed) { await refresh(); renderShelf(); toast('Shelf folder changed'); }
  });
  $('#add-existing', view).addEventListener('click', async () => {
    try {
      const res = await ask(api.shelf.addExisting);
      if (!res.added) return;
      await refresh();
      renderShelf();
      askPassword(state.rows.find((r) => r.file === res.file));
    } catch (e) {
      toast(e.message, 'bad');
    }
  });

  screenEl.replaceChildren(view);
}

/* --------------------------------------------------------------- compose */

function composeNote() {
  const sheet = el('<div class="sheet wide">' +
    '<header>' + sealMark(66) +
      '<h3>Seal a new note</h3>' +
      '<p>The name goes on the outside where anyone can read it. Everything else goes under the wax.</p>' +
    '</header>' +
    '<div class="field"><label>Name &mdash; visible to everyone</label>' +
      '<input class="input" id="c-name" maxlength="80" placeholder="Reading list, Bank stuff, Letter to myself…" /></div>' +
    passwordField('Password — needed to read it', 'Choose something long') +
    '<div class="meter"><i></i><i></i><i></i><i></i></div><div class="meter-note"></div>' +
    '<div class="field gap"><label>Confirm password</label>' +
      '<input class="input" id="c-confirm" type="password" autocomplete="off" /></div>' +
    '<div class="field"><label>The letter &mdash; hidden</label>' +
      '<textarea class="input" id="c-text" rows="6" placeholder="Write it here."></textarea></div>' +
    '<div class="watched">' + icon('shield', 16) +
      '<span>There is no way to recover this password. If it is lost, the note is lost with it.</span></div>' +
    '<div class="err" id="c-err"></div>' +
    '<div class="row"><button class="btn" id="c-cancel">Cancel</button>' +
      '<button class="btn btn-wax" id="c-go">' + icon('lock', 17) + 'Seal it</button></div>' +
  '</div>');

  wirePeek(sheet);
  wireMeter(sheet);

  const err = $('#c-err', sheet);
  const go = $('#c-go', sheet);

  async function submit() {
    const name = $('#c-name', sheet).value.trim();
    const pw = $('.pw', sheet).value;
    const confirm = $('#c-confirm', sheet).value;
    err.textContent = '';

    if (!name) return fail('Give the note a name.');
    if (!pw) return fail('Choose a password.');
    if (pw !== confirm) return fail('The two passwords are not the same.');
    if (pw.length < 4) return fail('That password is too short to be worth anything.');

    go.disabled = true;
    go.innerHTML = 'Pouring the wax…';
    try {
      const res = await ask(api.note.create, { name: name, password: pw, text: $('#c-text', sheet).value });
      closeModal();
      await refresh();
      renderShelf();
      toast('“' + res.info.name + '” is sealed');
    } catch (e) {
      go.disabled = false;
      go.innerHTML = icon('lock', 17) + 'Seal it';
      fail(e.message);
    }
  }

  function fail(message) {
    err.innerHTML = icon('alert', 15) + '<span>' + esc(message) + '</span>';
    sheet.classList.remove('shake');
    void sheet.offsetWidth;
    sheet.classList.add('shake');
  }

  $('#c-cancel', sheet).addEventListener('click', closeModal);
  go.addEventListener('click', submit);
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id !== 'c-text') submit();
  });

  showModal(sheet);
}

/* ---------------------------------------------------------------- unlock */

function askPassword(row, opts) {
  if (!row) return;
  const o = opts || {};
  const draft = state.drafts.get(row.file);

  const sheet = el('<div class="sheet">' +
    '<header>' + sealMark(78) +
      '<h3>' + esc(row.name) + '</h3>' +
      '<p>Sealed ' + dateOf(row.sealedAt) + '.</p>' +
    '</header>' +
    (draft ? '<div class="watched">' + icon('save', 16) +
      '<span>Your unsaved edits from before are still here. Unlock to save them.</span></div>' : '') +
    passwordField('Password', 'Enter the password') +
    '<div class="err" id="u-err"></div>' +
    '<div class="row"><button class="btn" id="u-cancel">Back</button>' +
      '<button class="btn btn-wax" id="u-go">' + icon('key', 17) + 'Open</button></div>' +
  '</div>');

  wirePeek(sheet);
  const err = $('#u-err', sheet);
  const go = $('#u-go', sheet);
  const input = $('.pw', sheet);

  async function submit() {
    if (!input.value) return;
    go.disabled = true;
    go.innerHTML = 'Checking…';
    err.textContent = '';
    try {
      const photo = grabFrame();
      const res = await ask(api.note.unlock, { file: row.file, password: input.value, photo: photo });
      closeModal();
      state.open = {
        session: res.session,
        file: row.file,
        info: res.info,
        pages: FLOW.split(draft != null ? draft : res.text),
        page: 0,
        savedWhole: FLOW.whole(FLOW.split(res.text)),
        log: res.log,
        dirty: false,
        tab: o.tab || 'letter',
        filter: 'all',
        logPage: 0,
      };
      state.shotCache.clear();
      state.drafts.delete(row.file);
      renderReader();
      if (draft != null) toast('Unsaved edits restored — save when ready');
    } catch (e) {
      go.disabled = false;
      go.innerHTML = icon('key', 17) + 'Open';
      err.innerHTML = icon('alert', 15) + '<span>' + esc(
        e.code === 'WRONG_PASSWORD' ? 'Wrong password.' : e.message
      ) + '</span>';
      sheet.classList.remove('shake');
      void sheet.offsetWidth;
      sheet.classList.add('shake');
      input.select();
      // The attempt count on the shelf just moved.
      refresh().catch(() => {});
    }
  }

  $('#u-cancel', sheet).addEventListener('click', closeModal);
  go.addEventListener('click', submit);
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  showModal(sheet);

  // Warm the camera up now, after the modal is on screen, so a frame is ready
  // by the time anyone finishes typing. Nothing on screen announces it. showModal
  // has already closed any prior dialog, so this stream is the only one alive.
  armCamera().then(() => {
    if (!modalsEl.contains(sheet)) disarmCamera();   // dialog closed while arming
  });
}

/* ---------------------------------------------------------------- reader */

const KINDS = {
  sealed: { label: 'Note sealed', tone: 'info', glyph: 'lock' },
  opened: { label: 'Opened with the right password', tone: 'good', glyph: 'unlock' },
  'wrong-password': { label: 'Wrong password', tone: 'bad', glyph: 'alert' },
  edited: { label: 'Letter edited', tone: 'info', glyph: 'pencil' },
  renamed: { label: 'Renamed', tone: 'info', glyph: 'pencil' },
  'password-changed': { label: 'Password changed', tone: 'info', glyph: 'key' },
  unreadable: { label: 'Damaged record', tone: 'bad', glyph: 'alert' },
};

const FILTERS = {
  all: () => true,
  wrong: (e) => e.kind === 'wrong-password',
  opens: (e) => e.kind === 'opened',
  photos: (e) => !!e.shot,
  changes: (e) => ['edited', 'renamed', 'password-changed', 'sealed'].includes(e.kind),
};

// Decrypt a photo once and remember it, so re-opening the log or a lightbox is
// instant and the private key is only asked to work the first time.
async function loadShot(id) {
  if (state.shotCache.has(id)) return state.shotCache.get(id);
  const res = await ask(api.note.shot, { session: state.open.session, id: id });
  state.shotCache.set(id, res.dataUrl);
  return res.dataUrl;
}

function logRow(entry) {
  const kind = KINDS[entry.kind] || { label: entry.kind, tone: 'info', glyph: 'dots' };
  const typed = entry.kind === 'wrong-password' && entry.typed != null
    ? '<div class="typed hidden-value" data-typed="' + esc(entry.typed) + '">' +
        icon('eye', 13) + 'show what was typed</div>'
    : '';
  const shot = entry.shot
    ? '<button class="shot-thumb" data-shot="' + esc(entry.shot) + '" title="View the photo">' +
        icon('cam', 13) + '<span>photo</span></button>'
    : '';
  return '<div class="log-row ' + kind.tone + '">' +
    '<div class="glyph">' + icon(kind.glyph, 15) + '</div>' +
    '<div><div class="what">' + esc(kind.label) + (entry.to ? ' to “' + esc(entry.to) + '”' : '') + '</div>' +
      '<div class="who">' + icon('user', 12) + esc(entry.user || 'unknown') +
        icon('pc', 12) + esc(entry.host || 'unknown') + '</div>' +
      (typed || shot ? '<div class="row-extras">' + typed + shot + '</div>' : '') +
    '</div>' +
    '<div class="when">' + (entry.at ? esc(ago(entry.at)) + '<small>' + dateOf(entry.at) + ' ' + clockOf(entry.at) + '</small>' : '—') + '</div>' +
  '</div>';
}

// A lightbox for one photo, loaded on open. Prev/next step through the whole
// run of captured faces, newest first.
function openShot(entry, gallery) {
  const list = gallery || [entry];
  let at = Math.max(0, list.findIndex((e) => e.shot === entry.shot));

  const sheet = el('<div class="sheet wide shot-view">' +
    '<div class="shot-stage" id="s-stage"><div class="shot-loading">' + icon('cam', 30) + '<span>Developing…</span></div></div>' +
    '<div class="shot-meta"><div id="s-what"></div>' +
      '<div class="shot-nav">' +
        '<button class="btn btn-quiet btn-icon" id="s-prev" title="Newer">' + icon('back', 17) + '</button>' +
        '<span id="s-count"></span>' +
        '<button class="btn btn-quiet btn-icon" id="s-next" title="Older">' + icon('fwd', 17) + '</button>' +
      '</div></div>' +
    '<div class="row"><button class="btn" id="s-close">Close</button></div>' +
  '</div>');

  const stage = $('#s-stage', sheet);
  async function paint() {
    const e = list[at];
    $('#s-count', sheet).textContent = (at + 1) + ' of ' + list.length;
    $('#s-prev', sheet).disabled = at <= 0;
    $('#s-next', sheet).disabled = at >= list.length - 1;
    const k = KINDS[e.kind] || { label: e.kind };
    $('#s-what', sheet).innerHTML = '<b>' + esc(k.label) + '</b><span>' +
      esc(e.user || 'unknown') + ' on ' + esc(e.host || 'unknown') +
      (e.at ? ' &middot; ' + dateOf(e.at) + ' ' + clockOf(e.at) : '') + '</span>';
    stage.classList.remove('ready');
    stage.innerHTML = '<div class="shot-loading">' + icon('cam', 30) + '<span>Developing…</span></div>';
    try {
      const url = await loadShot(e.shot);
      if (!modalsEl.contains(sheet) || list[at] !== e) return;
      const img = new Image();
      img.src = url;
      img.alt = 'Photo taken at the lock';
      stage.replaceChildren(img);
      stage.classList.add('ready');
    } catch (err) {
      stage.innerHTML = '<div class="shot-loading bad">' + icon('alert', 26) + '<span>' + esc(err.message) + '</span></div>';
      handleSessionLoss(err);
    }
  }

  $('#s-prev', sheet).addEventListener('click', () => { if (at > 0) { at--; paint(); } });
  $('#s-next', sheet).addEventListener('click', () => { if (at < list.length - 1) { at++; paint(); } });
  $('#s-close', sheet).addEventListener('click', closeModal);
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') $('#s-prev', sheet).click();
    if (e.key === 'ArrowRight') $('#s-next', sheet).click();
  });
  showModal(sheet);
  paint();
}

function pagerBar(index, count, what) {
  const back = '<button class="btn btn-quiet btn-icon" data-step="-1" title="Previous page"' +
    (index <= 0 ? ' disabled' : '') + '>' + icon('back', 17) + '</button>';
  const fwd = '<button class="btn btn-quiet btn-icon" data-step="1" title="Next page"' +
    (index >= count - 1 ? ' disabled' : '') + '>' + icon('fwd', 17) + '</button>';
  return '<div class="pager">' + back +
    '<span class="page-count">' + esc(what) + ' ' + (index + 1) + ' of ' + count + '</span>' +
    fwd + '</div>';
}

const LOG_PER_PAGE = 7;

function logPane() {
  const o = state.open;
  const log = o.log.slice().reverse();
  const wrong = log.filter((e) => e.kind === 'wrong-password');
  const opens = log.filter((e) => e.kind === 'opened');
  const withShot = log.filter((e) => e.shot);
  const people = new Set(log.map((e) => (e.user || '?') + '@' + (e.host || '?')));
  const lastWrong = wrong[0];
  const shown = log.filter(FILTERS[o.filter] || FILTERS.all);

  const pages = Math.max(1, Math.ceil(shown.length / LOG_PER_PAGE));
  o.logPage = Math.min(o.logPage || 0, pages - 1);
  const slice = shown.slice(o.logPage * LOG_PER_PAGE, (o.logPage + 1) * LOG_PER_PAGE);

  const chip = (key, label) =>
    '<button class="chip' + (o.filter === key ? ' on' : '') + '" data-filter="' + key + '">' + label + '</button>';

  // The faces caught on a wrong password, newest first, up to a row of six.
  const faces = wrong.filter((e) => e.shot).slice(0, 6);
  const strip = faces.length
    ? '<div class="faces"><div class="faces-head">' + icon('cam', 15) +
        'Faces at the lock<em>tap to enlarge</em></div><div class="faces-row" id="faces">' +
        faces.map((e) => '<button class="face" data-shot="' + esc(e.shot) + '">' +
          '<span class="face-when">' + esc(ago(e.at)) + '</span></button>').join('') +
      '</div></div>'
    : '';

  return '<div class="pane-inner">' +
    '<div class="log-summary">' +
      '<div class="stat"><b>' + log.length + '</b><span>records</span></div>' +
      '<div class="stat' + (wrong.length ? ' warn' : '') + '"><b>' + wrong.length + '</b><span>wrong passwords</span></div>' +
      '<div class="stat"><b>' + opens.length + '</b><span>times opened</span></div>' +
      '<div class="stat"><b>' + withShot.length + '</b><span>' + (withShot.length === 1 ? 'photo' : 'photos') + '</span></div>' +
    '</div>' +
    (lastWrong
      ? '<div class="watched tight">' + icon('alert', 16) +
        '<span>Last wrong password ' + esc(ago(lastWrong.at)) + ' by <b>' + esc(lastWrong.user) +
        '</b> on ' + esc(lastWrong.host) + '.</span></div>'
      : '') +
    strip +
    '<div class="filters">' + chip('all', 'Everything') + chip('wrong', 'Wrong passwords') +
      chip('opens', 'Opens') + chip('photos', 'With photo') + chip('changes', 'Changes') + '</div>' +
    (slice.length
      ? '<div class="log-list">' + slice.map(logRow).join('') + '</div>'
      : '<div class="log-empty">Nothing under this filter yet.</div>') +
    (pages > 1 ? pagerBar(o.logPage, pages, 'Page') : '') +
  '</div>';
}

function letterPane() {
  const o = state.open;
  return '<div class="book">' +
    '<textarea class="letter" id="letter" spellcheck="true" placeholder="This page is empty."></textarea>' +
    '<div class="letter-bar">' +
      '<span class="saved-flag" id="flag"></span>' +
      '<span class="spacer"></span>' +
      pagerBar(o.page, o.pages.length, 'Page') +
      '<span class="spacer"></span>' +
      '<button class="btn" id="copy">' + icon('copy', 16) + 'Copy all</button>' +
      '<button class="btn btn-wax" id="save">' + icon('save', 16) + 'Save</button>' +
    '</div>' +
    '<div class="danger-zone">' +
      '<button class="btn" id="repass">' + icon('key', 16) + 'Change password</button>' +
      '<button class="btn" id="lock">' + icon('lock', 16) + 'Lock now</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-danger" id="destroy">' + icon('trash', 16) + 'Delete note</button>' +
    '</div>' +
  '</div>';
}

function renderReader() {
  const o = state.open;
  if (!o) return renderShelf();
  const wrongCount = o.log.filter((e) => e.kind === 'wrong-password').length;

  const view = el('<div class="reader">' +
    '<div class="reader-head">' +
      '<button class="btn btn-quiet btn-icon" id="back" title="Back to the shelf">' + icon('back', 18) + '</button>' +
      '<div class="title"><h2><span id="name">' + esc(o.info.name) + '</span>' +
        '<button class="btn btn-quiet btn-icon" id="rename" title="Rename">' + icon('pencil', 15) + '</button></h2>' +
        '<div class="sub">' + esc(o.info.filename) + ' &middot; sealed ' + dateOf(o.info.sealedAt) +
        ' &middot; relocks after ' + state.idleMinutes + ' idle minutes</div></div>' +
      '<button class="btn" id="reveal-one" title="Show the file in Explorer">' + icon('folder', 16) + '</button>' +
    '</div>' +
    '<div class="reader-stack">' +
      '<div class="tabs">' +
        '<button class="tab' + (o.tab === 'letter' ? ' on' : '') + '" data-tab="letter">' + icon('note', 16) + 'The letter' +
          (o.pages.length > 1 ? '<span class="count">' + o.pages.length + '</span>' : '') + '</button>' +
        '<button class="tab' + (o.tab === 'log' ? ' on' : '') + '" data-tab="log">' + icon('log', 16) + 'Seal log' +
          '<span class="count' + (wrongCount ? ' hot' : '') + '">' + o.log.length + '</span></button>' +
      '</div>' +
      '<div class="pane' + (o.tab === 'letter' ? ' pane-book' : '') + '" id="pane">' +
        (o.tab === 'letter' ? letterPane() : logPane()) + '</div>' +
    '</div>' +
  '</div>');

  $('#back', view).addEventListener('click', leaveReader);
  $('#reveal-one', view).addEventListener('click', () => api.shelf.reveal({ file: o.file }));
  $('#rename', view).addEventListener('click', beginRename);
  on(view, '.tab', 'click', (e) => {
    o.tab = e.currentTarget.dataset.tab;
    renderReader();
  });

  screenEl.replaceChildren(view);
  wirePane();
}

/* ------------------------------------------------------------- the book */

let flow = null;

function wirePane() {
  const o = state.open;
  const pane = $('#pane');
  if (flow) { flow.destroy(); flow = null; }
  if (!pane) return;
  if (o.tab === 'letter') wireLetter(pane);
  else wireLog(pane);
}

function wireLog(pane) {
  const o = state.open;
  const again = () => { pane.innerHTML = logPane(); wireLog(pane); };

  on(pane, '.chip', 'click', (e) => {
    o.filter = e.currentTarget.dataset.filter;
    o.logPage = 0;
    again();
  });
  on(pane, '.pager .btn', 'click', (e) => {
    o.logPage = Math.max(0, (o.logPage || 0) + Number(e.currentTarget.dataset.step));
    again();
  });
  // A wrong guess is somebody's password somewhere. It stays covered until asked for.
  on(pane, '.typed', 'click', (e) => {
    const node = e.currentTarget;
    if (!node.classList.contains('hidden-value')) return;
    node.classList.remove('hidden-value');
    node.innerHTML = icon('key', 13) + '<span>' + esc(node.dataset.typed) + '</span>';
  });

  // The whole run of faces, newest first, so the lightbox can page through them.
  const gallery = o.log.slice().reverse().filter((e) => e.shot);
  const openById = (id) => {
    const entry = gallery.find((e) => e.shot === id);
    if (entry) openShot(entry, gallery);
  };
  on(pane, '.shot-thumb', 'click', (e) => { e.stopPropagation(); openById(e.currentTarget.dataset.shot); });
  on(pane, '.face', 'click', (e) => openById(e.currentTarget.dataset.shot));

  // Fill the face strip with the actual thumbnails as they decrypt.
  pane.querySelectorAll('.face[data-shot]').forEach((node) => {
    loadShot(node.dataset.shot).then((url) => {
      node.style.backgroundImage = 'url("' + url + '")';
      node.classList.add('loaded');
    }).catch(() => { node.classList.add('failed'); });
  });
}

function wireLetter(pane) {
  const o = state.open;
  const ta = $('#letter', pane);
  const flag = $('#flag', pane);
  const save = $('#save', pane);
  const label = pane.querySelector('.page-count');
  flow = FLOW.createFlow(ta);

  function mark() {
    o.dirty = FLOW.whole(o.pages) !== o.savedWhole;
    save.disabled = !o.dirty;
    flag.className = 'saved-flag' + (o.dirty ? ' dirty' : '');
    flag.innerHTML = icon(o.dirty ? 'pencil' : 'check', 14) + (o.dirty ? 'Unsaved changes' : 'Saved');
  }

  function arrows() {
    const btns = pane.querySelectorAll('.pager .btn');
    if (btns[0]) btns[0].disabled = o.page <= 0;
    if (btns[1]) btns[1].disabled = o.page >= o.pages.length - 1;
    if (label) label.textContent = 'Page ' + (o.page + 1) + ' of ' + o.pages.length;
    const tabCount = document.querySelector('.tab[data-tab="letter"] .count');
    if (tabCount) tabCount.textContent = o.pages.length;
  }

  function show(index, caret, focus) {
    o.page = Math.max(0, Math.min(o.pages.length - 1, index));
    ta.value = o.pages[o.page];
    arrows();
    if (caret != null) {
      const at = Math.max(0, Math.min(ta.value.length, caret));
      if (focus !== false) ta.focus();
      ta.setSelectionRange(at, at);
    }
  }
  o.show = show;

  // Settle whatever came out of the file into pages that fit this window.
  flow.reflow(o.pages, 0);
  show(o.page, null);
  mark();

  ta.addEventListener('input', () => {
    const caret = ta.selectionStart;
    const here = o.page;
    o.pages[here] = ta.value;
    flow.reflow(o.pages, here);

    // Follow the caret if the words under it were pushed onto a later page.
    let index = here;
    let at = caret;
    while (at > o.pages[index].length && index + 1 < o.pages.length) {
      at -= o.pages[index].length;
      index++;
    }
    show(index, at);
    mark();
    heartbeat();
  });

  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveLetter(); return; }

    const atStart = ta.selectionStart === 0 && ta.selectionEnd === 0;
    const atEnd = ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length;

    // Backspace off the top of a page reaches back into the one before it.
    if (e.key === 'Backspace' && atStart && o.page > 0) {
      e.preventDefault();
      const prev = o.page - 1;
      o.pages[prev] = o.pages[prev].slice(0, -1);
      flow.reflow(o.pages, prev);
      show(prev, o.pages[prev].length);
      mark();
      return;
    }
    if (e.key === 'Delete' && atEnd && o.page < o.pages.length - 1) {
      e.preventDefault();
      const here = o.page;
      o.pages[here + 1] = o.pages[here + 1].slice(1);
      flow.reflow(o.pages, here);
      show(here, ta.value.length);
      mark();
      return;
    }

    if (e.key === 'ArrowLeft' && atStart && o.page > 0) {
      e.preventDefault();
      show(o.page - 1, o.pages[o.page - 1].length);
    }
    if (e.key === 'ArrowRight' && atEnd && o.page < o.pages.length - 1) {
      e.preventDefault();
      show(o.page + 1, 0);
    }
    if (e.key === 'PageUp') { e.preventDefault(); show(o.page - 1, 0); }
    if (e.key === 'PageDown') { e.preventDefault(); show(o.page + 1, 0); }
  });

  on(pane, '.pager .btn', 'click', (e) => {
    show(o.page + Number(e.currentTarget.dataset.step), 0);
  });

  save.addEventListener('click', saveLetter);
  $('#copy', pane).addEventListener('click', async () => {
    await navigator.clipboard.writeText(FLOW.whole(o.pages));
    toast(o.pages.length > 1 ? 'All ' + o.pages.length + ' pages copied' : 'Letter copied to the clipboard');
  });
  $('#lock', pane).addEventListener('click', leaveReader);
  $('#repass', pane).addEventListener('click', changePassword);
  $('#destroy', pane).addEventListener('click', confirmDelete);
}

// A narrower window fits fewer words on a page, so the book is laid out again.
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (!state.open || state.open.tab !== 'letter' || !flow) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.open || !flow || !state.open.show) return;
    flow.reflow(state.open.pages, 0);
    state.open.show(state.open.page, null, false);
  }, 140);
});

function turnPage(step) {
  const o = state.open;
  if (!o) return;
  if (o.tab === 'letter') {
    if (o.show) o.show(o.page + step, null, false);
  } else {
    turnPage.log(step);
  }
}
turnPage.log = function (step) {
  const o = state.open;
  o.logPage = Math.max(0, (o.logPage || 0) + step);
  const pane = $('#pane');
  if (pane) { pane.innerHTML = logPane(); wireLog(pane); }
};

async function saveLetter() {
  const o = state.open;
  if (!o || !o.dirty) return;
  try {
    const res = await ask(api.note.save, { session: o.session, text: FLOW.join(o.pages) });
    o.savedWhole = FLOW.whole(o.pages);
    o.dirty = false;
    o.info = res.info;
    o.log = res.log;
    renderReader();
    toast('Sealed again');
  } catch (e) {
    handleSessionLoss(e);
  }
}

function beginRename() {
  const o = state.open;
  const holder = $('#name').parentElement;
  const input = el('<input class="input rename-input" value="' + esc(o.info.name) + '" maxlength="80" />');
  holder.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!commit || !name || name === o.info.name) return renderReader();
    try {
      const res = await ask(api.note.rename, { session: o.session, name: name });
      o.info = res.info;
      o.file = res.file;
      const log = await ask(api.note.log, { session: o.session });
      o.log = log.log;
      renderReader();
      toast('Renamed');
    } catch (e) {
      handleSessionLoss(e);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function changePassword() {
  const o = state.open;
  const sheet = el('<div class="sheet">' +
    '<header>' + sealMark(66) + '<h3>Change the password</h3>' +
    '<p>The letter and the whole seal log are re-wrapped under the new one. The old password stops working immediately.</p></header>' +
    passwordField('New password', 'Choose something long') +
    '<div class="meter"><i></i><i></i><i></i><i></i></div><div class="meter-note"></div>' +
    '<div class="field gap"><label>Confirm</label>' +
      '<input class="input" id="p-confirm" type="password" autocomplete="off" /></div>' +
    '<div class="err" id="p-err"></div>' +
    '<div class="row"><button class="btn" id="p-cancel">Cancel</button>' +
      '<button class="btn btn-wax" id="p-go">' + icon('key', 17) + 'Change it</button></div></div>');

  wirePeek(sheet);
  wireMeter(sheet);
  const err = $('#p-err', sheet);

  $('#p-cancel', sheet).addEventListener('click', closeModal);
  $('#p-go', sheet).addEventListener('click', async () => {
    const pw = $('.pw', sheet).value;
    if (pw !== $('#p-confirm', sheet).value) {
      err.innerHTML = icon('alert', 15) + '<span>The two passwords are not the same.</span>';
      return;
    }
    if (pw.length < 4) {
      err.innerHTML = icon('alert', 15) + '<span>That password is too short to be worth anything.</span>';
      return;
    }
    try {
      const res = await ask(api.note.changePassword, { session: o.session, password: pw });
      o.info = res.info;
      o.log = res.log;
      closeModal();
      renderReader();
      toast('New password in place');
    } catch (e) {
      closeModal();
      handleSessionLoss(e);
    }
  });
  sheet.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#p-go', sheet).click(); });
  showModal(sheet);
}

function confirmDelete() {
  const o = state.open;
  const sheet = el('<div class="sheet">' +
    '<header><div class="sheet-glyph">' + icon('trash', 26) + '</div>' + '<h3>Delete “' + esc(o.info.name) + '”?</h3>' +
    '<p>The file goes to the Recycle Bin, letter and seal log together.</p></header>' +
    '<div class="row"><button class="btn" id="d-cancel">Keep it</button>' +
      '<button class="btn btn-danger" id="d-go">' + icon('trash', 16) + 'Delete</button></div></div>');

  $('#d-cancel', sheet).addEventListener('click', closeModal);
  $('#d-go', sheet).addEventListener('click', async () => {
    try {
      await ask(api.note.remove, { session: o.session });
      closeModal();
      state.open = null;
      await refresh();
      renderShelf();
      toast('Moved to the Recycle Bin');
    } catch (e) {
      closeModal();
      handleSessionLoss(e);
    }
  });
  showModal(sheet);
}

async function leaveReader() {
  const o = state.open;
  if (!o) return renderShelf();
  if (o.dirty) {
    const keep = await confirmLeave();
    if (keep === 'cancel') return;
    if (keep === 'save') { await saveLetter(); }
  }
  try { await api.note.lock({ session: o.session }); } catch (e) { /* already gone */ }
  state.open = null;
  state.shotCache.clear();
  await refresh();
  renderShelf();
}

function confirmLeave() {
  return new Promise((resolve) => {
    const sheet = el('<div class="sheet">' +
      '<header><div class="sheet-glyph warn">' + icon('alert', 26) + '</div>' + '<h3>Unsaved changes</h3>' +
      '<p>The letter has edits that are not sealed back into the file yet.</p></header>' +
      '<div class="row"><button class="btn" id="l-cancel">Cancel</button>' +
      '<button class="btn" id="l-discard">Discard</button>' +
      '<button class="btn btn-wax" id="l-save">Save</button></div></div>');
    const pick = (v) => { closeModal(); resolve(v); };
    $('#l-cancel', sheet).addEventListener('click', () => pick('cancel'));
    $('#l-discard', sheet).addEventListener('click', () => pick('discard'));
    $('#l-save', sheet).addEventListener('click', () => pick('save'));
    showModal(sheet, { locked: true });
  });
}

/* ------------------------------------------------------- idle and safety */

let lastBeat = 0;
function heartbeat() {
  const o = state.open;
  if (!o) return;
  const now = Date.now();
  if (now - lastBeat < 45000) return;
  lastBeat = now;
  api.note.touch({ session: o.session }).catch(() => {});
}

['mousemove', 'keydown', 'click'].forEach((ev) =>
  document.addEventListener(ev, () => { if (state.open) heartbeat(); }, { passive: true }));

// The main process dropped the keys. Hold on to anything unsaved so the only
// cost of walking away is having to type the password again.
function relock(reason) {
  const o = state.open;
  if (!o) return;
  if (o.dirty) state.drafts.set(o.file, FLOW.join(o.pages));
  const row = { file: o.file, name: o.info.name, sealedAt: o.info.sealedAt, attempts: o.info.attempts };
  state.open = null;
  state.shotCache.clear();
  closeModal();
  refresh().then(renderShelf).catch(() => renderShelf());
  toast(reason, 'bad');
  askPassword(state.rows.find((r) => r.file === row.file) || row);
}

function handleSessionLoss(e) {
  if (e.code === 'NO_SESSION') relock('That note relocked itself');
  else toast(e.message, 'bad');
}

api.onSessionExpired(() => relock('Locked after ' + state.idleMinutes + ' quiet minutes'));

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) e.preventDefault();

  // Arrows turn the page whenever the caret is not the thing being moved.
  if (!state.open || modalsEl.firstElementChild) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); turnPage(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); turnPage(1); }
});

/* ------------------------------------------------------------------ boot */

(async () => {
  $('#brand').innerHTML = sealMark(26);
  try {
    const info = await ask(api.info);
    state.who = info.who;
    state.idleMinutes = info.idleMinutes;
    $('#version').textContent = 'v' + info.version;
    await refresh();
    renderShelf();
  } catch (e) {
    screenEl.replaceChildren(el('<div class="wrap"><div class="empty">' +
      icon('alert', 40) + '<h2>Waxseal could not start</h2><p>' + esc(e.message) + '</p></div></div>'));
  }
})();
