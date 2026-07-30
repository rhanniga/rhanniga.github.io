// @ts-check
/**
 * The mode stack.
 *
 * Not a flag, and not an enum: a stack. The reason is `ask -i`. Running a query
 * inside the sub-REPL pushes a running mode *on top of* the repl mode, so Ctrl+C
 * during generation aborts the query and returns to `ask>` rather than dropping
 * all the way out to `$`. An enum cannot express that without a
 * "previous mode" variable, which is exactly the ad-hoc flag this avoids.
 *
 * The prompt is the mode indicator -- each mode renders its own, and a null
 * prompt means no prompt at all (which is what a real shell shows while a
 * command is running).
 */

/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('./line-buffer.js').LineBuffer} LineBuffer */

/**
 * What a mode is handed on every callback.
 * @typedef {object} ModeContext
 * @property {import('./terminal.js').TerminalApi} term
 * @property {import('./writer.js').Writer} out
 */

/**
 * @typedef {object} TerminalMode
 * @property {string} id
 * @property {string} label                     shown in document.title
 * @property {boolean} editable                 does it render an editable line?
 * @property {LineBuffer | null} buffer          for cursor rendering; null if not editable
 * @property {() => Line | null} prompt          null renders no prompt line at all
 * @property {(ev: KeyEvent, ctx: ModeContext) => void | Promise<void>} onKey
 * @property {(text: string, ctx: ModeContext) => void} onInsertText
 * @property {(ctx: ModeContext) => void} [onEnter]
 * @property {(ctx: ModeContext) => void} [onExit]
 */

export class ModeStack {
  /** @type {TerminalMode[]} */ #stack = [];
  /** @type {ModeContext} */ #ctx;
  /** @type {() => void} */ #onChange;

  /**
   * @param {ModeContext} ctx
   * @param {() => void} onChange called after any push/pop so the host can
   *   re-render the prompt and retitle the document
   */
  constructor(ctx, onChange) {
    this.#ctx = ctx;
    this.#onChange = onChange;
  }

  get depth() {
    return this.#stack.length;
  }

  /**
   * The active mode.
   * @returns {TerminalMode}
   */
  top() {
    const m = this.#stack[this.#stack.length - 1];
    if (m === undefined) throw new Error("mode stack is empty");
    return m;
  }

  /** @param {TerminalMode} mode */
  push(mode) {
    this.#stack.push(mode);
    mode.onEnter?.(this.#ctx);
    this.#onChange();
  }

  /**
   * Pop the active mode. Refuses to empty the stack -- there must always be a
   * mode to route keys to.
   * @returns {TerminalMode | null} the popped mode
   */
  pop() {
    if (this.#stack.length <= 1) return null;
    const mode = this.#stack.pop();
    if (mode === undefined) return null;
    mode.onExit?.(this.#ctx);
    this.#onChange();
    return mode;
  }

  /**
   * @param {string} id
   * @returns {TerminalMode | undefined}
   */
  find(id) {
    return this.#stack.find((m) => m.id === id);
  }
}
