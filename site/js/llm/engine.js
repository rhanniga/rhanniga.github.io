// @ts-check
/**
 * Engine selection.
 *
 * The real engine's artifacts live in `site/ask/`, which is gitignored and filled
 * in by CI. So a bare checkout has no model, and that has to degrade honestly
 * rather than throwing: `ask` reports the model is not deployed and exits 69
 * (EX_UNAVAILABLE), and everything else about the site keeps working.
 */

import { shardUrl } from "./config.js";
import { createMockEngine } from "./mock-engine.js";
import { createWorkerEngine } from "./client.js";
import { hasWasm, hasSimd } from "./capabilities.js";

/** @typedef {import('./types.js').AskEngine} AskEngine */

/**
 * @typedef {{ok: true, engine: AskEngine} | {ok: false, reason: string, code: 'not-deployed'|'no-wasm'}} EngineResult
 */

/**
 * Which engine did the URL ask for, if it asked at all?
 *
 * `?ask=mock` forces the synthetic engine and `?ask=real` forces the worker; neither
 * is set in normal use.
 *
 * @returns {'mock'|'real'|null}
 */
export function askOverride() {
  const asked = new URLSearchParams(location.search).get("ask");
  return asked === "mock" || asked === "real" ? asked : null;
}

/** @returns {boolean} */
function isLocalhost() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

/**
 * Is the model actually there?
 *
 * The manifest is what "deployed" means -- the wasm build is separate and much
 * smaller, and without weights there is nothing to run. Probed rather than assumed,
 * with HEAD to keep it cheap, and a 404 here is the normal state of a fresh clone
 * rather than an error worth logging loudly.
 *
 * @returns {Promise<boolean>}
 */
async function isDeployed() {
  try {
    const res = await fetch(shardUrl("manifest.json"), {
      method: "HEAD",
      cache: "no-cache",
    });
    return res.ok;
  } catch {
    return false;
  }
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

  const override = askOverride();

  if (override === "mock") {
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

  if (!(await isDeployed())) {
    // Localhost with no weights is a fresh clone, and the mock is what lets the rest
    // of the site be developed without an 87 MB download. It used to be selected on
    // hostname alone, which meant a local checkout that HAD run tools/convert.py still
    // got synthetic text and no way to notice besides the footnote under the answer.
    // Deployment is the thing actually being asked about, so ask that instead.
    if (override !== "real" && isLocalhost()) {
      cached = createMockEngine(deps);
      return { ok: true, engine: cached };
    }
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
