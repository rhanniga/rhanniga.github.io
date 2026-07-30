// @ts-check
/**
 * Prompt specs.
 *
 * PS1 mirrors Ubuntu bash's default `\u@\h:\w\$` structure, which is what makes
 * it read as a real shell prompt at a glance rather than as a stylised
 * imitation.
 */

import { c } from "../render/chunk.js";

/** @typedef {import('../render/chunk.js').Line} Line */

export const USER = "visitor";
export const HOST = "hannigan.sh";
export const CWD = "~";

/**
 * `visitor@hannigan.sh:~$ `
 * @returns {Line}
 */
export function ps1() {
  return [
    c(`${USER}@${HOST}`, "prompt-user"),
    c(":", "prompt-sigil"),
    c(CWD, "prompt-path"),
    c("$ ", "prompt-sigil"),
  ];
}

/**
 * PS2 -- the continuation prompt, shown when a quote is left open.
 * @returns {Line}
 */
export function ps2() {
  return [c("> ", "prompt-sigil")];
}

/**
 * The `ask -i` sub-REPL prompt. Deliberately a different hue from PS1: the
 * colour is the mode indicator.
 * @returns {Line}
 */
export function askPrompt() {
  return [c("ask> ", "prompt-repl")];
}
