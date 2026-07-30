// @ts-check
/**
 * Cell measurement -> column count.
 *
 * Everything the render layer does depends on knowing how many characters fit
 * across, and that varies by platform because the font is the system monospace
 * stack. So we measure it rather than assume it -- which is also what makes the
 * per-platform font choice safe.
 */

import { clamp } from "../util.js";

/** Terminal layout constants shared with the render layer. */
export const LAYOUT = {
  MIN_COLS: 20,
  MAX_COLS: 120,
  /* Box-drawing light horizontal. Reliably single-cell in every system
   * monospace stack. If PixelOperatorMono turns out not to cover it, this is
   * the one constant to flip to "-". */
  RULE: "─",
  /* Guaranteed single-cell in every monospace font, unlike "•" and "▸". */
  BULLET: "-",
};

const PROBE_RUN = 100;

export class Metrics {
  /** @type {HTMLElement} */ #probe;
  /** @type {HTMLElement} */ #content;
  /** @type {number} */ #cellWidth = 8;
  /** @type {number} */ #cols = 80;
  /** @type {Set<(cols: number) => void>} */ #listeners = new Set();
  /** @type {ResizeObserver | null} */ #ro = null;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.probe   hidden span inheriting .row's font context
   * @param {HTMLElement} opts.content block element whose clientWidth is the
   *   usable text width (i.e. inside the viewport's padding, and excluding the
   *   scrollbar when one appears)
   */
  constructor({ probe, content }) {
    this.#probe = probe;
    this.#content = content;
    this.measure();
  }

  get cols() {
    return this.#cols;
  }
  get cellWidth() {
    return this.#cellWidth;
  }

  /**
   * Re-measure. Returns true if the column count changed.
   * @returns {boolean}
   */
  measure() {
    // Measure a long run and divide, rather than measuring one glyph: a single
    // character's advance is subject to subpixel rounding that compounds badly
    // across 80 columns.
    this.#probe.textContent = "M".repeat(PROBE_RUN);
    const runWidth = this.#probe.getBoundingClientRect().width;
    this.#probe.textContent = "";

    if (runWidth > 0) this.#cellWidth = runWidth / PROBE_RUN;

    const avail = this.#content.clientWidth;
    const fit = Math.floor(avail / this.#cellWidth);
    const next = clamp(LAYOUT.MIN_COLS, fit, LAYOUT.MAX_COLS);

    if (next === this.#cols) return false;
    this.#cols = next;
    return true;
  }

  /**
   * Verify the active font is genuinely monospaced, and that the rule glyph
   * renders as a single cell. Used by the `font` command before switching to
   * PixelOperatorMono, since a proportional or partially-covered face would
   * silently break every aligned layout.
   * @returns {{ mono: boolean, rule: boolean }}
   */
  probeFont() {
    const measure = (/** @type {string} */ s) => {
      this.#probe.textContent = s;
      const w = this.#probe.getBoundingClientRect().width;
      this.#probe.textContent = "";
      return w;
    };
    const m = measure("M".repeat(PROBE_RUN));
    const i = measure("i".repeat(PROBE_RUN));
    const rule = measure(LAYOUT.RULE.repeat(PROBE_RUN));
    // Sub-pixel tolerance over a 100-glyph run.
    const mono = Math.abs(m - i) < 1;
    return { mono, rule: Math.abs(rule - m) < 1 };
  }

  /**
   * Start watching for size and font changes.
   * @param {HTMLElement} target element whose resize should trigger re-measure
   */
  observe(target) {
    this.#ro = new ResizeObserver(() => {
      if (this.measure()) this.#emit();
    });
    this.#ro.observe(target);

    // A late-loading webfont changes the cell width after first paint. Only
    // relevant on the opt-in pixel-font path, but cheap to handle.
    document.fonts?.ready.then(() => {
      if (this.measure()) this.#emit();
    });
  }

  /** @param {(cols: number) => void} fn */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) fn(this.#cols);
  }

  dispose() {
    this.#ro?.disconnect();
    this.#ro = null;
    this.#listeners.clear();
  }
}
