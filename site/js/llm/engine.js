// @ts-check
/**
 * Engine selection.
 *
 * The real engine's artifacts live in `site/ask/`, which is gitignored and filled
 * in by CI. So a bare checkout has no model, and that has to degrade honestly
 * rather than throwing: `ask` reports the model is not deployed and exits 69
 * (EX_UNAVAILABLE), and everything else about the site keeps working.
 */

import { MODEL_BASE_URL } from "./config.js";
import { createMockEngine } from "./mock-engine.js";
import { createWorkerEngine } from "./client.js";
import { hasWasm, hasSimd } from "./capabilities.js";

/** @typedef {import('./types.js').AskEngine} AskEngine */

/**
 * The model manifest, which is what "is the model deployed?" actually means. The
 * wasm build is separate and much smaller; without weights there is nothing to run.
 */
const MANIFEST_URL = (() => {
  const base = MODEL_BASE_URL;
  return base.endsWith("/") ? base + "manifest.json" : `${base}/manifest.json`;
})();

/**
 * @typedef {{ok: true, engine: AskEngine} | {ok: false, reason: string, code: 'not-deployed'|'no-wasm'}} EngineResult
 */

/**
 * Should the synthetic engine be used?
 *
 * Explicit `?ask=mock` wins, then localhost by default -- so development does not
 * need a 72 MB download, and `?ask=real` still forces the real path locally when
 * that is what you are testing.
 *
 * @returns {boolean}
 */
export function useMock() {
  const params = new URLSearchParams(location.search);
  const asked = params.get("ask");
  if (asked === "mock") return true;
  if (asked === "real") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

/** @type {AskEngine | null} */
let cached = null;

/**
 * Resolve an engine, or explain why there isn't one.
 *
 * @param {{ resume?: import('../data/types.js').Resume | null }} [deps]
 * @returns {Promise<EngineResult>}
 */
export async function resolveEngine(deps = {}) {
  if (cached !== null) return { ok: true, engine: cached };

  if (useMock()) {
    cached = createMockEngine(deps);
    return { ok: true, engine: cached };
  }

  if (!hasWasm()) {
    return {
      ok: false,
      code: "no-wasm",
      reason: "this browser has no WebAssembly support",
    };
  }

  // Probe rather than assume. HEAD keeps it cheap, and a 404 here is the normal
  // state of a fresh clone rather than an error worth logging loudly.
  let deployed = false;
  try {
    const res = await fetch(MANIFEST_URL, { method: "HEAD", cache: "no-cache" });
    deployed = res.ok;
  } catch {
    deployed = false;
  }

  if (!deployed) {
    return {
      ok: false,
      code: "not-deployed",
      reason: "model not deployed",
    };
  }

  cached = createWorkerEngine();
  return { ok: true, engine: cached };
}

/** Test seam: forget the memoised engine. */
export function resetEngineCache() {
  cached = null;
}

export { hasSimd };
