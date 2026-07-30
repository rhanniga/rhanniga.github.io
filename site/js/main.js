// @ts-check
/**
 * Bootstrap.
 *
 * M3 scope: a working shell over the real resume. The boot/POST sequence is M5,
 * `ask` is M6.
 */

import { c, sp, blank } from "./render/chunk.js";
import { rule } from "./render/layout.js";
import { Terminal } from "./terminal/terminal.js";
import { ShellMode } from "./terminal/shell-mode.js";
import { History } from "./terminal/history.js";
import { setIdentity } from "./terminal/prompt.js";
import { buildRegistry } from "./commands/index.js";
import { Env } from "./shell/env.js";
import { loadResume, emptyResume } from "./data/resume.js";
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

/* ── Resume data ─────────────────────────────────────────────────────────
 * Awaited before the first prompt, but the fetch is 6 KB from the same origin,
 * so it resolves faster than the eye. From M5 the boot sequence covers it
 * outright and reports the real byte count as it lands.
 *
 * A failure must not produce a white screen: the shell comes up either way, the
 * resume commands report honestly, and everything else keeps working. */
let resume = emptyResume();
/** @type {string | null} */
let loadError = null;
try {
  resume = await loadResume();
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
  console.error("[resume]", err);
}

/* ── Banner ─────────────────────────────────────────────────────────────── */

function motd() {
  const w = term.writer;
  const cols = term.metrics.cols;

  w.row([c("hannigan.sh", "heading")]);
  w.row(rule(cols));
  w.row(blank);

  if (loadError !== null) {
    // Terminal-authentic failure rather than a blank section or a modal.
    w.row([c("bash: resume.json: No such file or directory", "error")]);
    w.row([sp(2), c("the resume data failed to load; shell commands still work", "dim")]);
    w.row([sp(2), c(loadError, "dim")]);
  } else {
    w.row([c(resume.contactInfo.name, "bright")]);
    const first = resume.summaries[0];
    if (first !== undefined) {
      const short = first.text.split(". ")[0] ?? "";
      w.row([c(short + ".", "dim")]);
    }
  }

  w.row(blank);
  w.row([
    c("Type "),
    c("help", "bright"),
    c(" for commands, or start with "),
    c("summary", "bright"),
    c("."),
  ]);
  w.row(blank);
  w.flush();
}

motd();

/* ── Shell ──────────────────────────────────────────────────────────────── */

const env = new Env();
const history = new History("shell");
const registry = buildRegistry();

term.start(new ShellMode({ registry, env, resume, history, motd }));

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
