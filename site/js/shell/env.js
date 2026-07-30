// @ts-check
/**
 * Shell environment.
 *
 * Just the exit status, deliberately. `$?` is one field, but tracking it forces
 * every command handler to return a real exit status instead of drifting into
 * returning nothing -- which is why it is worth having even though almost nobody
 * will type `echo $?`.
 *
 * Notably NOT here: `$VAR`, `$HOME`, `~` expansion, or any other variable. The
 * tokenizer expands exactly one thing, and stating that narrowly is what keeps
 * this from growing into a shell.
 */

export class Env {
  /** Exit status of the last command. */
  #status = 0;

  get status() {
    return this.#status;
  }

  /** @param {number} n */
  setStatus(n) {
    this.#status = Number.isInteger(n) ? n : 1;
  }
}

/** Conventional exit statuses this shell actually uses. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  /** Bad flag or wrong arguments -- what bash uses for a usage error. */
  USAGE: 2,
  /** `command not found`. */
  NOT_FOUND: 127,
  /** Killed by SIGINT, i.e. Ctrl+C. */
  INTERRUPTED: 130,
  /** Service unavailable (sysexits.h EX_UNAVAILABLE) -- used when the LLM
   *  weights are not deployed. */
  UNAVAILABLE: 69,
};
