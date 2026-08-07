// @ts-check
/**
 * A character-cell line chart.
 *
 * The same shape as everything else in this directory: a pure
 * `(data, size) => Line[]`, no DOM, so it is testable and so the plain-text path
 * gets something sensible for free.
 *
 * Deliberately gnuplot's `set term dumb` and not a canvas or an SVG. A real
 * terminal cannot draw a curve, and one that suddenly could would break the
 * illusion the whole site is built on -- so the resolution limit is the point, not
 * a compromise. It also means the chart is selectable, copyable text.
 *
 * One glyph per series, `*` where two of them land in the same cell. Colour
 * distinguishes them too, but glyph-first: colour alone is not a distinction
 * everyone can see.
 */

import { c, sp } from "./chunk.js";
import { box } from "./layout.js";
import { clamp } from "../util.js";

/** @typedef {import('./chunk.js').Line} Line */
/** @typedef {import('./chunk.js').TokenClass} TokenClass */

/**
 * @typedef {object} Series
 * @property {string} label
 * @property {string} glyph    single cell, and ASCII -- see layout.js on `▸`
 * @property {TokenClass} cls
 * @property {number[]} points one per x position, in order
 */

/** Where two series occupy the same cell. */
const OVERLAP = "*";

/**
 * Draw the chart.
 *
 * @param {Series[]} series
 * @param {object} opts
 * @param {number} opts.width          total width, y-axis gutter included
 * @param {number} opts.height         plot rows, axis and tick labels excluded
 * @param {(v: number) => string} opts.format   y-axis labels
 * @param {string[]} [opts.xTicks]     up to three: left, middle, right
 * @returns {Line[]}
 */
export function plot(series, { width, height, format, xTicks = [] }) {
  const live = series.filter((s) => s.points.length > 0);
  if (live.length === 0 || height < 2) return [];

  const values = live.flatMap((s) => s.points);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) {
    // A flat series still deserves a readable axis rather than a divide by zero.
    max = min + Math.max(1, Math.abs(min) * 0.1);
  }

  const g = box();
  const labels = [format(max), format((max + min) / 2), format(min)];
  const labelW = labels.reduce((m, s) => Math.max(m, s.length), 0);
  // label + space + axis glyph
  const gutter = labelW + 2;
  const plotW = width - gutter;
  if (plotW < 4) return [];

  /** @type {Array<Array<{ch: string, cls: TokenClass, owner: number} | null>>} */
  const grid = Array.from({ length: height }, () => Array.from({ length: plotW }, () => null));

  live.forEach((s, owner) => {
    const n = s.points.length;
    for (let x = 0; x < plotW; x++) {
      // Nearest-sample rather than interpolated: with 10 years across 40 columns the
      // honest picture is where the samples are, not a smooth curve between them.
      const idx = n === 1 ? 0 : Math.round((x * (n - 1)) / (plotW - 1));
      const v = s.points[idx];
      if (v === undefined) continue;
      const row = clamp(0, Math.round(((max - v) / (max - min)) * (height - 1)), height - 1);
      const cell = grid[row]?.[x];
      const gridRow = grid[row];
      if (gridRow === undefined) continue;
      gridRow[x] =
        cell !== null && cell !== undefined && cell.owner !== owner
          ? { ch: OVERLAP, cls: "bright", owner }
          : { ch: s.glyph, cls: s.cls, owner };
    }
  });

  /** @type {Line[]} */
  const out = [];

  for (let row = 0; row < height; row++) {
    // Three labels only. One per row would be unreadable at this size, and every
    // other row still crowds a 10-row plot.
    const label =
      row === 0 ? labels[0] : row === height - 1 ? labels[2] : row === (height - 1) >> 1 ? labels[1] : "";
    /** @type {Line} */
    const line = [c((label ?? "").padStart(labelW), "dim"), sp(1), c(g.axisY, "rule")];

    // Adjacent cells of the same class are merged into one chunk: a 40-column row
    // of individually styled spans is 40 DOM nodes per row per repaint.
    let runText = "";
    /** @type {TokenClass} */
    let runCls = "text";
    const flush = () => {
      if (runText !== "") line.push(c(runText, runCls));
      runText = "";
    };
    for (let x = 0; x < plotW; x++) {
      const cell = grid[row]?.[x] ?? null;
      const ch = cell === null ? " " : cell.ch;
      const cls = cell === null ? /** @type {TokenClass} */ ("text") : cell.cls;
      if (cls !== runCls) {
        flush();
        runCls = cls;
      }
      runText += ch;
    }
    flush();
    // Drop the padding at the right-hand end of the row -- the same invariant
    // wrapChunks() keeps. Interior runs of spaces have to survive (they are the
    // plot), so this trims after the fact rather than filtering as it goes.
    while (line.length > 0 && /^ +$/.test(line[line.length - 1]?.t ?? "")) line.pop();
    out.push(line);
  }

  out.push([sp(labelW + 1), c(g.bl + g.h.repeat(plotW), "rule")]);

  const ticks = xTickRow(xTicks, plotW);
  if (ticks !== "") out.push([sp(gutter), c(ticks, "dim")]);

  return out;
}

/**
 * Lay out up to three tick labels across the plot width: left-aligned, centred,
 * right-aligned. Any that would collide are dropped rather than overlapped.
 *
 * @param {string[]} ticks
 * @param {number} plotW
 * @returns {string}
 */
function xTickRow(ticks, plotW) {
  const [left = "", mid = "", right = ""] = ticks;
  if (left === "" && mid === "" && right === "") return "";

  const cells = Array.from({ length: plotW }, () => " ");
  /** @param {string} s @param {number} at */
  const place = (s, at) => {
    if (s === "" || at < 0 || at + s.length > plotW) return;
    for (let i = 0; i < s.length; i++) {
      if (cells[at + i] !== " ") return; // would collide; leave it out entirely
    }
    for (let i = 0; i < s.length; i++) cells[at + i] = s[i] ?? " ";
  };

  place(left, 0);
  place(right, plotW - right.length);
  place(mid, Math.floor((plotW - mid.length) / 2));
  return cells.join("").replace(/\s+$/, "");
}

/**
 * `# buy   o rent` -- the key, in the series' own colours.
 * @param {Series[]} series
 * @returns {Line}
 */
export function legend(series) {
  /** @type {Line} */
  const line = [];
  series.forEach((s, i) => {
    if (i > 0) line.push(sp(3));
    line.push(c(s.glyph, s.cls), sp(1), c(s.label, "dim"));
  });
  return line;
}
