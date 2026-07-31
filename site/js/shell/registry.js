// @ts-check
/**
 * The command contract and registry.
 *
 * Commands are registered from an explicit import list in commands/index.js
 * rather than discovered. Without a bundler there is no glob to discover with
 * anyway, and being explicit buys deterministic `help` ordering.
 */

/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('../render/chunk.js').TokenClass} TokenClass */
/** @typedef {import('../data/types.js').Resume} Resume */

/**
 * Everything a command is handed.
 *
 * `out` and `err` are separate sinks so error text can be styled and routed to
 * the screen-reader announcer without every handler having to remember to pass a
 * token class.
 *
 * @typedef {object} CommandContext
 * @property {string[]} argv                     argv[0] is the command name
 * @property {(line: Line) => void} out
 * @property {(text: string) => void} err        one styled error line
 * @property {(lines: Line[]) => void} rows
 * @property {AbortSignal} signal                aborted on Ctrl+C
 * @property {number} cols
 * @property {import('../terminal/terminal.js').TerminalApi} term
 * @property {import('./env.js').Env} env
 * @property {Resume} resume
 * @property {Registry} registry                 so `help` can enumerate commands
 * @property {import('../terminal/history.js').History} history  for `history`
 * @property {() => void} motd                   reprints the login banner
 */

/**
 * @typedef {object} Command
 * @property {string} name
 * @property {'resume'|'ai'|'shell'|'misc'} group
 * @property {string} summary                    one line, shown by bare `help`
 * @property {string} [usage]
 * @property {string[]} [synopsis]               body for `help <cmd>`
 * @property {boolean} [hidden]                  discoverable but not listed
 * @property {string[]} [aliases]
 * @property {(argv: string[], index: number) => string[]} [complete]
 * @property {(ctx: CommandContext) => number | Promise<number>} run  exit status
 */

export class Registry {
  /** @type {Map<string, Command>} */ #byName = new Map();
  /** @type {Command[]} */ #ordered = [];

  /** @param {Command[]} commands */
  constructor(commands) {
    for (const cmd of commands) this.#add(cmd);
  }

  /** @param {Command} cmd */
  #add(cmd) {
    if (this.#byName.has(cmd.name)) {
      throw new Error(`duplicate command: ${cmd.name}`);
    }
    this.#byName.set(cmd.name, cmd);
    this.#ordered.push(cmd);
    for (const alias of cmd.aliases ?? []) {
      if (this.#byName.has(alias)) {
        throw new Error(`alias ${alias} collides with an existing command`);
      }
      this.#byName.set(alias, cmd);
    }
  }

  /**
   * @param {string} name
   * @returns {Command | undefined}
   */
  get(name) {
    return this.#byName.get(name);
  }

  /** Registration order, aliases excluded. @returns {readonly Command[]} */
  all() {
    return this.#ordered;
  }

  /** Names offered by tab completion: visible commands plus their aliases. */
  completions() {
    /** @type {string[]} */
    const names = [];
    for (const [name, cmd] of this.#byName) {
      if (cmd.hidden !== true) names.push(name);
    }
    return names.sort();
  }

  /**
   * @param {Command['group']} group
   * @returns {Command[]}
   */
  byGroup(group) {
    return this.#ordered.filter((cmd) => cmd.group === group && cmd.hidden !== true);
  }
}
