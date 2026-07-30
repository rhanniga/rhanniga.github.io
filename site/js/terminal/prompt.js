// @ts-check
/**
 * Prompt specs.
 *
 * A bare chevron rather than bash's `\u@\h:\w\$`. The full
 * `visitor@hannigan.sh:~$ ` form is more shell-authentic, but it costs 23
 * columns before the user types anything -- on a 375px phone that is more than
 * half the available width, and it pushes every wrapped continuation line
 * awkwardly far right. The chevron keeps the input line readable at every width.
 *
 * Shell authenticity is carried by behaviour instead: real exit statuses, real
 * `bash: foo: command not found`, real readline keybindings.
 */

import { c } from "../render/chunk.js";

/** @typedef {import('../render/chunk.js').Line} Line */

/** Still used by `whoami` and `pwd`, which should agree with each other. */
export const USER = "visitor";
export const HOST = "hannigan.sh";
export const CWD = "~";

/**
 * The primary prompt.
 *
 * nord9 rather than nord14: green is reserved for `--success`, and reusing it
 * here would blur the distinction once commands start reporting whether they
 * worked.
 * @returns {Line}
 */
export function ps1() {
  return [c("> ", "prompt-path")];
}

/**
 * The continuation prompt, shown when a quote is left open.
 *
 * bash uses `> ` for this, but that is now the primary prompt, so borrow
 * Python's `... ` -- widely recognised as "this line is unfinished", and visibly
 * different from a fresh prompt at a glance.
 * @returns {Line}
 */
export function ps2() {
  return [c("... ", "dim")];
}

/**
 * The `ask -i` sub-REPL prompt. Deliberately a different hue: the colour is the
 * mode indicator, and it is what tells you Ctrl+C will return you here rather
 * than all the way out to the shell.
 * @returns {Line}
 */
export function askPrompt() {
  return [c("ask> ", "prompt-repl")];
}
