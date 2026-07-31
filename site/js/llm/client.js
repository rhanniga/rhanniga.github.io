// @ts-check
/**
 * The main-thread facade: an AskEngine backed by the worker.
 *
 * Implements exactly the contract in types.js, which the mock also implements -- so
 * swapping the two is a change in engine.js and nothing in ask.js. That the swap
 * really is one line is the payoff for having written the contract down in M6 before
 * any of this existed.
 */

import { MODEL_BASE_URL } from "./config.js";

/** @typedef {import('./types.js').AskEngine} AskEngine */
/** @typedef {import('./types.js').LoadProgress} LoadProgress */

/** Matches the shipped hybrid model. Reported by manifest.json once loaded. */
const DEFAULT_BYTES = 86_885_888;

/**
 * @returns {AskEngine}
 */
export function createWorkerEngine() {
  /** @type {Worker | null} */
  let worker = null;
  let nextId = 1;

  /** @type {((p: LoadProgress) => void) | null} */
  let onProgress = null;
  /** @type {{resolve: () => void, reject: (e: any) => void} | null} */
  let loadWaiter = null;

  /**
   * Per-request stream plumbing. A queue plus a waiter, so deltas arriving faster
   * than the consumer reads them are buffered rather than dropped.
   * @type {Map<number, {chunks: string[], done: boolean, error: any, reason: string, wake: (() => void) | null}>}
   */
  const streams = new Map();

  /** @type {AskEngine} */
  const engine = {
    info: {
      id: "smollm2-135m-hybrid",
      label: "SmolLM2-135M-Instruct (int4/int8 hybrid)",
      bytes: DEFAULT_BYTES,
      params: "135M",
      ctx: 1024,
      mock: false,
    },
    state: "unloaded",

    isCached: async () => {
      // Asked on the main thread so `ask` can skip the download notice without
      // spinning up the worker at all.
      try {
        if (typeof caches === "undefined") return false;
        const cache = await caches.open("hannigan-sh-llm-v1");
        const res = await fetch(
          MODEL_BASE_URL.endsWith("/")
            ? MODEL_BASE_URL + "manifest.json"
            : `${MODEL_BASE_URL}/manifest.json`,
          { cache: "no-cache" },
        );
        if (!res.ok) return false;
        const manifest = await res.json();
        for (const shard of manifest.shards) {
          const url = MODEL_BASE_URL.endsWith("/")
            ? MODEL_BASE_URL + shard.name
            : `${MODEL_BASE_URL}/${shard.name}`;
          if ((await cache.match(url)) === undefined) return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    load: async (opts = {}) => {
      if (engine.state === "ready") return;
      engine.state = "loading";
      onProgress = opts.onProgress ?? null;

      // Constructed here, not at module load: `createWorkerEngine()` must not
      // instantiate anything, so first paint and the boot sequence are unaffected.
      // `import.meta.url` resolves against the served file, so this works from any
      // origin with no configuration.
      worker = new Worker(new URL("./ask.worker.js", import.meta.url), {
        type: "module",
      });
      worker.onmessage = handle;
      worker.onerror = (e) => {
        loadWaiter?.reject(new Error(`worker failed: ${e.message}`));
        loadWaiter = null;
      };

      const ready = new Promise((resolve, reject) => {
        loadWaiter = { resolve: () => resolve(undefined), reject };
      });

      opts.signal?.addEventListener("abort", () => {
        worker?.postMessage({ t: "cancel", id: 0 });
      });

      worker.postMessage({ t: "load", nCtx: opts.nCtx ?? 0 });
      try {
        await ready;
        engine.state = "ready";
      } catch (err) {
        engine.state = "error";
        throw err;
      }
    },

    generate: (opts) => {
      const id = nextId++;
      const state = {
        chunks: /** @type {string[]} */ ([]),
        done: false,
        error: /** @type {any} */ (null),
        reason: "eos",
        wake: /** @type {(() => void) | null} */ (null),
      };
      streams.set(id, state);

      worker?.postMessage({ t: "ask", id, question: opts.prompt });

      const onAbort = () => worker?.postMessage({ t: "cancel", id });
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              if (state.chunks.length > 0) {
                yield /** @type {string} */ (state.chunks.shift());
                continue;
              }
              if (state.error !== null) throw state.error;
              if (state.done) {
                // Aborting must THROW, not return quietly, or `ask` cannot tell
                // cancellation from completion and would exit 0 instead of 130.
                if (state.reason === "cancelled") {
                  throw new DOMException("Aborted", "AbortError");
                }
                return;
              }
              await new Promise((r) => {
                state.wake = () => r(undefined);
              });
            }
          } finally {
            streams.delete(id);
            opts.signal?.removeEventListener("abort", onAbort);
          }
        },
      };
    },

    reset: () => worker?.postMessage({ t: "newSession" }),

    dispose: async () => {
      worker?.postMessage({ t: "dispose" });
      worker?.terminate();
      worker = null;
      engine.state = "unloaded";
    },
  };

  /** @param {MessageEvent} ev */
  function handle(ev) {
    const msg = /** @type {any} */ (ev.data);
    switch (msg?.t) {
      case "phase":
        onProgress?.({
          phase: msg.phase === "weights" ? "fetching" : "initializing",
          received: 0,
          total: null,
        });
        break;

      case "progress":
        onProgress?.({
          phase: msg.phase === "weights" ? "fetching" : "prefill",
          received: msg.received,
          total: msg.total,
          ...(msg.bytesPerSecond !== undefined
            ? { bytesPerSecond: msg.bytesPerSecond }
            : {}),
        });
        break;

      case "ready":
        engine.info.ctx = msg.nCtx;
        onProgress?.({ phase: "ready", received: 0, total: null });
        loadWaiter?.resolve();
        loadWaiter = null;
        break;

      case "chunk": {
        const s = streams.get(msg.id);
        if (s === undefined) break;
        s.chunks.push(msg.text);
        s.wake?.();
        s.wake = null;
        break;
      }

      case "end": {
        const s = streams.get(msg.id);
        engine.stats = msg.stats;
        if (s === undefined) break;
        s.done = true;
        s.reason = msg.reason;
        s.wake?.();
        s.wake = null;
        break;
      }

      case "error": {
        const err = new Error(msg.message);
        /** @type {any} */ (err).code = msg.code;
        if (msg.id === undefined) {
          loadWaiter?.reject(err);
          loadWaiter = null;
          break;
        }
        const s = streams.get(msg.id);
        if (s === undefined) break;
        s.error = err;
        s.wake?.();
        s.wake = null;
        break;
      }

      default:
        break;
    }
  }

  return engine;
}
