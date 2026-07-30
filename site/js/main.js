// @ts-check
/**
 * Bootstrap.
 *
 * M2 scope: the terminal is interactive. Real resume commands arrive in M3, the
 * boot/POST sequence in M5.
 */

import { c, sp, link } from "./render/chunk.js";
import { Terminal } from "./terminal/terminal.js";
import { ShellMode } from "./terminal/shell-mode.js";
import { LAYOUT } from "./terminal/metrics.js";
import { setIdentity } from "./terminal/prompt.js";
import { resolveIp } from "./identity.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function must(id) {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} in index.html`);
  return el;
}

const term = new Terminal({
  root: must("terminal"),
  viewport: must("viewport"),
  output: must("output"),
  inputline: must("inputline"),
  kbd: /** @type {HTMLTextAreaElement} */ (must("kbd")),
  probe: must("metrics"),
});

/* ── Placeholder banner ──────────────────────────────────────────────────
 * Stands in for the real POST/MOTD sequence (M5). Kept deliberately short so
 * it does not bury the prompt at 375px. */
const w = term.writer;
const cols = term.metrics.cols;

w.row([c("hannigan.sh", "heading"), c("  — terminal rewrite, M2", "dim")]);
w.row([c(LAYOUT.RULE.repeat(cols), "rule")]);
w.row([]);
w.row([c("Line editing is live. Try:", "dim")]);
w.row([sp(2), c("arrows, Home/End, Ctrl+A/E/U/K/Y, Alt+B/F, Alt+Backspace")]);
w.row([sp(2), c("Ctrl+L"), c(" clear", "dim"), c("   Ctrl+C"), c(" abort", "dim")]);
w.row([sp(2), c("paste a multi-line string — newlines collapse to spaces", "dim")]);
w.row([]);
w.row([
  c("Not yet implemented: ", "dim"),
  c("history, tab completion, and every actual command."),
]);
w.row([sp(2), c("resume.json", "dim"), c(" → "), link("resume.json", "./resume.json")]);
w.row([]);
w.flush();

term.start(new ShellMode());

console.log(
  `[metrics] cols=${term.metrics.cols} cell=${term.metrics.cellWidth.toFixed(3)}px`,
);

/* Resolve the visitor's IP for the prompt.
 *
 * Deliberately not awaited: the terminal is already interactive, and this is the
 * only third-party request the site makes. It fails silently for anyone running
 * an ad blocker, leaving the `visitor@` fallback in place.
 *
 * Nothing needs re-rendering when it lands. The live line is just `> `, so the
 * identity first appears on the next committed line -- and lines already in
 * scrollback keep `visitor@`, which is correct: scrollback records what was true
 * at the time, and rewriting history would be the actual bug. */
void resolveIp().then((ip) => {
  if (ip !== null) setIdentity(ip);
});
