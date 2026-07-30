// @ts-check
/**
 * Fixed-width layout over styled chunks.
 *
 * Everything here is pure `(data, cols) => Line[]`. No DOM, no globals -- which
 * is what lets the whole layout be tested under `node --test`, and what lets the
 * screen-reader path render the same data unwrapped.
 */

import { c, sp, len } from "./chunk.js";
import { graphemes } from "../util.js";

/**
 * Glyphs chosen for guaranteed single-cell rendering in every system monospace
 * stack. `•` and `▸` are not reliably single-cell, and a double-width bullet
 * silently breaks every hanging indent.
 *
 * If PixelOperatorMono turns out not to cover U+2500, RULE is the one constant to
 * change -- metrics.probeFont() checks for exactly that.
 */
export const GLYPH = {
  RULE: "─",
  BULLET: "-",
};

/** @typedef {import('./chunk.js').Chunk} Chunk */
/** @typedef {import('./chunk.js').Line} Line */

/**
 * A run of text carrying its source chunk's styling, tagged by role so the
 * wrapper can treat words, whitespace, and hard breaks differently.
 * @typedef {{ chunk: Chunk, kind: 'word' | 'space' | 'break' }} Segment
 */

/**
 * Copy a chunk's styling onto new text. Preserving `href` is the whole reason
 * wrapping has to be chunk-aware: a link that straddles a wrap point must stay a
 * link on both lines.
 * @param {Chunk} src
 * @param {string} t
 * @returns {Chunk}
 */
function restyle(src, t) {
  /** @type {Chunk} */
  const out = { t };
  if (src.c !== undefined) out.c = src.c;
  if (src.href !== undefined) out.href = src.href;
  if (src.ext !== undefined) out.ext = src.ext;
  return out;
}

/**
 * Break a line into words, whitespace runs, and hard breaks.
 * @param {Line} line
 * @returns {Segment[]}
 */
function segment(line) {
  /** @type {Segment[]} */
  const segs = [];
  for (const chunk of line) {
    const byLine = chunk.t.split("\n");
    byLine.forEach((piece, i) => {
      if (i > 0) segs.push({ chunk: restyle(chunk, ""), kind: "break" });
      if (piece === "") return;
      // Split keeping the separators, so whitespace runs survive as their own
      // segments and can be dropped at wrap points but kept elsewhere.
      for (const part of piece.split(/(\s+)/)) {
        if (part === "") continue;
        segs.push({
          chunk: restyle(chunk, part),
          kind: /^\s+$/.test(part) ? "space" : "word",
        });
      }
    });
  }
  return segs;
}

/**
 * One unbreakable unit: a whole word, a whitespace run, or a hard break.
 * @typedef {{ chunks: Chunk[], kind: 'word' | 'space' | 'break', width: number }} Unit
 */

/**
 * Group segments into units, merging adjacent word segments that are not
 * separated by whitespace.
 *
 * This merge is essential and its absence is a subtle bug. highlight() splits
 * `(Python/FastAPI)` into five chunks so it can mark two of them, and without
 * merging, the wrapper treats each as independently breakable and happily emits
 * `(Python/` at the end of one line and `FastAPI)` at the start of the next.
 * Highlighting must not change where text can break.
 *
 * @param {Line} line
 * @returns {Unit[]}
 */
function units(line) {
  /** @type {Unit[]} */
  const out = [];
  for (const seg of segment(line)) {
    const w = graphemes(seg.chunk.t).length;
    const prev = out[out.length - 1];
    if (seg.kind === "word" && prev !== undefined && prev.kind === "word") {
      prev.chunks.push(seg.chunk);
      prev.width += w;
    } else {
      out.push({ chunks: [seg.chunk], kind: seg.kind, width: w });
    }
  }
  return out;
}

/**
 * Greedy word wrap across styled runs.
 *
 * The reason this is the highest-risk function here: one logical word can span
 * several chunks with different styling, and a wrap point can fall inside a
 * styled run. Styling and `href` must survive, and a word must break in the same
 * place whether or not any of it happens to be highlighted.
 *
 * Whitespace at a wrap point is consumed; whitespace at the start of the input is
 * preserved, since that is deliberate indentation rather than an artefact.
 *
 * @param {Line} line
 * @param {number} width
 * @returns {Line[]} at least one line, always
 */
export function wrapChunks(line, width) {
  const w = Math.max(1, Math.floor(width) || 1);
  /** @type {Line[]} */
  const out = [];
  /** @type {Line} */
  let cur = [];
  let curWidth = 0;
  // True immediately after a wrap, so whitespace that caused the break is not
  // carried onto the new line as phantom indentation.
  let justWrapped = false;

  // Strips trailing whitespace as it closes each line. Doing it here rather than
  // at each wrap site is what guarantees the invariant holds on *every* path --
  // hard breaks and over-long-word splits included.
  const flush = () => {
    while (cur.length > 0 && /^\s+$/.test(cur[cur.length - 1]?.t ?? "")) cur.pop();
    out.push(cur);
    cur = [];
    curWidth = 0;
  };

  for (const unit of units(line)) {
    if (unit.kind === "break") {
      flush();
      justWrapped = false; // an explicit break is not a wrap
      continue;
    }

    if (unit.kind === "space") {
      if (justWrapped) continue; // eat the whitespace that caused the break
      // Whitespace that would overflow is dropped rather than pushed onto the
      // next line, where it would look like stray indentation.
      if (curWidth + unit.width > w) continue;
      for (const ch of unit.chunks) cur.push(ch);
      curWidth += unit.width;
      continue;
    }

    // A word. Fits on a line of its own: place it, wrapping first if needed.
    if (unit.width <= w) {
      if (curWidth + unit.width > w && curWidth > 0) flush();
      for (const ch of unit.chunks) cur.push(ch);
      curWidth += unit.width;
      justWrapped = false;
      continue;
    }

    // Longer than a whole line, so it has to be split mid-word. Walk its chunks
    // grapheme-wise, carrying styling onto each fragment.
    if (curWidth > 0) flush();
    for (const ch of unit.chunks) {
      let gs = graphemes(ch.t);
      while (gs.length > 0) {
        const room = w - curWidth;
        const take = gs.slice(0, room);
        cur.push(restyle(ch, take.join("")));
        curWidth += take.length;
        gs = gs.slice(room);
        if (curWidth >= w && gs.length > 0) flush();
      }
    }
    justWrapped = false;
  }

  flush();
  return out;
}

/**
 * Shift lines right, leaving empty lines empty so no trailing whitespace is
 * emitted.
 * @param {Line[]} lines
 * @param {number} n
 * @returns {Line[]}
 */
export function indent(lines, n) {
  if (n <= 0) return lines;
  return lines.map((l) => (l.length === 0 ? l : [sp(n), ...l]));
}

/**
 * A bulleted paragraph with a hanging indent, so continuation lines align past
 * the glyph rather than under it.
 *
 * The glyph is "-" by default: guaranteed single-cell in every monospace font,
 * which "•" and "▸" are not.
 *
 * @param {Line} body
 * @param {number} width total width available
 * @param {{ glyph?: string, indent?: number }} [opts]
 * @returns {Line[]}
 */
export function bullet(body, width, opts = {}) {
  const glyph = opts.glyph ?? GLYPH.BULLET;
  const lead = opts.indent ?? 0;
  const hang = graphemes(glyph).length + 1; // glyph plus one space
  const inner = Math.max(1, width - lead - hang);

  const wrapped = wrapChunks(body, inner);
  return wrapped.map((l, i) =>
    i === 0
      ? [sp(lead), c(glyph + " "), ...l]
      : [sp(lead + hang), ...l],
  );
}

/**
 * Left content with right content flush to the right margin.
 *
 * When they do not both fit, the right column **stacks below** rather than being
 * truncated. That single rule is what keeps job and education entries readable at
 * 42 columns on a phone.
 *
 * @param {Line} left
 * @param {Line} right
 * @param {number} width
 * @param {number} [gap] minimum space between the columns
 * @returns {Line[]}
 */
export function twoCol(left, right, width, gap = 2) {
  const lw = len(left);
  const rw = len(right);

  if (lw + gap + rw <= width) {
    return [[...left, sp(width - lw - rw), ...right]];
  }

  return [...wrapChunks(left, width), ...indent(wrapChunks(right, Math.max(1, width - 2)), 2)];
}

/**
 * A full-width horizontal rule.
 * @param {number} width
 * @param {string} [ch]
 * @returns {Line}
 */
export function rule(width, ch = GLYPH.RULE) {
  const g = graphemes(ch);
  const one = g[0] ?? "-";
  return [c(one.repeat(Math.max(0, Math.floor(width))), "rule")];
}

/**
 * An uppercase section heading followed by a rule.
 * @param {string} title
 * @param {number} width
 * @returns {Line[]}
 */
export function heading(title, width) {
  return [[c(title.toUpperCase(), "heading")], rule(width)];
}

/**
 * A `key   value` pair with the key padded to a fixed width.
 * @param {string} key
 * @param {Line} value
 * @param {number} keyWidth
 * @returns {Line}
 */
export function kv(key, value, keyWidth) {
  const pad = Math.max(0, keyWidth - len([c(key)]));
  return [c(key, "dim"), sp(pad + 1), ...value];
}

/**
 * Lay items out in columns, filling **down** each column before moving right --
 * the same order `ls` and bash's completion list use. Sharing one function is why
 * both feel right.
 *
 * @param {string[]} items
 * @param {number} width
 * @param {{ gap?: number, cls?: import('./chunk.js').TokenClass }} [opts]
 * @returns {Line[]}
 */
export function columns(items, width, opts = {}) {
  if (items.length === 0) return [];
  const gap = opts.gap ?? 2;
  const cls = opts.cls;

  const widest = items.reduce((m, s) => Math.max(m, graphemes(s).length), 0);
  const colWidth = widest + gap;
  const nCols = Math.max(1, Math.floor((width + gap) / colWidth));

  if (nCols === 1) {
    // One per line -- and wrapped, because an item can be wider than the whole
    // terminal ("Problem Solving" at 42 columns on a phone is fine; at 10 it is
    // not) and silently overflowing would break the grid.
    return items.flatMap((s) => wrapChunks([c(s, cls)], width));
  }

  const nRows = Math.ceil(items.length / nCols);
  /** @type {Line[]} */
  const out = [];

  for (let r = 0; r < nRows; r++) {
    /** @type {Line} */
    const line = [];
    for (let col = 0; col < nCols; col++) {
      const idx = col * nRows + r; // column-major
      const item = items[idx];
      if (item === undefined) continue;
      const isLast = col === nCols - 1 || col * nRows + nRows + r >= items.length;
      line.push(c(item, cls));
      if (!isLast) line.push(sp(colWidth - graphemes(item).length));
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}
