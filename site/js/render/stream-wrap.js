// @ts-check
/**
 * Incremental word wrapping for streamed text.
 *
 * wrapChunks() cannot do this job: it needs the whole line up front, and text
 * arriving a token at a time has no whole line yet. Re-wrapping the buffer on
 * every delta and reprinting is the obvious approach and it is wrong -- already
 * visible text would visibly reflow as the answer grows.
 *
 * So this decides each break once, at the moment a word completes, and never
 * revisits it. A token can also end mid-word, so words are buffered until
 * whitespace confirms them; wrapping on a partial word would split it.
 */

/**
 * @typedef {object} StreamWrapper
 * @property {(text: string) => void} push  feed arbitrary text
 * @property {() => void} end              flush the last partial word and newline
 * @property {() => boolean} isEmpty       nothing emitted yet
 */

/**
 * @param {(text: string) => void} write
 * @param {{ width: number, indent?: number }} opts
 * @returns {StreamWrapper}
 */
export function streamWrapper(write, opts) {
  const indent = opts.indent ?? 0;
  const width = Math.max(indent + 8, opts.width);
  const pad = " ".repeat(indent);

  let col = 0;
  let pending = "";
  let started = false;

  /** @param {string} word */
  const emit = (word) => {
    if (word === "") return;
    if (!started) {
      write(pad);
      col = indent;
      started = true;
    } else if (col + 1 + word.length > width) {
      write("\n" + pad);
      col = indent;
    } else {
      write(" ");
      col += 1;
    }
    write(word);
    col += word.length;
  };

  return {
    push: (text) => {
      for (const ch of text) {
        if (/\s/.test(ch)) {
          emit(pending);
          pending = "";
        } else {
          pending += ch;
        }
      }
    },
    end: () => {
      emit(pending);
      pending = "";
      if (started) write("\n");
    },
    isEmpty: () => !started && pending === "",
  };
}
