// @ts-check
/**
 * The screen-reader sink.
 *
 * There are two output paths, and this is the second one. `#output` is the visual
 * terminal: hard-wrapped to the column count, styled, and `aria-hidden="true"`.
 * `#announcer` is a visually-hidden `role="log"` region that receives the same content
 * as complete, unwrapped, plain-text blocks.
 *
 * Two separate paths rather than one, for two reasons:
 *
 * **Streaming into a live region is worse than silence.** `ask` emits tokens; a live
 * region announces each mutation, so a shared path would read an answer out one
 * fragment at a time, interrupting itself continuously. So `ask` announces once, at the
 * end, as a single block.
 *
 * **Hard-wrapped text is actively hostile to a screen reader.** A 42-column wrap
 * injects a line break every few words, and many screen readers treat a line break as a
 * pause or a new item -- so a wrapped paragraph is read as a stack of fragments. The
 * unwrapping here is not a compromise for the visual layout's benefit; the
 * screen-reader path gets genuinely better text than the screen does.
 *
 * Unwrapping works by reversing what `wrapChunks` did: consecutive non-blank lines were
 * one paragraph, so they rejoin with a space; a blank line was a paragraph break, so it
 * stays one. That relies on the wrapper stripping trailing whitespace, which it does
 * centrally in `flush()`.
 */

/** @typedef {import('./chunk.js').Line} Line */

/**
 * How many blocks to keep in the log.
 *
 * A `role="log"` region grows forever otherwise, and some screen readers re-read
 * accumulated content when focus moves into it. Old blocks have already been announced;
 * keeping them serves nobody.
 */
const MAX_BLOCKS = 12;

/**
 * Join wrapped lines back into paragraphs.
 *
 * @param {Line[]} lines
 * @returns {string} plain text, one paragraph per line, no wrapping
 */
export function unwrap(lines) {
  /** @type {string[]} */
  const paragraphs = [];
  /** @type {string[]} */
  let current = [];

  const flush = () => {
    if (current.length > 0) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  };

  for (const line of lines) {
    const text = line.map((ch) => ch.t).join("");
    // Collapse the runs of spaces used for indentation and column alignment. They are
    // layout, and a screen reader announcing "space space space" or pausing through
    // them conveys nothing.
    const squeezed = text.replace(/\s+/g, " ").trim();
    if (squeezed === "") flush();
    else current.push(squeezed);
  }
  flush();

  return paragraphs.join("\n");
}

/**
 * @typedef {object} Announcer
 * @property {(lines: Line[]) => void} rows   Announce a block of rendered lines.
 * @property {(text: string) => void} say     Announce a plain string.
 * @property {() => void} clear
 */

/**
 * @param {HTMLElement | null} host
 * @returns {Announcer}
 */
export function createAnnouncer(host) {
  // A missing #announcer must not break the terminal, so every method degrades to a
  // no-op rather than throwing. The site works; it is just less accessible, which is
  // exactly the tradeoff a missing element implies.
  if (host === null) {
    return { rows: () => {}, say: () => {}, clear: () => {} };
  }

  /** @param {string} text */
  function push(text) {
    if (text === "") return;
    // A fresh element per block, not appended text. With `aria-atomic="false"` a
    // screen reader announces the added node, and giving each block its own element
    // is what makes "the added node" mean "this block" rather than "everything".
    const block = document.createElement("p");
    block.textContent = text;
    host.appendChild(block);
    while (host.childElementCount > MAX_BLOCKS) {
      host.removeChild(/** @type {Node} */ (host.firstChild));
    }
  }

  return {
    rows: (lines) => push(unwrap(lines)),
    say: (text) => push(text.replace(/\s+/g, " ").trim()),
    clear: () => {
      host.textContent = "";
    },
  };
}
