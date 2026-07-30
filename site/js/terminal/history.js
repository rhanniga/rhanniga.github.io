// @ts-check
/**
 * Command history.
 *
 * Persisted, so a returning visitor gets their history back -- a
 * disproportionately large authenticity win for the cost.
 *
 * The part that is easy to get wrong is draft preservation: pressing Up from a
 * half-typed line must stash it, and walking back Down past the newest entry must
 * restore it verbatim. Getting that wrong is immediately noticeable, so it is
 * tested directly.
 */

import { load, save, remove } from "../util.js";

const CAP = 500;

export class History {
  /** @type {string[]} oldest first */ #entries = [];
  /** Cursor into #entries. Equal to #entries.length means "on the draft line". */
  #idx = 0;
  /** The partially-typed line stashed when the user first pressed Up. */
  #draft = "";
  /** @type {string} */ #key;

  /**
   * @param {string} namespace e.g. 'shell' or 'ask'. `ask -i` keeps its own
   *   history, which falls out of the mode design for free.
   */
  constructor(namespace) {
    this.#key = `history:${namespace}`;
    this.#load();
    this.#idx = this.#entries.length;
  }

  /** @returns {readonly string[]} */
  entries() {
    return this.#entries;
  }

  get length() {
    return this.#entries.length;
  }

  /**
   * Record a submitted line.
   *
   * Skips blanks and consecutive duplicates, matching bash's
   * `HISTCONTROL=ignoredups` -- without it, holding Enter or re-running the same
   * command fills history with noise.
   * @param {string} line
   */
  push(line) {
    const trimmed = line.trim();
    if (trimmed !== "" && this.#entries[this.#entries.length - 1] !== line) {
      this.#entries.push(line);
      if (this.#entries.length > CAP) {
        this.#entries.splice(0, this.#entries.length - CAP);
      }
      this.#save();
    }
    this.reset();
  }

  /**
   * Walk backwards. Pass the line currently being edited so it can be stashed.
   * @param {string} draft
   * @returns {string | null} the recalled line, or null if already at the oldest
   */
  prev(draft) {
    if (this.#entries.length === 0) return null;
    // Stash on the first Up only -- walking further back must not overwrite it.
    if (this.#idx === this.#entries.length) this.#draft = draft;
    if (this.#idx === 0) return null;
    this.#idx--;
    return this.#entries[this.#idx] ?? null;
  }

  /**
   * Walk forwards. Stepping past the newest entry restores the stashed draft.
   * @returns {string | null} the recalled line, or null if already on the draft
   */
  next() {
    if (this.#idx >= this.#entries.length) return null;
    this.#idx++;
    if (this.#idx === this.#entries.length) return this.#draft;
    return this.#entries[this.#idx] ?? null;
  }

  /** Called on Enter: return to the draft line and forget the stash. */
  reset() {
    this.#idx = this.#entries.length;
    this.#draft = "";
  }

  /** `history -c`. Clears memory and storage together. */
  clear() {
    this.#entries = [];
    this.reset();
    remove(this.#key);
  }

  #load() {
    const raw = load(this.#key);
    if (raw === null) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.#entries = parsed.filter((v) => typeof v === "string").slice(-CAP);
      }
    } catch {
      // Corrupt or hand-edited storage: start clean rather than throwing during
      // construction and taking the whole terminal down with it.
      remove(this.#key);
    }
  }

  #save() {
    save(this.#key, JSON.stringify(this.#entries));
  }
}
