// @ts-check
/**
 * Prompt specs.
 *
 * Two different prompts, deliberately:
 *
 *   - **Committed lines** keep the full `visitor@hannigan.sh:~$ ` form. That is
 *     the scrollback record, it reads as a real shell transcript, and the width
 *     costs nothing because the line is already finished.
 *   - **The live line** gets a bare `> `. The full form costs 23 columns before
 *     the user types anything, which on a 375px phone is more than half the
 *     usable width and pushes wrapped continuations awkwardly far right.
 *
 * The asymmetry is the point: the short chevron plus the accent treatment in
 * terminal.css is what makes the line you are typing on unmistakable.
 */

import { c } from "../render/chunk.js";

/** @typedef {import('../render/chunk.js').Line} Line */

export const HOST = "hannigan.sh";
export const CWD = "~";
/** Fallback identity, and what `whoami` reports. */
export const USER = "visitor";

/** @type {string | null} */
let override = null;

/**
 * Replace the user part of the prompt (e.g. with the visitor's IP address).
 * Committed lines already on screen keep whatever they were rendered with, which
 * is correct -- scrollback is a record of what was true at the time.
 * @param {string | null} name
 */
export function setIdentity(name) {
  override = name !== null && name.trim() !== "" ? name.trim() : null;
}

/** @returns {string} */
export function identity() {
  return override ?? USER;
}

/**
 * The full prompt, for lines committed to scrollback.
 * @returns {Line}
 */
export function echoPrompt() {
  return [
    c(`${identity()}@${HOST}`, "prompt-user"),
    c(":", "prompt-sigil"),
    c(CWD, "prompt-path"),
    c("$ ", "prompt-sigil"),
  ];
}

/**
 * The live input prompt.
 *
 * nord8 rather than nord14: green is reserved for `--success`, and reusing it
 * would blur the distinction once commands start reporting whether they worked.
 * @returns {Line}
 */
export function inputPrompt() {
  return [c("> ", "prompt-chevron")];
}

/**
 * Shown on the live line when a quote is left open.
 *
 * bash uses `> ` for this, but that is now the primary prompt, so borrow
 * Python's `... ` -- widely read as "this line is unfinished", and visibly
 * distinct from a fresh prompt.
 * @returns {Line}
 */
export function continuationPrompt() {
  return [c("... ", "dim")];
}

/**
 * The `ask -i` sub-REPL prompt. A different hue is the mode indicator: it is
 * what tells you Ctrl+C will return you here rather than out to the shell.
 * @returns {Line}
 */
export function askPrompt() {
  return [c("ask> ", "prompt-repl")];
}
