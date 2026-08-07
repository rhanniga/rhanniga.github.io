// @ts-check
/**
 * A mode that owns a redrawable panel: the terminal's answer to a curses app.
 *
 * There is no alternate screen buffer here and there is deliberately not going to
 * be one. A widget draws into a transient *block* inside the normal scrollback, so
 * everything above it stays where it was, the page scrollbar still means what it
 * meant, and text selection still works across the whole session. What the visitor
 * gets is a panel that redraws in place; what they keep afterwards is a final frame
 * in the transcript, which is what a shell leaves behind.
 *
 * The status line is rendered through the mode's `prompt()`, so it lands in the
 * input line at the bottom of the viewport -- pinned, tinted, and already the one
 * element the eye is drawn to. That is a status bar without building one.
 *
 * Generic on purpose, the same way ReplMode is: `rent` is the first widget and
 * nothing here knows about it.
 */

import { applyScroll } from "./editing.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../render/chunk.js').Line} Line */

/**
 * What a widget asks the host to do with a keystroke.
 *
 * `none` exists separately from `repaint` so that keys a widget does not use cost
 * nothing -- on a phone every stray autocorrect insertion arrives here.
 *
 * @typedef {'repaint'|'none'|'exit'} WidgetAction
 */

/**
 * @typedef {object} Widget
 * @property {string} id
 * @property {string} label                          document.title while it is up
 * @property {(cols: number) => Line[]} render       the live frame
 * @property {(cols: number) => Line[]} summary      the frame left in scrollback
 * @property {(cols: number) => Line} status         the status bar
 * @property {(ev: KeyEvent) => WidgetAction} onKey
 * @property {(text: string) => WidgetAction} onText printable input
 * @property {() => void} [onClose]                  teardown, however it happened
 */

/** @implements {TerminalMode} */
export class WidgetMode {
  /**
   * No editable line and no cursor: the widget draws its own selection marker, and
   * a block cursor parked in the status bar would compete with it for attention.
   */
  editable = false;
  buffer = null;

  /** @type {import('./writer.js').TransientBlock | null} */ #block = null;
  /** @type {(() => void) | null} */ #unwatch = null;
  /** @type {number} */ #cols = 80;

  /** @param {Widget} widget */
  constructor(widget) {
    this.widget = widget;
    this.id = widget.id;
    this.label = widget.label;
  }

  prompt() {
    return this.widget.status(this.#cols);
  }

  /** @param {ModeContext} ctx */
  onEnter(ctx) {
    this.#cols = ctx.term.cols();
    this.#open(ctx);
    // Rotating a phone or dragging a window edge changes the column count, and a
    // fixed-width panel drawn for the old width is visibly broken. Fires only on an
    // actual change, so this is not a repaint-per-pixel.
    this.#unwatch = ctx.term.onResize((cols) => {
      this.#cols = cols;
      this.#paint();
    });
  }

  /** @param {ModeContext} ctx */
  onExit(ctx) {
    this.#unwatch?.();
    this.#unwatch = null;
    // Before the last frame is drawn, so a widget that persists state on close has
    // already done it -- and so it runs on every exit path, including `exit` typed
    // at the shell tearing the stack down.
    this.widget.onClose?.();
    // Replace the live frame with the static one and stop touching it. Leaving the
    // interactive frame up would advertise keys that no longer do anything.
    this.#block?.set(this.widget.summary(this.#cols));
    this.#block?.commit();
    this.#block = null;
    ctx.term.scrollToBottom();
  }

  /**
   * @param {string} text
   * @param {ModeContext} ctx
   */
  onInsertText(text, ctx) {
    this.#act(this.widget.onText(text), ctx);
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    // Ctrl+L is the host's to handle, not the widget's: the block lives in the
    // output the clear is about to wipe, so it has to be reopened afterwards or the
    // widget would keep redrawing into a detached node and appear to vanish.
    if (ev.action === "clear") {
      this.#block?.discard();
      this.#block = null;
      ctx.term.clear();
      this.#open(ctx);
      return;
    }
    // Scrollback stays reachable, as in every other mode.
    if (applyScroll(ev.action, ctx.term)) return;

    this.#act(this.widget.onKey(ev), ctx);
  }

  /** @param {ModeContext} ctx */
  #open(ctx) {
    this.#block = ctx.term.transientBlock();
    this.#paint();
  }

  #paint() {
    this.#block?.set(this.widget.render(this.#cols));
  }

  /**
   * @param {WidgetAction} action
   * @param {ModeContext} ctx
   */
  #act(action, ctx) {
    if (action === "exit") {
      ctx.term.removeMode(this); // triggers onExit, which commits the final frame
      return;
    }
    if (action === "repaint") {
      this.#paint();
      // The status bar is part of the prompt, so it only updates when the host
      // re-renders the input line.
      ctx.term.renderInput();
    }
  }
}
