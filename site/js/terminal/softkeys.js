// @ts-check
/**
 * The soft-key toolbar.
 *
 * Not decoration, and not a convenience. On-screen keyboards on iOS and Android have
 * no Ctrl key and no arrow keys, so without this, command history, tab completion, and
 * aborting a running command are *literally unreachable* on a phone -- a visitor could
 * type `ask "..."`, watch it run for thirty seconds, and have no way to stop it.
 *
 * Shown only for a coarse pointer, via CSS. Deciding in CSS rather than JS means a
 * desktop with a touchscreen gets it when touch is the pointer being used, and the
 * markup costs nothing when it is not: `.softkeys { display: none }` unless
 * `@media (pointer: coarse)`.
 *
 * `pointerdown` rather than `click`, with preventDefault: on iOS, tapping a button
 * blurs the textarea, which dismisses the keyboard and shifts the layout under the
 * visitor's finger. Preventing the default keeps focus where it is, so the keyboard
 * stays up and the toolbar behaves like part of it.
 */

/** @typedef {import('./keys.js').KeyAction} KeyAction */
/** @typedef {import('./terminal.js').TerminalApi} TerminalApi */

/**
 * The five that matter, in the order a thumb expects.
 *
 * Labels are the terminal's own notation -- `^C` rather than "Cancel" -- because
 * anyone who understands what this site is will read them faster, and `aria-label`
 * carries the plain-language version for anyone who does not.
 *
 * @type {Array<{label: string, action: KeyAction, aria: string}>}
 */
const KEYS = [
  { label: "tab", action: "tab", aria: "Tab, complete the current word" },
  { label: "↑", action: "up", aria: "Previous command" },
  { label: "↓", action: "down", aria: "Next command" },
  { label: "^C", action: "interrupt", aria: "Control-C, cancel" },
  { label: "^L", action: "clear", aria: "Control-L, clear the screen" },
];

/**
 * Build the toolbar and wire it to the mode stack.
 *
 * @param {HTMLElement | null} host
 * @param {TerminalApi} term
 * @param {() => void} focus  Refocus the keyboard sink.
 * @returns {boolean} whether the toolbar was installed
 */
export function mountSoftkeys(host, term, focus) {
  if (host === null) return false;

  for (const key of KEYS) {
    const button = document.createElement("button");
    // Explicitly type=button: the default is submit, and a stray form ancestor
    // would turn every soft key into a page reload.
    button.type = "button";
    button.textContent = key.label;
    button.setAttribute("aria-label", key.aria);
    // Not reachable by Tab: Tab is a terminal key here, and putting five buttons in
    // the tab order would make it impossible to Tab-complete with a real keyboard.
    button.tabIndex = -1;

    button.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      term.sendKey(key.action);
      // The tap may still have moved focus on browsers without pointer capture.
      focus();
    });

    host.appendChild(button);
  }

  host.hidden = false;
  return true;
}
