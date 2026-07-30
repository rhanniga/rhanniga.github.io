// @ts-check
/**
 * Grapheme segmentation and safe localStorage.
 *
 * Grapheme-awareness matters because the line editor stores the input line as
 * an array of graphemes and renders the character *under* the cursor as its own
 * span. Splitting by code unit or code point would bisect emoji and combining
 * marks.
 */

/** @type {Intl.Segmenter | null} */
let segmenter = null;
try {
  segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
} catch {
  segmenter = null; // pre-Segmenter engines fall back to code points
}

/**
 * Split a string into user-perceived characters.
 * @param {string} s
 * @returns {string[]}
 */
export function graphemes(s) {
  if (!s) return [];
  if (segmenter) {
    const out = [];
    for (const { segment } of segmenter.segment(s)) out.push(segment);
    return out;
  }
  return Array.from(s); // code points: better than code units, worse than graphemes
}

/**
 * Column width of a string, in terminal cells.
 *
 * Deliberately counts one cell per grapheme. That is wrong for CJK and emoji
 * (which are double-width) but this site's content is ASCII, and a real
 * wcwidth table is ~200 lines for no benefit here. If wide characters ever
 * enter resume.json, this is the function to fix.
 * @param {string} s
 * @returns {number}
 */
export function width(s) {
  return graphemes(s).length;
}

/* ── localStorage ────────────────────────────────────────────────────────
 * Every access is guarded: Safari in private mode throws on read AND write,
 * and a quota-exceeded write throws too. Losing persistence is always
 * acceptable here; throwing is not. */

const PREFIX = "hannigan.sh:";

/**
 * @param {string} key
 * @param {string | null} [fallback]
 * @returns {string | null}
 */
export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @returns {boolean} whether it actually persisted
 */
export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/**
 * Clamp a number into an inclusive range.
 * @param {number} lo @param {number} n @param {number} hi
 */
export function clamp(lo, n, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}
