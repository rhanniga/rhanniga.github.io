// @ts-check
/**
 * Byte-level BPE, in JavaScript.
 *
 * The engine deliberately has no tokenizer: its entire input surface is an array of
 * int32 ids, and no `char*` ever crosses the wasm boundary. Encoding in C would
 * have meant a Unicode-category scanner, a hash map over 48,900 pair-keyed merge
 * rules, and a priority loop -- 400+ lines of the fiddliest code in the project,
 * with none of llama2.c's SentencePiece tokenizer reusable, since this is a
 * different algorithm entirely.
 *
 * Decoding is where the choice really pays. A token can end mid-UTF-8-sequence, and
 * `TextDecoder` with `{stream: true}` reassembles partial sequences across chunk
 * boundaries for free. In C that would be hand-rolled buffering, and the bytes
 * would still have to reach JavaScript afterwards.
 *
 * SmolLM2's tokenizer is byte-level BPE but NOT vanilla GPT-2. Two differences,
 * either of which silently corrupts every prompt if missed:
 *
 *   1. A `Digits` pre-tokenizer runs BEFORE ByteLevel, so every digit is its own
 *      token. "2023" is four ids.
 *   2. 21 of the 256 byte tokens are absent from the vocabulary, and HuggingFace
 *      silently drops those bytes rather than substituting anything.
 */

/** @typedef {{
 *   nVocab: number,
 *   byteIds: Uint16Array,
 *   merges: Map<number, number>,
 *   vocab: Uint8Array[],
 *   specials: Array<{id: number, text: string}>,
 *   specialRe: RegExp,
 * }} Tokenizer */

const MAGIC = 0x4b4f5448; // 'HTOK' little-endian
const VERSION = 2;
/** Marks a byte with no vocabulary entry. */
const NO_TOKEN = 0xffff;

/**
 * The ByteLevel pre-tokenizer's split pattern, verbatim from HuggingFace's Rust
 * implementation. The order of the alternatives is significant: the contraction
 * cases must come before the general letter run, or "don't" splits differently.
 */
const SPLIT_RE =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the binary produced by tools/export_tokenizer.py.
 *
 * The file carries no vocabulary strings at all -- they are rebuilt here. A byte
 * token is one byte, a special is its literal text, and every other token is the
 * concatenation of the two it was merged from, which works because a BPE vocabulary
 * is built by applying merges in rank order. That reconstruction turns 196 KB of
 * download into the 332 KB table decode needs, in a single pass.
 *
 * @param {ArrayBuffer | Uint8Array} buffer
 * @returns {Tokenizer}
 */
export function loadTokenizer(buffer) {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== MAGIC) throw new Error("tokenizer: bad magic");
  const version = view.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`tokenizer: version ${version}, expected ${VERSION}`);
  }
  const nVocab = view.getUint32(8, true);
  const nMerges = view.getUint32(12, true);
  const mergeBase = view.getUint32(16, true);
  const nSpecial = view.getUint16(20, true);
  const specialBlobLen = view.getUint16(22, true);

  let off = 24;

  const byteIds = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    byteIds[i] = view.getUint16(off + i * 2, true);
  }
  off += 512;

  const specialLens = bytes.subarray(off, off + nSpecial);
  off += nSpecial;
  const specialBlob = bytes.subarray(off, off + specialBlobLen);
  off += specialBlobLen;

  /** @type {Uint8Array[]} */
  const vocab = new Array(nVocab);

  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  /** @type {Array<{id: number, text: string}>} */
  const specials = [];
  let sOff = 0;
  for (let i = 0; i < nSpecial; i++) {
    const len = specialLens[i] ?? 0;
    const raw = specialBlob.subarray(sOff, sOff + len);
    sOff += len;
    vocab[i] = raw;
    specials.push({ id: i, text: decoder.decode(raw) });
  }

  for (let b = 0; b < 256; b++) {
    const id = byteIds[b] ?? NO_TOKEN;
    if (id !== NO_TOKEN) vocab[id] = new Uint8Array([b]);
  }

  /** Pair key -> merge rank. The merged id is mergeBase + rank, never stored. */
  const merges = new Map();
  for (let r = 0; r < nMerges; r++) {
    const a = view.getUint16(off + r * 4, true);
    const b = view.getUint16(off + r * 4 + 2, true);
    merges.set(a * 65536 + b, r);
    const left = vocab[a];
    const right = vocab[b];
    if (left === undefined || right === undefined) {
      throw new Error(`tokenizer: merge ${r} references an unbuilt token`);
    }
    const joined = new Uint8Array(left.length + right.length);
    joined.set(left, 0);
    joined.set(right, left.length);
    vocab[mergeBase + r] = joined;
  }

  const specialRe = new RegExp(
    `(${specials.map((s) => escapeRe(s.text)).join("|")})`,
    "g",
  );

  return { nVocab, byteIds, merges, vocab, specials, specialRe, mergeBase };
}

/**
 * The `Digits` pre-tokenizer with individual_digits, which runs BEFORE ByteLevel.
 *
 * Each digit becomes its own piece. This is the difference from vanilla GPT-2 that
 * is easiest to miss and most damaging: without it "2023" encodes as one token
 * instead of four, and every date in the prompt is wrong.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitDigits(text) {
  /** @type {string[]} */
  const out = [];
  let run = "";
  for (const ch of text) {
    // \p{N} rather than 0-9, matching Rust's char::is_numeric.
    if (/\p{N}/u.test(ch)) {
      if (run !== "") {
        out.push(run);
        run = "";
      }
      out.push(ch);
    } else {
      run += ch;
    }
  }
  if (run !== "") out.push(run);
  return out;
}

const utf8 = new TextEncoder();

/**
 * BPE over one pre-token, working entirely in id space.
 *
 * Every BPE symbol is itself a vocabulary entry -- the sequence starts as single
 * byte tokens and each merge produces another vocabulary entry -- so a merge is a
 * lookup on a pair of integers. No string concatenation happens in this loop at
 * all, which is the whole reason the merged ids are derived rather than stored.
 *
 * @param {Tokenizer} tok
 * @param {string} piece
 * @param {number[]} out
 */
function bpe(tok, piece, out) {
  const raw = utf8.encode(piece);

  /** @type {number[]} */
  const syms = [];
  for (const b of raw) {
    const id = tok.byteIds[b] ?? NO_TOKEN;
    // Drop bytes with no vocabulary entry, exactly as HuggingFace does. There is
    // no UNK token and byte_fallback is off, so there is nothing else to emit.
    if (id !== NO_TOKEN) syms.push(id);
  }
  if (syms.length === 0) return;

  const base = /** @type {any} */ (tok).mergeBase;
  for (;;) {
    let bestRank = Infinity;
    let bestAt = -1;
    for (let i = 0; i < syms.length - 1; i++) {
      const rank = tok.merges.get(
        /** @type {number} */ (syms[i]) * 65536 + /** @type {number} */ (syms[i + 1]),
      );
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestAt = i;
      }
    }
    if (bestAt < 0) break;
    syms.splice(bestAt, 2, base + bestRank);
  }

  for (const id of syms) out.push(id);
}

/**
 * Encode text to token ids.
 *
 * Specials are matched literally and never passed through BPE -- `<|im_start|>` must
 * become id 1, not the six-or-so tokens its characters would otherwise produce.
 *
 * @param {Tokenizer} tok
 * @param {string} text
 * @returns {number[]}
 */
export function encode(tok, text) {
  /** @type {number[]} */
  const out = [];
  if (text === "") return out;

  // Split on special-token boundaries first. The capture group means the specials
  // themselves appear in the result array at odd indices.
  const parts = text.split(tok.specialRe);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part === "") continue;

    const special = tok.specials.find((s) => s.text === part);
    if (special !== undefined) {
      out.push(special.id);
      continue;
    }

    for (const chunk of splitDigits(part)) {
      for (const m of chunk.matchAll(SPLIT_RE)) {
        bpe(tok, m[0], out);
      }
    }
  }
  return out;
}

/**
 * Decode ids back to text.
 * @param {Tokenizer} tok
 * @param {ArrayLike<number>} ids
 * @returns {string}
 */
export function decode(tok, ids) {
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    total += (tok.vocab[ids[i] ?? 0] ?? EMPTY).length;
  }
  const buf = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < ids.length; i++) {
    const piece = tok.vocab[ids[i] ?? 0] ?? EMPTY;
    buf.set(piece, at);
    at += piece.length;
  }
  // ignoreBOM is essential, not a detail. By default TextDecoder STRIPS a leading
  // U+FEFF, so decoding a correctly-encoded BOM returned the empty string -- the
  // bytes were right and a character silently vanished. A tokenizer decoder wants
  // the exact bytes back, not BOM-aware text loading.
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

const EMPTY = new Uint8Array(0);

/**
 * A decoder for streamed output.
 *
 * The reason this exists rather than calling decode() per token: a token's bytes can
 * end partway through a UTF-8 sequence, so decoding tokens individually would emit
 * replacement characters where a multi-byte character straddles a token boundary.
 * `TextDecoder` with `{stream: true}` holds the partial bytes until the next chunk
 * completes them -- which is precisely the guarantee the AskEngine contract requires
 * of generated deltas, and the reason it is stated there.
 *
 * @param {Tokenizer} tok
 * @returns {{push: (id: number) => string, flush: () => string}}
 */
export function streamDecoder(tok) {
  // ignoreBOM for the same reason as decode(): a leading U+FEFF is a character the
  // model emitted, not an encoding marker to be swallowed.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  return {
    push: (id) => {
      const piece = tok.vocab[id] ?? EMPTY;
      return decoder.decode(piece, { stream: true });
    },
    // Emits whatever an incomplete trailing sequence decodes to, which is how a
    // truncated generation ends without leaving bytes stranded.
    flush: () => decoder.decode(),
  };
}
