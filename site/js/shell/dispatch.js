// @ts-check
/**
 * Command dispatch.
 *
 * Where shell authenticity actually lives: real error strings, real exit
 * statuses. Those matter more to the illusion than any visual effect.
 */

import { c } from "../render/chunk.js";
import { EXIT } from "./env.js";

/** @typedef {import('./registry.js').Registry} Registry */
/** @typedef {import('./registry.js').CommandContext} CommandContext */
/** @typedef {import('../render/chunk.js').Line} Line */

/**
 * @typedef {object} DispatchDeps
 * @property {Registry} registry
 * @property {import('./env.js').Env} env
 * @property {import('../data/types.js').Resume} resume
 * @property {import('../terminal/history.js').History} history
 * @property {() => void} motd
 * @property {import('../terminal/terminal.js').TerminalApi} term
 * @property {(line: Line) => void} out
 * @property {(lines: Line[]) => void} rows
 * @property {(text: string) => void} err
 */

/**
 * Run one already-tokenized command line.
 *
 * @param {string[]} argv
 * @param {DispatchDeps} deps
 * @param {AbortSignal} signal
 * @returns {Promise<number>} exit status
 */
export async function dispatch(argv, deps, signal) {
  const name = argv[0];
  if (name === undefined || name === "") return EXIT.OK;

  // A path-looking token is not a command name. bash reports it differently, and
  // reproducing that is nearly free.
  if (name.includes("/")) {
    deps.err(`bash: ${name}: No such file or directory`);
    return EXIT.NOT_FOUND;
  }

  const cmd = deps.registry.get(name);
  if (cmd === undefined) {
    deps.err(`bash: ${name}: command not found`);
    return EXIT.NOT_FOUND;
  }

  /** @type {CommandContext} */
  const ctx = {
    argv,
    out: deps.out,
    err: deps.err,
    rows: deps.rows,
    signal,
    cols: deps.term.cols(),
    term: deps.term,
    env: deps.env,
    resume: deps.resume,
    registry: deps.registry,
    history: deps.history,
    motd: deps.motd,
  };

  try {
    const status = await cmd.run(ctx);
    return typeof status === "number" ? status : EXIT.OK;
  } catch (err) {
    if (isAbort(err)) {
      // Ctrl+C during a command. bash reports 130 for SIGINT.
      deps.out([c("^C", "dim")]);
      return EXIT.INTERRUPTED;
    }
    // A bug in a handler must never white-screen the terminal. Report it the way
    // a shell would and leave the real detail in the console for whoever is
    // debugging.
    console.error(`[${name}]`, err);
    deps.err(`bash: ${name}: internal error`);
    return EXIT.ERROR;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbort(err) {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (
    typeof err === "object" && err !== null && /** @type {{name?: string}} */ (err).name === "AbortError"
  );
}
