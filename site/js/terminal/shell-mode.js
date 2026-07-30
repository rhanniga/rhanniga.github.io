// @ts-check
/**
 * The PS1 mode: line editing plus command submission.
 *
 * M2 scope is deliberately narrow -- it owns the line buffer and the full readline
 * keymap, and submitting a line prints `command not found`. The real tokenizer,
 * flag parsing, command registry, and history all arrive in M3; this milestone
 * exists to prove the *feel* is right before anything is built on top of it.
 */

import { c } from "../render/chunk.js";
import { LineBuffer } from "./line-buffer.js";
import { ps1 } from "./prompt.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */

/** @implements {TerminalMode} */
export class ShellMode {
  id = "shell";
  label = "visitor@hannigan.sh: ~";
  editable = true;
  buffer = new LineBuffer();

  prompt() {
    return ps1();
  }

  /**
   * @param {string} text
   * @param {ModeContext} ctx
   */
  onInsertText(text, ctx) {
    this.buffer.insert(text);
    ctx.term.renderInput();
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    const b = this.buffer;

    switch (ev.action) {
      case "enter":
        this.#submit(ctx);
        break;

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
        return; // clear() already re-rendered

      case "interrupt":
        // A real shell echoes ^C, abandons the line, and gives you a fresh
        // prompt -- it does not erase what you had typed from the screen.
        ctx.out.row([...ps1(), c(b.value), c("^C", "dim")]);
        b.clear();
        break;

      case "eof":
        // bash: Ctrl+D on an empty line is EOF; on a non-empty line it is
        // delete-forward. Matching this is the difference between muscle memory
        // working and not.
        if (b.isEmpty) {
          ctx.out.row([...ps1(), c("logout", "dim")]);
        } else {
          b.deleteForward();
        }
        break;

      case "page-up": ctx.term.scrollPages(-1); return;
      case "page-down": ctx.term.scrollPages(1); return;
      case "scroll-bottom": ctx.term.scrollToBottom(); return;

      // History (up/down) and completion (tab) land in M3.
      case "up":
      case "down":
      case "tab":
      case "tab-back":
      case "scroll-top":
      case "none":
        break;
    }

    ctx.term.renderInput();
  }

  /**
   * @param {ModeContext} ctx
   */
  #submit(ctx) {
    const line = this.buffer.value;
    this.buffer.clear();

    // Commit the prompt + what was typed as a permanent row, exactly as a
    // terminal leaves the submitted line on screen.
    ctx.out.row([...ps1(), c(line)]);

    const trimmed = line.trim();
    if (trimmed === "") return;

    // M2 placeholder: whitespace split. The real POSIX-ish tokenizer, with
    // quote handling and $? expansion, is M3.
    const name = trimmed.split(/\s+/)[0] ?? "";
    ctx.out.row([c(`bash: ${name}: command not found`, "error")]);
  }
}
