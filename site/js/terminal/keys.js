// @ts-check
/**
 * Keyboard event normalization.
 *
 * One place that turns a raw KeyboardEvent into a semantic action, so modes
 * switch on intent (`kill-to-end`) rather than on key geometry
 * (`ev.ctrlKey && ev.key === 'k'`). Printable text does NOT come through here --
 * it arrives via the textarea's `input` event, which is what makes IME
 * composition and mobile autocorrect work uniformly.
 */

/**
 * @typedef {'enter'|'backspace'|'delete'|'left'|'right'|'up'|'down'
 *          |'home'|'end'|'word-left'|'word-right'
 *          |'kill-to-start'|'kill-to-end'|'kill-word'|'yank'
 *          |'clear'|'interrupt'|'eof'|'tab'|'tab-back'
 *          |'page-up'|'page-down'|'scroll-top'|'scroll-bottom'
 *          |'none'} KeyAction
 */

/**
 * @typedef {object} KeyEvent
 * @property {KeyAction} action
 * @property {string} key      the raw `ev.key`
 * @property {boolean} ctrl
 * @property {boolean} alt
 * @property {boolean} shift
 * @property {KeyboardEvent} raw
 */

/**
 * True if this keystroke should produce a character. Used to decide whether to
 * re-focus the keyboard sink so the `input` event fires.
 * @param {KeyboardEvent} ev
 * @returns {boolean}
 */
export function isPrintable(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  // ev.key is a single grapheme for printable keys and a name like "ArrowLeft"
  // otherwise. Array.from handles astral-plane characters.
  return Array.from(ev.key).length === 1;
}

/**
 * @param {KeyboardEvent} ev
 * @returns {KeyEvent}
 */
export function normalize(ev) {
  const ctrl = ev.ctrlKey;
  const alt = ev.altKey;
  const shift = ev.shiftKey;
  const k = ev.key;
  /** @type {KeyAction} */
  let action = "none";

  if (ctrl && !alt) {
    switch (k.toLowerCase()) {
      // Ctrl+A is beginning-of-line, always. Meta+A (macOS select-all) is
      // deliberately left to the browser.
      case "a": action = "home"; break;
      case "e": action = "end"; break;
      case "b": action = "left"; break;
      case "f": action = "right"; break;
      case "p": action = "up"; break;
      case "n": action = "down"; break;
      case "u": action = "kill-to-start"; break;
      case "k": action = "kill-to-end"; break;
      case "w": action = "kill-word"; break;
      case "y": action = "yank"; break;
      case "l": action = "clear"; break;
      case "c": action = "interrupt"; break;
      case "d": action = "eof"; break;
      case "h": action = "backspace"; break;
      // Ctrl+Arrow arrives as key "ArrowLeft"/"ArrowRight".
      case "arrowleft": action = "word-left"; break;
      case "arrowright": action = "word-right"; break;
      case "arrowup": action = "up"; break;
      case "arrowdown": action = "down"; break;
      default: action = "none";
    }
    return { action, key: k, ctrl, alt, shift, raw: ev };
  }

  if (alt && !ctrl) {
    switch (k.toLowerCase()) {
      case "b": action = "word-left"; break;
      case "f": action = "word-right"; break;
      // The reliable kill-word binding. Ctrl+W is the one every shell user
      // reaches for, but Chrome and Firefox both close the tab on it and do not
      // allow preventDefault, so it cannot be honoured on the web. Alt+Backspace
      // is preventable and does the same job.
      case "backspace": action = "kill-word"; break;
      default: action = "none";
    }
    return { action, key: k, ctrl, alt, shift, raw: ev };
  }

  switch (k) {
    case "Enter": action = "enter"; break;
    case "Backspace": action = "backspace"; break;
    case "Delete": action = "delete"; break;
    case "ArrowLeft": action = "left"; break;
    case "ArrowRight": action = "right"; break;
    case "ArrowUp": action = "up"; break;
    case "ArrowDown": action = "down"; break;
    case "Home": action = shift ? "scroll-top" : "home"; break;
    case "End": action = shift ? "scroll-bottom" : "end"; break;
    case "PageUp": action = "page-up"; break;
    case "PageDown": action = "page-down"; break;
    case "Tab": action = shift ? "tab-back" : "tab"; break;
    default: action = "none";
  }

  return { action, key: k, ctrl, alt, shift, raw: ev };
}

const DEL = 0x7f;
const SPACE = 0x20;

/**
 * Strip a pasted string down to something a single-line buffer can hold.
 *
 * Newlines collapse to a single space rather than being treated as Enter. That
 * keeps the one-line invariant, and -- more importantly -- means pasting a block
 * of shell history does not silently execute every line of it.
 *
 * Deliberately not trimmed: a trailing space from a copied newline is harmless
 * to the tokenizer, and trimming would silently alter a paste the user meant to
 * be exact.
 *
 * Filters C0 controls and DEL by code point rather than with a character class,
 * so no control characters appear in this source file -- a literal NUL byte here
 * would make git treat the module as binary.
 * @param {string} s
 * @returns {string}
 */
export function sanitizePaste(s) {
  const flat = s.replace(/\r\n?/g, "\n").replace(/\n+/g, " ");
  let out = "";
  // for..of iterates code points, so surrogate pairs survive intact.
  for (const ch of flat) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    // A control byte reaching the line buffer would render as a zero-width cell
    // and desync the cursor from the visible text.
    if (cp < SPACE || cp === DEL) continue;
    out += ch;
  }
  return out;
}
