// @ts-check
/**
 * Plain line-editing actions, shared by every editable mode.
 *
 * ShellMode, ContinuationMode and ReplMode all need the identical readline
 * keymap and differ only in what they do with Enter, Tab, Ctrl+C and Ctrl+D.
 * Keeping the common half in one place means a fix to word motion cannot land in
 * two of the three.
 */

/** @typedef {import('./line-buffer.js').LineBuffer} LineBuffer */
/** @typedef {import('./keys.js').KeyAction} KeyAction */

/**
 * Apply an editing or motion action to a buffer.
 *
 * Deliberately does NOT handle enter, tab, interrupt or eof: those mean different
 * things in each mode, and swallowing them here would hide that.
 *
 * @param {LineBuffer} b
 * @param {KeyAction} action
 * @returns {boolean} true if the action was consumed
 */
export function applyEdit(b, action) {
  switch (action) {
    case "backspace": b.deleteBackward(); return true;
    case "delete": b.deleteForward(); return true;
    case "left": b.moveLeft(); return true;
    case "right": b.moveRight(); return true;
    case "home": b.moveHome(); return true;
    case "end": b.moveEnd(); return true;
    case "word-left": b.moveWordLeft(); return true;
    case "word-right": b.moveWordRight(); return true;
    case "kill-to-start": b.killToStart(); return true;
    case "kill-to-end": b.killToEnd(); return true;
    case "kill-word": b.killWordBackward(); return true;
    case "yank": b.yank(); return true;
    default: return false;
  }
}

/**
 * Handle the viewport-scrolling actions, which every mode treats identically --
 * including modes with no editable line, since reading scrollback while a command
 * runs must keep working.
 *
 * @param {KeyAction} action
 * @param {import('./terminal.js').TerminalApi} term
 * @returns {boolean} true if the action was consumed
 */
export function applyScroll(action, term) {
  switch (action) {
    case "page-up": term.scrollPages(-1); return true;
    case "page-down": term.scrollPages(1); return true;
    case "scroll-top": term.scrollToTop(); return true;
    case "scroll-bottom": term.scrollToBottom(); return true;
    default: return false;
  }
}
