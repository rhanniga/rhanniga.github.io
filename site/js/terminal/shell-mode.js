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
import { tokenize, describeError } from "../shell/tokenize.js";
import { dispatch } from "../shell/dispatch.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../shell/registry.js').Registry} Registry */

/**
 * @typedef {object} ShellDeps
 * @property {Registry} registry
 * @property {import('../shell/env.js').Env} env
 * @property {import('../data/types.js').Resume} resume
 * @property {History} history
 * @property {() => void} motd
 */

/** @implements {TerminalMode} */
export class ShellMode {
  id = "shell";
  label = "visitor@hannigan.sh: ~";
  editable = true;
  buffer = new LineBuffer();

  /** @type {ShellDeps} */ #deps;
  /** In-flight command, so Ctrl+C can abort it. @type {AbortController | null} */
  #running = null;
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

      case "backspace": b.deleteBackward(); break;
      case "delete": b.deleteForward(); break;
      case "left": b.moveLeft(); break;
      case "right": b.moveRight(); break;
      case "home": b.moveHome(); break;
      case "end": b.moveEnd(); break;
      case "word-left": b.moveWordLeft(); break;
      case "word-right": b.moveWordRight(); break;
      case "kill-to-start": b.killToStart(); break;
      case "kill-to-end": b.killToEnd(); break;
      case "kill-word": b.killWordBackward(); break;
      case "yank": b.yank(); break;

      case "clear":
        ctx.term.clear();
        return;

      case "interrupt":
        // Abort a running command if there is one; otherwise abandon the line. A
        // real shell echoes ^C and leaves what you typed on screen rather than
        // erasing it.
        if (this.#running !== null) {
          this.#running.abort();
          this.#running = null;
        }
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

      case "page-up": ctx.term.scrollPages(-1); return;
      case "page-down": ctx.term.scrollPages(1); return;
      case "scroll-top": ctx.term.scrollToTop(); return;
      case "scroll-bottom": ctx.term.scrollToBottom(); return;

      case "none":
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
    this.#running = controller;

    const status = await dispatch(
      argv,
      {
        registry: this.#deps.registry,
        env: this.#deps.env,
        resume: this.#deps.resume,
        history: this.#deps.history,
        motd: this.#deps.motd,
        term: ctx.term,
        out: (line) => ctx.out.row(line),
        rows: (lines) => ctx.out.rows(lines),
        err: (text) => ctx.out.row([c(text, "error")]),
      },
      controller.signal,
    );

    this.#running = null;
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
