// @ts-check
/**
 * Bootstrap.
 *
 * M0 scope: stand up the render pipeline (metrics -> writer -> chunks) and put
 * a palette smoke-test on screen so the theme decisions can be eyeballed
 * against the measured contrast table in styles/theme.css. Real input handling
 * arrives in M2, the shell in M3, the boot sequence in M5.
 */

import { c, sp, link, blank, len } from "./render/chunk.js";
import { Writer } from "./terminal/writer.js";
import { Metrics, LAYOUT } from "./terminal/metrics.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function must(id) {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} in index.html`);
  return el;
}

const terminal = must("terminal");
const viewport = must("viewport");
const output = must("output");
const inputline = must("inputline");
const probe = must("metrics");
const kbd = /** @type {HTMLTextAreaElement} */ (must("kbd"));

const metrics = new Metrics({ probe, content: output });
const writer = new Writer({
  output,
  viewport,
  getCols: () => metrics.cols,
});

/* ── Minimal focus handling ───────────────────────────────────────────────
 * data-focused drives the cursor's focused/hollow appearance. The full
 * treatment (mode stack, line editing, soft keys) lands in M2; this is the
 * slice needed for the cursor to blink at all.
 *
 * The collapsed-selection guard is the load-bearing part: without it,
 * releasing a drag-select refocuses the textarea and destroys the selection,
 * which breaks copy entirely. */
function refocus() {
  const sel = window.getSelection();
  if (sel !== null && !sel.isCollapsed) return; // user is selecting text
  kbd.focus({ preventScroll: true });
}
terminal.addEventListener("click", refocus);
kbd.addEventListener("focus", () => {
  terminal.dataset.focused = "true";
});
kbd.addEventListener("blur", () => {
  terminal.dataset.focused = "false";
});

/* ── Palette smoke test ─────────────────────────────────────────────────── */

/** @param {string} title */
function heading(title) {
  const cols = metrics.cols;
  writer.row([c(title.toUpperCase(), "heading")]);
  writer.row([c(LAYOUT.RULE.repeat(cols), "rule")]);
}

/** @type {Array<[string, import('./render/chunk.js').TokenClass, string]>} */
const ROLES = [
  ["fg        ", "text", "default body text (nord4, 9.25:1)"],
  ["bright    ", "bright", "emphasis (nord6, 11:1)"],
  ["dim       ", "dim", "locations, ls -l metadata (mix, ~4.59:1)"],
  ["heading   ", "heading", "section titles (nord8, 6.24:1)"],
  ["subheading", "subheading", "company names (nord7, 5.99:1)"],
  ["accent    ", "accent", "dates (nord15, 4.41:1)"],
  ["keyword   ", "keyword", "inline highlights (nord8, not bold)"],
  ["success   ", "success", "ok (nord14, 6.13:1)"],
  ["warn      ", "warn", "warnings (nord12, 4.39:1)"],
  ["error     ", "error", "lightened red (mix, ~4.60:1)"],
];

function render() {
  writer.clear();

  heading("hannigan.sh");
  writer.row(blank);
  writer.row([
    c("Terminal rewrite in progress. "),
    c("M0", "bright"),
    c(": render pipeline up."),
  ]);
  writer.row(blank);

  heading("palette");
  writer.row(blank);
  for (const [label, cls, note] of ROLES) {
    writer.row([sp(2), c(label, cls), sp(2), c(note, "dim")]);
  }
  writer.row(blank);

  heading("metrics");
  writer.row(blank);
  const kv = (/** @type {string} */ k, /** @type {string} */ v) =>
    writer.row([sp(2), c(k.padEnd(12), "dim"), c(v)]);
  kv("cols", String(metrics.cols));
  kv("cell width", metrics.cellWidth.toFixed(3) + "px");
  kv("viewport", `${viewport.clientWidth}x${viewport.clientHeight}px`);
  kv("dpr", String(window.devicePixelRatio));
  const font = metrics.probeFont();
  kv("monospaced", font.mono ? "yes" : "NO — layout will break");
  kv("rule glyph", font.rule ? `ok (${LAYOUT.RULE})` : "NOT single-cell");
  writer.row(blank);

  heading("links");
  writer.row(blank);
  writer.row([sp(2), link("github.com/rhanniga", "https://github.com/rhanniga")]);
  writer.row([sp(2), link("resume.json", "./resume.json")]);
  writer.row(blank);

  // Alignment check: a full-width rule and a right-aligned value must land on
  // the same final column. If these disagree, cell measurement is wrong.
  const left = [sp(2), c("right-aligned", "dim")];
  const right = [c("Oct 2023 - Jul 2025", "accent")];
  const gap = metrics.cols - len(left) - len(right);
  writer.row(gap >= 1 ? [...left, sp(gap), ...right] : [...left]);

  writer.flush();
}

metrics.observe(viewport);
metrics.onChange((cols) => {
  console.log("[metrics] cols ->", cols);
  render();
});

render();
console.log(
  `[metrics] cols=${metrics.cols} cell=${metrics.cellWidth.toFixed(3)}px`,
);

inputline.hidden = false;
terminal.dataset.booting = "false";
refocus();
