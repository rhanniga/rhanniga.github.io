// @ts-check
/**
 * Where the model lives, and how big it is.
 *
 * The model base is the one-constant switch between hosting the weights on
 * HuggingFace and serving them from this site. That switch stays cheap because the
 * weights are sharded either way -- flipping to Pages is moving the shards into
 * site/model/ and changing this string.
 *
 * The reason the option is worth preserving: the shipped model is 86.5 MB, which is
 * under GitHub's 100 MB per-file hard limit and well under the 1 GB Pages site
 * limit. Pages' 100 GB/month allows roughly 1,150 downloads before brushing a soft
 * limit -- fine for a personal site. all-int8 at 143 MB would have destroyed that
 * option, which is part of why the M7 quantization gate mattered.
 */

/**
 * Pin a revision SHA, never a branch.
 *
 * An immutable URL means an immutable Cache key, which means a stale-weights bug is
 * impossible rather than merely unlikely. Re-quantizing produces a new SHA and
 * therefore a new cache entry, and old entries are evicted by the version bump
 * below.
 */
export const MODEL_REVISION = "main";

/** HuggingFace repo, once the weights are published there. */
export const HF_REPO = "rhanniga/hannigan-sh-llm";

/**
 * Resolved at import time so it can be overridden for local development without
 * touching the rest of the pipeline.
 *
 * Defaults to same-origin `./model/`, which is what a local checkout with the shards
 * copied in uses, and what the Pages-hosted variant uses verbatim.
 */
/**
 * The site root, resolved from this module's own URL.
 *
 * Every asset URL below goes through here rather than being written relative, and the
 * reason is a bug that cost an afternoon. A relative `fetch("./model/x")` resolves
 * against the *document* on the main thread and against the *worker script* inside a
 * worker. This module is imported by both, so one string meant `/model/x` in one place
 * and `/js/llm/model/x` in the other -- and the second 404s. Worse, the two halves
 * disagreed silently: the HEAD probe in engine.js ran on the main thread, found the
 * manifest, and reported the model deployed; the worker then 404'd on the same path.
 *
 * `import.meta.url` is identical in both contexts, so resolving against it once makes
 * the asymmetry impossible. It also means the site works unchanged from a subpath,
 * which a document-relative URL would only do by accident.
 */
const SITE_ROOT = new URL("../../", import.meta.url).href;

/**
 * @param {string} rel Path relative to the site root, with no leading slash.
 * @returns {string}
 */
function siteUrl(rel) {
  return new URL(rel, SITE_ROOT).href;
}

/**
 * Where the shards are fetched from.
 *
 * Mutable, which is a deliberate exception in a codebase that otherwise passes its
 * dependencies. `?model=` is read from `location.search`, and a worker's `location` is
 * its own script URL -- it has no query string. So the override exists on the main
 * thread and cannot be discovered in the worker, which is where the shards are actually
 * fetched. client.js sends the resolved base with the load message and the worker
 * adopts it, so the two can no longer disagree about which model they are loading.
 */
let modelBase = (() => {
  // `location` exists in a Worker but not under node, where these modules are
  // tested, so this is guarded rather than assumed.
  if (typeof location === "undefined") return siteUrl("model/");
  const override = new URLSearchParams(location.search).get("model");
  if (override === null || override === "") return siteUrl("model/");
  // An `hf:` base is not a URL and must survive verbatim; anything else is resolved so
  // that `?model=../weights/` means what it looks like.
  return override.startsWith("hf:") ? override : new URL(override, location.href).href;
})();

/** @returns {string} */
export function modelBaseUrl() {
  return modelBase;
}

/**
 * Adopt a model base resolved elsewhere. Called by the worker, once, before it fetches.
 * @param {string} url
 */
export function setModelBaseUrl(url) {
  if (url !== "") modelBase = url;
}

/** Bump to invalidate every cached shard; old caches are deleted on load. */
export const CACHE_NAME = "hannigan-sh-llm-v1";

/** Where CI writes the wasm build. */
export const WASM_SIMD_URL = siteUrl("ask/engine.simd.wasm");
export const WASM_SCALAR_URL = siteUrl("ask/engine.wasm");
export const TOKENIZER_URL = siteUrl("data/tokenizer.bin");

/**
 * Context window.
 *
 * 1024 costs 47 MB of KV cache on top of the 87 MB of weights, for about 135 MB
 * total. Constrained devices drop to 512 (96 MB) -- see capabilities.js. Anything
 * larger is pointless here: the system prompt is 351 tokens and answers are capped
 * at 160.
 */
export const N_CTX = 1024;
export const N_CTX_SMALL = 512;

/** Sampling, tuned in M9 against a model this small. */
export const SAMPLING = {
  temperature: 0.4,
  topP: 0.9,
  topK: 40,
  /** Without this a 135M model loops inside about 40 tokens. */
  repetitionPenalty: 1.1,
  repetitionWindow: 64,
  maxTokens: 160,
};

/**
 * Build the URL for one shard.
 * @param {string} name
 * @returns {string}
 */
export function shardUrl(name) {
  const base = modelBase;
  if (base.startsWith("hf:")) {
    const repo = base.slice(3) || HF_REPO;
    return `https://huggingface.co/${repo}/resolve/${MODEL_REVISION}/${name}`;
  }
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}
