// @ts-check
/**
 * Typed access to the wasm engine.
 *
 * The one thing this file exists for: **`memory.grow` detaches every existing
 * TypedArray over `memory.buffer`.** A view captured before a growth silently reads
 * zeroes and writes nowhere -- no exception, no warning. The plan named this the most
 * likely JS-side bug in the project, and it is the reason nothing outside this
 * module ever touches `memory.buffer` directly.
 *
 * Growth happens on every ml_alloc, and ml_init makes about six of them, so this is
 * not a rare edge case. It is the normal path.
 */

/** Mirrors the ML_ERR_* codes in engine/engine.h. */
export const ML_ERR = {
  0: "ok",
  [-1]: "bad magic or unsupported version",
  [-2]: "weight buffer is truncated",
  [-3]: "out of memory",
  [-4]: "requested context exceeds the model's maximum",
  [-5]: "unsupported quantization for this build",
  [-6]: "engine not initialised",
};

/**
 * @typedef {object} Engine
 * @property {WebAssembly.Memory} memory
 * @property {() => Uint8Array} u8      always-valid heap view
 * @property {() => Float32Array} f32
 * @property {(n: number) => number} alloc
 * @property {(ptr: number, len: number, nCtx: number) => number} init
 * @property {() => void} shutdown
 * @property {(token: number, pos: number) => void} forward
 * @property {() => Float32Array} logits
 * @property {(t: number, p: number, k: number, rp: number, rw: number) => number} sample
 * @property {(lo: number, hi: number) => void} seed
 * @property {() => void} historyClear
 * @property {() => number} nVocab
 * @property {() => number} nCtx
 * @property {() => number} eosId
 * @property {() => number} bosId
 * @property {(nPos: number) => number} kvBytes
 * @property {(dst: number, nPos: number) => void} kvSave
 * @property {(src: number, nPos: number) => void} kvLoad
 * @property {() => string} modelSha256
 */

/**
 * Instantiate the engine.
 *
 * No import object is passed, and none is needed: the module has zero imports and
 * exports its own memory. That is asserted here rather than assumed, because an
 * unexpected import would mean the freestanding build had quietly acquired a
 * dependency on something.
 *
 * @param {BufferSource} wasmBytes
 * @returns {Promise<Engine>}
 */
export async function instantiate(wasmBytes) {
  const module = await WebAssembly.compile(wasmBytes);

  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    throw new Error(
      `engine.wasm should have no imports, found: ` +
        imports.map((i) => `${i.module}.${i.name}`).join(", "),
    );
  }

  const instance = await WebAssembly.instantiate(module);
  const ex = /** @type {Record<string, any>} */ (instance.exports);
  const memory = /** @type {WebAssembly.Memory} */ (ex["memory"]);
  if (memory === undefined) throw new Error("engine.wasm does not export memory");

  /* ── The re-view guards ────────────────────────────────────────────────
   * Compare buffer identity, not byteLength: a detached buffer reports
   * byteLength 0, but relying on that would also rebuild views for other reasons.
   * Identity is the actual signal. */
  /** @type {ArrayBuffer | null} */
  let cached = null;
  /** @type {Uint8Array} */
  let viewU8 = new Uint8Array(0);
  /** @type {Float32Array} */
  let viewF32 = new Float32Array(0);

  const refresh = () => {
    if (memory.buffer !== cached) {
      cached = memory.buffer;
      viewU8 = new Uint8Array(cached);
      viewF32 = new Float32Array(cached);
    }
  };
  refresh();

  const u8 = () => {
    refresh();
    return viewU8;
  };
  const f32 = () => {
    refresh();
    return viewF32;
  };

  return {
    memory,
    u8,
    f32,
    alloc: (n) => ex["ml_alloc"](n),
    init: (ptr, len, nCtx) => ex["ml_init"](ptr, len, nCtx),
    shutdown: () => ex["ml_shutdown"](),
    forward: (token, pos) => ex["ml_forward"](token, pos),
    logits: () => {
      const ptr = ex["ml_logits"]();
      const n = ex["ml_n_vocab"]();
      // A fresh view every call, for the same reason: the pointer is stable but the
      // buffer behind it may not be.
      refresh();
      return new Float32Array(memory.buffer, ptr, n);
    },
    sample: (t, p, k, rp, rw) => ex["ml_sample"](t, p, k, rp, rw),
    seed: (lo, hi) => ex["ml_seed"](lo, hi),
    historyClear: () => ex["ml_history_clear"](),
    nVocab: () => ex["ml_n_vocab"](),
    nCtx: () => ex["ml_n_ctx"](),
    eosId: () => ex["ml_eos_id"](),
    bosId: () => ex["ml_bos_id"](),
    kvBytes: (nPos) => ex["ml_kv_bytes"](nPos),
    kvSave: (dst, nPos) => ex["ml_kv_save"](dst, nPos),
    kvLoad: (src, nPos) => ex["ml_kv_load"](src, nPos),
    modelSha256: () => {
      const ptr = ex["ml_model_sha256"]();
      const bytes = u8().subarray(ptr, ptr + 32);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    },
  };
}

/**
 * Allocate space in linear memory and return the pointer.
 * @param {Engine} engine
 * @param {number} bytes
 * @returns {number}
 * @throws {Error} on OOM
 */
export function allocOrThrow(engine, bytes) {
  const ptr = engine.alloc(bytes);
  if (ptr === 0) {
    throw new Error(
      `out of memory allocating ${(bytes / 1e6).toFixed(1)} MB in wasm linear memory`,
    );
  }
  return ptr;
}

/**
 * @param {number} code
 * @returns {string}
 */
export function describeError(code) {
  return /** @type {any} */ (ML_ERR)[code] ?? `unknown error ${code}`;
}
