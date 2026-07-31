// @ts-check
/**
 * The PS1 mode: line editing, history, completion, and dispatch.
 */

import { c, sp } from "../render/chunk.js";
import { columns } from "../render/layout.js";
import { LineBuffer } from "./line-buffer.js";
import { History } from "./history.js";
import { inputPrompt, echoPrompt } from "./prompt.js";
import { ContinuationMode } from "./continuation-mode.js";
import { RunningMode } from "./running-mode.js";
import { applyEdit, applyScroll } from "./editing.js";
import { tokenize, describeError } from "../shell/tokenize.js";
import { dispatch } from "../shell/dispatch.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../shell/registry.js').Registry} Registry */
/** @typedef {import('../render/chunk.js').Line} Line */

/**
 * @typedef {object} ShellDeps
 * @property {Registry} registry
 * @property {import('../shell/env.js').Env} env
 * @property {import('../data/types.js').Resume} resume
 * @property {History} history
 * @property {() => void} motd
 * @property {import('../render/announcer.js').Announcer} [announcer]
 *   Optional screen-reader sink. Absent in tests, which is why every use is
 *   optional-chained rather than assumed.
 */

/** @implements {TerminalMode} */
export class ShellMode {
  id = "shell";
  label = "visitor@hannigan.sh: ~";
  editable = true;
  buffer = new LineBuffer();

  /** @type {ShellDeps} */ #deps;
  /** Set after a Tab that could not extend the line, so a second Tab lists. */
  #tabbedOnce = false;

  /** @param {ShellDeps} deps */
  constructor(deps) {
    this.#deps = deps;
  }

  prompt() {
    return inputPrompt();
  }

  /**
   * @param {string} text
   * @param {ModeContext} ctx
   */
  onInsertText(text, ctx) {
    this.#tabbedOnce = false;
    this.buffer.insert(text);
    ctx.term.renderInput();
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    const b = this.buffer;
    const history = this.#deps.history;

    // Any key that is not Tab breaks a completion sequence.
    if (ev.action !== "tab" && ev.action !== "tab-back") this.#tabbedOnce = false;

    if (applyEdit(b, ev.action)) {
      ctx.term.renderInput();
      return;
    }
    if (applyScroll(ev.action, ctx.term)) return;

    switch (ev.action) {
      case "enter":
        this.#submit(ctx);
        return;

      case "tab":
      case "tab-back":
        this.#complete(ctx);
        return;

      case "up": {
        const recalled = history.prev(b.value);
        if (recalled !== null) b.set(recalled);
        break;
      }
      case "down": {
        const recalled = history.next();
        if (recalled !== null) b.set(recalled);
        break;
      }

      case "clear":
        ctx.term.clear();
        return;

      case "interrupt":
        // Abandon the line. A real shell echoes ^C and leaves what you typed on
        // screen rather than erasing it. (A *running* command is aborted by
        // RunningMode, which sits above this one while one is in flight.)
        ctx.out.row([...echoPrompt(), c(b.value), c("^C", "dim")]);
        b.clear();
        history.reset();
        this.#deps.env.setStatus(EXIT.INTERRUPTED);
        break;

      case "eof":
        // bash: Ctrl+D on an empty line is EOF, otherwise delete-forward.
        if (b.isEmpty) {
          void this.#runArgv(["exit"], ctx);
          return;
        }
        b.deleteForward();
        break;

      case "none":
        break;

      default:
        break;
    }

    ctx.term.renderInput();
  }

  /* ── Completion ────────────────────────────────────────────────────── */

  /**
   * Complete the word under the cursor.
   *
   * Bash's behaviour, which is what fingers expect: a unique match completes and
   * appends a space; several matches extend to their longest common prefix; and if
   * that cannot extend the line any further, a second Tab lists the candidates in
   * columns.
   *
   * @param {ModeContext} ctx
   */
  #complete(ctx) {
    const b = this.buffer;
    const upToCursor = b.value.slice(0, b.cursor);
    // Only complete at the end of a word -- completing mid-line would need to
    // splice, and nothing here benefits from it.
    const words = upToCursor.split(/\s+/);
    const index = upToCursor.endsWith(" ") ? words.length - 1 : words.length - 1;
    const partial = upToCursor.endsWith(" ") ? "" : (words[words.length - 1] ?? "");

    /** @type {string[]} */
    let candidates;
    if (index === 0) {
      candidates = this.#deps.registry.completions();
    } else {
      const cmd = this.#deps.registry.get(words[0] ?? "");
      candidates = cmd?.complete?.(words, index) ?? [];
    }

    const matches = candidates.filter((s) => s.startsWith(partial));
    if (matches.length === 0) return;

    if (matches.length === 1) {
      const only = matches[0] ?? "";
      b.set(b.value.slice(0, b.cursor - partial.length) + only + " " + b.value.slice(b.cursor),
        b.cursor - partial.length + only.length + 1);
      this.#tabbedOnce = false;
      ctx.term.renderInput();
      return;
    }

    const prefix = longestCommonPrefix(matches);
    if (prefix.length > partial.length) {
      b.set(b.value.slice(0, b.cursor - partial.length) + prefix + b.value.slice(b.cursor),
        b.cursor - partial.length + prefix.length);
      this.#tabbedOnce = false;
      ctx.term.renderInput();
      return;
    }

    // Cannot extend further. First Tab does nothing visible; second lists.
    if (!this.#tabbedOnce) {
      this.#tabbedOnce = true;
      return;
    }
    this.#tabbedOnce = false;
    ctx.out.row([...echoPrompt(), c(b.value)]);
    // Same columns() the `ls` listing uses, so both feel the same.
    for (const line of columns(matches, ctx.term.cols())) ctx.out.row([sp(2), ...line]);
    ctx.term.renderInput();
  }

  /* ── Submission ────────────────────────────────────────────────────── */

  /**
   * @param {ModeContext} ctx
   */
  #submit(ctx) {
    const line = this.buffer.value;
    this.buffer.clear();

    // Scrollback gets the long user@host:cwd$ form; only the live line uses the
    // short chevron.
    ctx.out.row([...echoPrompt(), c(line)]);
    this.#deps.history.push(line);

    if (line.trim() === "") {
      // An empty line leaves $? untouched, as bash does.
      ctx.term.renderInput();
      return;
    }

    const result = tokenize(line, this.#deps.env);
    if (!result.ok) {
      // An open quote drops to PS2 and keeps collecting rather than erroring.
      ctx.term.pushMode(
        new ContinuationMode({
          pending: line,
          env: this.#deps.env,
          onComplete: (argv) => void this.#runArgv(argv, ctx),
          onAbort: () => {
            this.#deps.env.setStatus(EXIT.INTERRUPTED);
            ctx.term.renderInput();
          },
        }),
      );
      return;
    }

    void this.#runArgv(result.argv, ctx);
  }

  /**
   * @param {string[]} argv
   * @param {ModeContext} ctx
   * @returns {Promise<void>}
   */
  async #runArgv(argv, ctx) {
    const controller = new AbortController();

    // A running mode sits above the shell for the command's lifetime: no prompt,
    // input swallowed, Ctrl+C aborts. It is removed *by reference* rather than
    // popped, because a command may itself push a mode that outlives it -- which
    // is exactly what `ask -i` does.
    const running = new RunningMode({ abort: controller, label: argv[0] });
    ctx.term.pushMode(running);

    // Everything the command writes is collected here and announced once, after it
    // finishes. Buffering rather than announcing per row is what makes the screen
    // reader hear one coherent block instead of a line at a time -- and it is also
    // what gives `ask` the right behaviour for free, since a token stream announced
    // as it arrives would interrupt itself continuously.
    /** @type {Line[]} */
    const announced = [];

    const status = await dispatch(
      argv,
      {
        registry: this.#deps.registry,
        env: this.#deps.env,
        resume: this.#deps.resume,
        history: this.#deps.history,
        motd: this.#deps.motd,
        term: ctx.term,
        out: (line) => {
          announced.push(line);
          ctx.out.row(line);
        },
        rows: (lines) => {
          announced.push(...lines);
          ctx.out.rows(lines);
        },
        err: (text) => {
          const line = [c(text, "error")];
          announced.push(line);
          ctx.out.row(line);
        },
      },
      controller.signal,
    );

    this.#deps.announcer?.rows(announced);

    ctx.term.removeMode(running);
    this.#deps.env.setStatus(status);
    ctx.term.renderInput();
  }
}

/**
 * @param {string[]} items
 * @returns {string}
 */
function longestCommonPrefix(items) {
  const first = items[0] ?? "";
  let n = first.length;
  for (const s of items) {
    let i = 0;
    while (i < n && i < s.length && s[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n);
}
