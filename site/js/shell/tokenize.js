// @ts-check
/**
 * argv tokenizer.
 *
 * POSIX-ish word splitting with quote handling, because `ask "How did you get
 * into physics?"` has to work and a naive whitespace split would shred it.
 *
 * Scope is drawn tightly on purpose. The ONLY expansion is `$?`. No `$VAR`, no
 * `~`, no globbing, no pipes, no `&&`, no subshells. Saying that narrowly here is
 * what stops this file from slowly becoming a shell.
 */

/**
 * @typedef {'unterminated-single'|'unterminated-double'|'trailing-backslash'} TokenizeError
 */

/**
 * @typedef {{ok: true, argv: string[]} | {ok: false, error: TokenizeError}} TokenizeResult
 */

/** Characters a backslash may escape inside double quotes, per POSIX. */
const DQ_ESCAPABLE = new Set(['"', "\\", "`", "$"]);

/**
 * @param {string} input
 * @param {{status: number}} [env] provides `$?`
 * @returns {TokenizeResult}
 */
export function tokenize(input, env) {
  /** @type {string[]} */
  const argv = [];
  let cur = "";
  // Distinguishes a token that exists but is empty (`ask ""` -> ['ask', '']) from
  // no token at all. That matters: an empty argument should reach the command and
  // produce a usage error, not silently vanish.
  let started = false;
  /** @type {null | "'" | '"'} */
  let quote = null;

  const push = () => {
    if (started) {
      argv.push(cur);
      cur = "";
      started = false;
    }
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";

    if (quote === "'") {
      // Single quotes are fully literal -- no escapes at all, per POSIX.
      if (ch === "'") {
        quote = null;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        i++;
        continue;
      }
      if (ch === "\\") {
        const next = input[i + 1];
        if (next === undefined) return { ok: false, error: "trailing-backslash" };
        if (DQ_ESCAPABLE.has(next)) {
          cur += next;
          i += 2;
          continue;
        }
        // A backslash before anything else is literal inside double quotes.
        cur += ch;
        i++;
        continue;
      }
      if (ch === "$" && input[i + 1] === "?") {
        cur += String(env?.status ?? 0);
        i += 2;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }

    // Unquoted.
    if (/\s/.test(ch)) {
      push();
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = /** @type {"'" | '"'} */ (ch);
      started = true; // the token exists even if the quotes turn out empty
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) return { ok: false, error: "trailing-backslash" };
      cur += next;
      started = true;
      i += 2;
      continue;
    }
    if (ch === "$" && input[i + 1] === "?") {
      cur += String(env?.status ?? 0);
      started = true;
      i += 2;
      continue;
    }
    cur += ch;
    started = true;
    i++;
  }

  if (quote === "'") return { ok: false, error: "unterminated-single" };
  if (quote === '"') return { ok: false, error: "unterminated-double" };

  push();
  return { ok: true, argv };
}

/**
 * Human-readable form of a tokenize failure, for the continuation prompt's
 * abort message.
 * @param {TokenizeError} error
 * @returns {string}
 */
export function describeError(error) {
  switch (error) {
    case "unterminated-single":
      return "unexpected EOF while looking for matching `''";
    case "unterminated-double":
      return 'unexpected EOF while looking for matching `"\'';
    case "trailing-backslash":
      return "unexpected EOF after escape character";
  }
}
