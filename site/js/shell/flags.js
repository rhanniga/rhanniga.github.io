// @ts-check
/**
 * Flag parsing.
 *
 * Hand-rolled, ~70 lines. minimist and yargs would both work and neither
 * produces shell-authentic error messages, which is most of the value here.
 */

/**
 * Canonical flag name -> the spellings that select it. Include both the short and
 * long forms, without leading dashes.
 * @typedef {{ bools?: Record<string, string[]> }} FlagSpec
 */

/**
 * @typedef {{ok: true, flags: Record<string, boolean>, operands: string[]}
 *          | {ok: false, badFlag: string}} FlagResult
 */

/**
 * @param {string[]} argv including argv[0], the command name
 * @param {FlagSpec} spec
 * @returns {FlagResult}
 */
export function parseFlags(argv, spec) {
  /** @type {Map<string, string>} alias -> canonical */
  const alias = new Map();
  /** @type {Record<string, boolean>} */
  const flags = {};

  for (const [canonical, spellings] of Object.entries(spec.bools ?? {})) {
    flags[canonical] = false;
    alias.set(canonical, canonical);
    for (const s of spellings) alias.set(s, canonical);
  }

  /** @type {string[]} */
  const operands = [];
  let noMoreFlags = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? "";

    if (noMoreFlags) {
      operands.push(arg);
      continue;
    }

    // `--` ends flag parsing, so `ask -- -i` asks about the literal text "-i".
    if (arg === "--") {
      noMoreFlags = true;
      continue;
    }

    if (arg.startsWith("--") && arg.length > 2) {
      const name = arg.slice(2);
      const canonical = alias.get(name);
      if (canonical === undefined) return { ok: false, badFlag: arg };
      flags[canonical] = true;
      continue;
    }

    // A lone "-" is an operand by convention (stdin), not a flag.
    if (arg.startsWith("-") && arg.length > 1) {
      // Clustered shorts: -ix is -i -x.
      for (const ch of arg.slice(1)) {
        const canonical = alias.get(ch);
        if (canonical === undefined) return { ok: false, badFlag: ch };
        flags[canonical] = true;
      }
      continue;
    }

    operands.push(arg);
  }

  return { ok: true, flags, operands };
}

/**
 * bash's phrasing for a rejected flag. Short names get quotes, long names get the
 * `--name` form, which is what getopt_long actually prints.
 * @param {string} command
 * @param {string} badFlag
 * @returns {string}
 */
export function invalidOptionMessage(command, badFlag) {
  const shown = badFlag.startsWith("--") ? badFlag : `'${badFlag}'`;
  return `${command}: invalid option -- ${shown}`;
}
