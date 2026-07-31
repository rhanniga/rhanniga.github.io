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
 * traffic. The scalar build is ~3.7x slower -- measured in M10, not estimated.
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

/* ── Memory and device signals ───────────────────────────────────────────────
 * The model needs ~151 MB of linear memory: 87 weights, 47 KV cache at nCtx=1024,
 * 16 for the prompt snapshot. Desktop browsers do not care. iOS Safari kills the
 * tab somewhere north of ~300 MB with no catchable error, and the exact threshold
 * varies by version and by what else the device is doing -- which is why the
 * breadcrumb below exists as well as this probe. */

/** Peak linear memory, in MiB, for the default nCtx. */
export const HEAP_MB_FULL = 160;
/** Peak linear memory, in MiB, at the reduced nCtx. */
export const HEAP_MB_REDUCED = 112;

/** Reduced context for constrained devices. Halves the KV cache. */
export const N_CTX_REDUCED = 512;

/** @type {Map<number, boolean>} */
const reserveCache = new Map();

/**
 * Can linear memory of this size actually be reserved?
 *
 * Cheap and non-destructive: allocating a WebAssembly.Memory of `initial` pages
 * commits the address space, and a browser unwilling to give it up throws
 * RangeError here rather than killing the tab later. Freed immediately -- this only
 * answers whether the reservation is possible right now.
 *
 * @param {number} mib
 * @returns {boolean}
 */
export function canReserve(mib) {
  if (!hasWasm()) return false;
  const cached = reserveCache.get(mib);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    const pages = Math.ceil((mib * 1024 * 1024) / 65536);
    // Dropped immediately, but reclaimed only when the collector gets to it -- so
    // this is memoised rather than re-probed. `plan()` runs on every `ask`, and
    // allocating 160 MB each time to answer a question we already answered would be
    // its own memory problem.
    const probe = new WebAssembly.Memory({ initial: pages });
    ok = probe.buffer.byteLength >= mib * 1024 * 1024;
  } catch {
    ok = false;
  }
  reserveCache.set(mib, ok);
  return ok;
}


/**
 * Device RAM in GiB, or null where the browser does not say.
 *
 * Chrome-only, and deliberately coarse (it reports 0.25/0.5/1/2/4/8) to limit
 * fingerprinting. Safari does not implement it, so `null` covers every iPhone --
 * hence the iOS check below rather than relying on this.
 *
 * @returns {number | null}
 */
export function deviceMemoryGB() {
  const value = /** @type {any} */ (globalThis.navigator)?.deviceMemory;
  return typeof value === "number" ? value : null;
}

/**
 * Is this iOS (including iPadOS, which lies about being a Mac)?
 *
 * UA sniffing, which is normally the wrong answer. It is the right one here because
 * the thing being detected is not a feature -- it is a memory ceiling enforced by
 * the OS with no API and no catchable error. iPadOS 13+ reports "Macintosh", so the
 * touch-point check is what catches it.
 *
 * @returns {boolean}
 */
export function isIOS() {
  const nav = /** @type {any} */ (globalThis.navigator);
  if (nav === undefined) return false;
  const ua = String(nav.userAgent ?? "");
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  return /Macintosh/.test(ua) && Number(nav.maxTouchPoints ?? 0) > 1;
}

/**
 * Should the context be reduced on this device?
 * @returns {boolean}
 */
export function isConstrained() {
  const gb = deviceMemoryGB();
  if (gb !== null && gb <= 4) return true;
  if (isIOS()) return true;
  return !canReserve(HEAP_MB_FULL);
}

/* ── The crash breadcrumb ────────────────────────────────────────────────────
 * When iOS Safari kills a tab for memory, nothing runs: no exception, no
 * unload handler, no console output. The page simply reloads blank. The only way
 * to know it happened is to write a mark before the risky work and clear it after,
 * then look for a stale mark on the next load.
 *
 * sessionStorage, not localStorage: this should be forgotten when the tab closes.
 * A crash six weeks ago on a different device is not evidence about today. */

const CRASH_KEY = "hannigan.sh:ask-loading";

/** @returns {Storage | null} */
function sessionStore() {
  try {
    // Present-but-throwing is the Safari private mode case, so this touches it.
    const s = globalThis.sessionStorage;
    s.getItem(CRASH_KEY);
    return s;
  } catch {
    return null;
  }
}

/** Record that a model load is starting. Call immediately before allocating. */
export function markLoadStarted() {
  try {
    sessionStore()?.setItem(CRASH_KEY, String(Date.now()));
  } catch {
    /* no breadcrumb; the load still proceeds */
  }
}

/** Record that the load survived. */
export function markLoadFinished() {
  try {
    sessionStore()?.removeItem(CRASH_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Did a previous load in this tab die without finishing?
 *
 * A stale mark means the tab was killed mid-load -- or, less often, that the visitor
 * navigated away during the download. Both are reasons not to try the same thing
 * again unasked.
 *
 * @returns {boolean}
 */
export function crashedLastTime() {
  const store = sessionStore();
  if (store === null) return false;
  try {
    return store.getItem(CRASH_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Test seam: forget the memoised probe results.
 *
 * Both caches are correct in a browser -- neither SIMD support nor the address space
 * changes within a page load -- and both make the module untestable without this,
 * because a test that swaps in a fake `WebAssembly` gets the answer computed from the
 * real one. Mirrors resetEngineCache() in engine.js.
 */
export function resetProbeCache() {
  simdCache = null;
  reserveCache.clear();
}

/* ── The decision ────────────────────────────────────────────────────────── */

/**
 * @typedef {object} Plan
 * @property {'llm'|'grep'} mode
 * @property {string} [reason]  Why grep-mode, phrased for a terminal line.
 * @property {string} [warn]    Shown before an LLM load that will be slow.
 * @property {number} nCtx
 * @property {boolean} overridable  Whether `--force-llm` could change this.
 */

/**
 * Decide how to answer, before anything is downloaded.
 *
 * Gate order matters: the cheapest and most certain checks first, so a browser
 * without WebAssembly never runs a memory probe.
 *
 * One deliberate departure from the original plan, on the strength of M10's
 * measurements. The plan defaulted every no-SIMD visitor to grep-mode on the
 * assumption that the scalar build meant a ~60 s prefill. Measured, the SIMD
 * baseline came in ~5x faster than budgeted (26.7 GFLOP/s, 4.0 s prefill), so the
 * scalar path is ~17 s -- slow, but a legitimate wait behind a progress bar, and
 * the model is the feature the visitor asked for. So no-SIMD on a desktop now gets
 * the model with a warning; no-SIMD on a constrained device, where 17 s becomes a
 * minute or more, still defaults to grep-mode.
 *
 * @param {{forceLlm?: boolean, offline?: boolean}} [opts]
 * @returns {Plan}
 */
export function plan(opts = {}) {
  if (opts.offline === true) {
    return { mode: "grep", reason: "--offline", nCtx: 0, overridable: false };
  }

  if (!hasWasm()) {
    return {
      mode: "grep",
      reason: "this browser has no WebAssembly support",
      nCtx: 0,
      // Nothing to override: there is no engine to force.
      overridable: false,
    };
  }

  const constrained = isConstrained();
  const nCtx = constrained ? N_CTX_REDUCED : 0; // 0 means "the configured default"
  const force = opts.forceLlm === true;

  if (crashedLastTime() && !force) {
    return {
      mode: "grep",
      reason: "the model crashed this tab last time",
      nCtx,
      overridable: true,
    };
  }

  if (!canReserve(constrained ? HEAP_MB_REDUCED : HEAP_MB_FULL) && !force) {
    return {
      mode: "grep",
      reason: "not enough memory available for the model",
      nCtx,
      overridable: true,
    };
  }

  if (!hasSimd()) {
    if (constrained && !force) {
      return {
        mode: "grep",
        reason: "no WebAssembly SIMD on a memory-constrained device",
        nCtx,
        overridable: true,
      };
    }
    return {
      mode: "llm",
      warn: "no WebAssembly SIMD -- the first answer will take around 20 seconds",
      nCtx,
      overridable: true,
    };
  }

  return { mode: "llm", nCtx, overridable: true };
}
