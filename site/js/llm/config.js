// @ts-check
/**
 * Where the model lives, and how big it is.
 *
 * MODEL_BASE_URL is the one-constant switch between hosting the weights on
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
export const MODEL_BASE_URL = (() => {
  // `location` exists in a Worker but not under node, where these modules are
  // tested, so this is guarded rather than assumed.
  if (typeof location === "undefined") return "./model/";
  const override = new URLSearchParams(location.search).get("model");
  if (override !== null && override !== "") return override;
  return "./model/";
})();

/** Bump to invalidate every cached shard; old caches are deleted on load. */
export const CACHE_NAME = "hannigan-sh-llm-v1";

/** Where CI writes the wasm build. */
export const WASM_SIMD_URL = "./ask/engine.simd.wasm";
export const WASM_SCALAR_URL = "./ask/engine.wasm";
export const TOKENIZER_URL = "./data/tokenizer.bin";

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
  if (MODEL_BASE_URL.startsWith("hf:")) {
    const repo = MODEL_BASE_URL.slice(3) || HF_REPO;
    return `https://huggingface.co/${repo}/resolve/${MODEL_REVISION}/${name}`;
  }
  return MODEL_BASE_URL.endsWith("/")
    ? MODEL_BASE_URL + name
    : `${MODEL_BASE_URL}/${name}`;
}
