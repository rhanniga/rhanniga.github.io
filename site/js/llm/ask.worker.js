// @ts-check
/// <reference lib="webworker" />
/**
 * The worker. Plumbing only.
 *
 * All the logic lives in session.js, weights.js and bindings.js, which run under node
 * against the real wasm -- so the parts most likely to be wrong are testable without a
 * browser, and this file is thin enough to read in one sitting.
 *
 * The worker exists for one reason: a 3.9 s prefill on the main thread would freeze
 * the terminal, the cursor, and the CRT overlay. Here it freezes nothing, and the
 * yields in session.js are what let cancel messages arrive mid-computation.
 */

import { instantiate, allocOrThrow, describeError } from "./bindings.js";
import { loadTokenizer } from "./tokenizer.js";
import { createSession } from "./session.js";
import { fetchManifest, isCached, streamWeights } from "./weights.js";
import {
  WASM_SIMD_URL,
  WASM_SCALAR_URL,
  TOKENIZER_URL,
  N_CTX,
  SAMPLING,
  setModelBaseUrl,
} from "./config.js";
import { hasSimd } from "./capabilities.js";
import { SYSTEM_PROMPT_IDS } from "./prompt.js";

/** @type {any} */
let session = null;
/** @type {any} */
let engine = null;
/** Ids of requests the main thread has asked to cancel. */
const cancelled = new Set();
/** @type {Map<number, AbortController>} */
const inFlight = new Map();

/** @param {any} msg */
function post(msg) {
  /** @type {any} */ (self).postMessage(msg);
}

/**
 * @param {{signal?: AbortSignal, nCtx?: number, modelBase?: string}} opts
 */
async function load(opts) {
  // The main thread resolved this: only it can see `?model=`, because a worker's
  // `location` is its own script URL and carries no query string.
  if (opts.modelBase !== undefined) setModelBaseUrl(opts.modelBase);

  // 0 means "whatever config says". A constrained device passes 512, which halves
  // the KV cache from 47 MB to 24 MB -- the difference between running and being
  // killed on an older iPhone.
  const nCtx = opts.nCtx !== undefined && opts.nCtx > 0 ? opts.nCtx : N_CTX;
  post({ t: "phase", phase: "wasm" });
  const wasmUrl = hasSimd() ? WASM_SIMD_URL : WASM_SCALAR_URL;
  const wasmRes = await fetch(wasmUrl);
  if (!wasmRes.ok) throw new Error(`${wasmUrl}: HTTP ${wasmRes.status}`);
  engine = await instantiate(await wasmRes.arrayBuffer());

  post({ t: "phase", phase: "tokenizer" });
  const tokRes = await fetch(TOKENIZER_URL);
  if (!tokRes.ok) throw new Error(`${TOKENIZER_URL}: HTTP ${tokRes.status}`);
  const tokenizer = loadTokenizer(await tokRes.arrayBuffer());

  post({ t: "phase", phase: "weights" });
  const manifest = await fetchManifest();

  // Allocated up front so each chunk can be copied straight in. This single
  // allocation is the only copy of the weights that ever exists.
  const ptr = allocOrThrow(engine, manifest.bytes);
  const { fromCache } = await streamWeights({
    manifest,
    write: (chunk, offset) => {
      // Through the guard, every time: ml_alloc grew memory, and any view captured
      // before that is detached and would write nowhere.
      engine.u8().set(chunk, ptr + offset);
    },
    onProgress: (received, total, bytesPerSecond) =>
      post({ t: "progress", phase: "weights", received, total, bytesPerSecond }),
    signal: opts.signal,
  });

  post({ t: "phase", phase: "instantiate" });
  const rc = engine.init(ptr, manifest.bytes, nCtx);
  if (rc !== 0) throw new Error(`ml_init: ${describeError(rc)}`);
  engine.seed(Date.now() & 0xffffffff, 0);

  post({ t: "phase", phase: "prefill" });
  session = await createSession({
    engine,
    tokenizer,
    systemIds: SYSTEM_PROMPT_IDS,
    nCtx,
    sampling: SAMPLING,
    signal: opts.signal,
    onPrefill: (done, total) =>
      post({ t: "progress", phase: "prefill", received: done, total }),
  });

  post({
    t: "ready",
    nCtx: engine.nCtx(),
    nVocab: engine.nVocab(),
    fromCache,
    sha256: engine.modelSha256(),
    simd: hasSimd(),
  });
}

/**
 * @param {number} id
 * @param {string} question
 */
async function answer(id, question) {
  if (session === null) {
    post({ t: "error", id, code: "bad-model", message: "engine is not loaded" });
    return;
  }
  const controller = new AbortController();
  inFlight.set(id, controller);
  if (cancelled.has(id)) controller.abort();

  try {
    const result = await session.generate({
      question,
      signal: controller.signal,
      // Decoded text, never token ids: the worker owns the streaming TextDecoder so
      // a multi-byte character split across two tokens is reassembled in exactly one
      // place.
      onDelta: (text) => post({ t: "chunk", id, text }),
    });
    post({ t: "end", id, reason: result.reason, stats: session.stats });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === "AbortError") {
      post({ t: "end", id, reason: "cancelled", stats: session.stats });
    } else {
      post({
        t: "error",
        id,
        code: "bad-model",
        message: /** @type {any} */ (err)?.message ?? String(err),
      });
    }
  } finally {
    inFlight.delete(id);
    cancelled.delete(id);
  }
}

/** @type {AbortController | null} */
let loadController = null;

self.onmessage = async (ev) => {
  const msg = /** @type {any} */ (ev).data;
  switch (msg?.t) {
    case "load": {
      loadController = new AbortController();
      try {
        await load({
          signal: loadController.signal,
          nCtx: msg.nCtx,
          modelBase: msg.modelBase,
        });
      } catch (err) {
        const name = /** @type {any} */ (err)?.name;
        post({
          t: "error",
          code: name === "AbortError" ? "aborted" : "fetch-failed",
          message: /** @type {any} */ (err)?.message ?? String(err),
        });
      }
      break;
    }
    case "ask":
      void answer(msg.id, msg.question);
      break;
    case "cancel": {
      // Recorded as well as applied, so a cancel that arrives before `ask` is
      // processed is not lost.
      cancelled.add(msg.id);
      inFlight.get(msg.id)?.abort();
      loadController?.abort();
      break;
    }
    case "newSession":
      session?.reset();
      break;
    case "dispose":
      session?.close();
      engine?.shutdown();
      session = null;
      engine = null;
      break;
    default:
      break;
  }
};
