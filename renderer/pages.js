'use strict';
/*
 * Page flow.
 *
 * The letter is one continuous piece of writing that happens to be shown a page
 * at a time. Typing past the bottom of a page pushes the last words onto the
 * next one; deleting pulls them back up. Nothing is inserted into the text to
 * make that work - a page break is only a position, so joining the pages back
 * together returns exactly what was written.
 *
 * Breaks land in front of a word, which leaves the space that preceded it at
 * the end of the previous page where nobody can see it.
 */

(function (global) {
  const SPACE = /\s/;

  // Every position a break is allowed to fall on: the start of a word that
  // follows whitespace, plus the very end of the text.
  function candidates(text) {
    const out = [];
    for (let i = 1; i < text.length; i++) {
      if (SPACE.test(text[i - 1]) && !SPACE.test(text[i])) out.push(i);
    }
    out.push(text.length);
    return out;
  }

  function firstCandidate(text) {
    for (let i = 1; i < text.length; i++) {
      if (SPACE.test(text[i - 1]) && !SPACE.test(text[i])) return i;
    }
    return text.length;
  }

  function createFlow(textarea) {
    const mirror = document.createElement('div');
    mirror.className = 'letter-measure';
    document.body.appendChild(mirror);

    let limit = 0;

    // Match the mirror to the box being typed into, so a measurement means
    // something. Called again whenever the window changes size.
    function resync() {
      const cs = getComputedStyle(textarea);
      const copy = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'textIndent', 'wordSpacing', 'tabSize'];
      for (const k of copy) mirror.style[k] = cs[k];
      mirror.style.boxSizing = 'border-box';
      mirror.style.width = textarea.clientWidth + 'px';
      limit = textarea.clientHeight;
    }

    function fits(text) {
      mirror.textContent = text + '​';
      return mirror.scrollHeight <= limit;
    }

    // Largest prefix of `text` that still fits, chosen from legal break points.
    function cut(text) {
      const pts = candidates(text);
      let lo = 0, hi = pts.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(text.slice(0, pts[mid]))) { best = pts[mid]; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (best > 0) return best;

      // One unbroken run longer than a whole page: break it wherever it lands.
      lo = 1; hi = text.length; best = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(text.slice(0, mid))) { best = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      return best;
    }

    /*
     * Settle pages from `from` onwards: push what overflows down, pull back what
     * the page above has room for. Both directions run so the book closes up
     * again after a deletion instead of leaving half-empty pages behind.
     */
    function reflow(pages, from) {
      if (!pages.length) pages.push('');
      resync();
      if (limit <= 0) return pages;

      for (let i = Math.max(0, from || 0); i < pages.length; i++) {
        let guard = 0;
        while (!fits(pages[i]) && guard++ < 500) {
          const at = cut(pages[i]);
          if (at >= pages[i].length) break;
          const tail = pages[i].slice(at);
          pages[i] = pages[i].slice(0, at);
          if (i + 1 >= pages.length) pages.push('');
          pages[i + 1] = tail + pages[i + 1];
        }

        guard = 0;
        while (i + 1 < pages.length && pages[i + 1].length && guard++ < 5000) {
          const take = pages[i + 1].slice(0, firstCandidate(pages[i + 1]));
          if (!fits(pages[i] + take)) break;
          pages[i] += take;
          pages[i + 1] = pages[i + 1].slice(take.length);
        }
      }

      while (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();
      return pages;
    }

    return { reflow: reflow, fits: fits, resync: resync, destroy: () => mirror.remove() };
  }

  // A page break is stored as a form feed - the character that has meant
  // exactly this since the days of line printers, and still plain text.
  const BREAK = '\f';
  const split = (text) => (text == null ? [''] : String(text).split(BREAK));
  const join = (pages) => pages.join(BREAK);
  const whole = (pages) => pages.join('');

  global.FLOW = { createFlow: createFlow, split: split, join: join, whole: whole, BREAK: BREAK };
})(window);
