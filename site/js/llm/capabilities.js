// @ts-check
/**
 * Browser capability probes.
 *
 * M5 needs only the WebAssembly and SIMD checks, for the boot POST. M13 extends
 * this with the memory-reservation probe and the decision about whether to run
 * the model at all or fall back to keyword search.
 */

/**
 * A module whose exported function returns a v128, so validation fails on any
 * engine without the SIMD proposal. This is the canonical wasm-feature-detect
 * byte sequence; it is verified to reject both a corrupted variant and
 * non-wasm input, which matters because `validate` returning true for junk would
 * make the probe meaningless.
 */
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

/** @type {boolean | null} */
let simdCache = null;

/** @returns {boolean} */
export function hasWasm() {
  return typeof WebAssembly !== "undefined" && typeof WebAssembly.validate === "function";
}

/**
 * SIMD is Chrome 91+, Firefox 89+, Safari 16.4+, so this is a small minority of
 * traffic -- but the scalar build is roughly 4x slower, which turns a 15s prompt
 * read into a minute. M13 uses this to default those visitors to keyword search
 * instead.
 * @returns {boolean}
 */
export function hasSimd() {
  if (simdCache !== null) return simdCache;
  if (!hasWasm()) {
    simdCache = false;
    return false;
  }
  try {
    simdCache = WebAssembly.validate(SIMD_MODULE);
  } catch {
    simdCache = false;
  }
  return simdCache;
}
