// @ts-check
/**
 * The model load, detached from whoever is waiting on it.
 *
 * `ask` used to load inside the command that needed the answer, which made starting
 * the load and waiting for it the same act: nothing was fetched until a question had
 * been submitted, and `ask -i` spent its whole first question doing work it could
 * have been doing while the visitor typed. This splits the two. `startLoad()` begins
 * the work and returns immediately; `attach()` is how a command watches a load that
 * is already in flight.
 *
 * One task per engine, memoised, because the engine holds the weights and loading
 * twice would mean allocating 87 MB twice.
 */

import { markLoadStarted, markLoadFinished } from "./capabilities.js";

/** @typedef {import('./types.js').AskEngine} AskEngine */
/** @typedef {import('./types.js').LoadProgress} LoadProgress */

/**
 * @typedef {'loading'|'ready'|'aborted'|'oom'|'error'} LoadStatus
 */

/**
 * @typedef {object} LoadTask
 * @property {LoadStatus} status
 * @property {LoadProgress | null} last
 *   The most recent progress report, kept so a late attacher can be shown where the
 *   load already is instead of an empty bar.
 * @property {(onProgress: (p: LoadProgress) => void, signal?: AbortSignal) => Promise<'ready'|'aborted'|'oom'>} attach
 */

/** @type {{engine: AskEngine, task: LoadTask} | null} */
let current = null;

/**
 * Start loading, or return the load already running.
 *
 * Returns synchronously and never throws: a failure is reported to whoever attaches,
 * not to the caller that kicked it off. That is what makes this safe to call from a
 * command that is about to return.
 *
 * @param {AskEngine} engine
 * @param {number} [nCtx] Context override; 0 uses the configured default.
 * @returns {LoadTask}
 */
export function startLoad(engine, nCtx = 0) {
  if (current !== null && current.engine === engine) return current.task;

  const abort = new AbortController();
  /** @type {Set<(p: LoadProgress) => void>} */
  const subscribers = new Set();
  /** @type {unknown} */
  let failure = null;

  const already = engine.state === "ready";

  /** @type {LoadTask} */
  const task = {
    status: already ? "ready" : "loading",
    last: null,
    attach,
  };

  // Memoised before the load starts, so `run`'s own failure path can see the entry it
  // needs to clear.
  current = { engine, task };

  // Resolves when the load has finished, whatever the outcome -- never rejects, so
  // an unwatched failure is not an unhandled rejection.
  const settled = already ? Promise.resolve() : run();

  return task;

  async function run() {
    // Written before the allocation and cleared after it. If iOS Safari kills the tab
    // for memory, nothing else runs -- no exception, no unload handler -- so a mark
    // still present on the next load is the only evidence the crash happened.
    markLoadStarted();

    // Cleared on a deliberate exit, though, or leaving mid-load becomes a false
    // accusation: the next `ask` in the tab would find the mark and refuse the model,
    // blaming a crash that never happened. `pagehide` fires when the visitor navigates
    // away and does not fire when the OS kills the tab, which is exactly the
    // distinction the mark is trying to draw. It mattered less when a load could only
    // follow a y/N prompt; one that starts the moment `ask` runs is easy to walk out on.
    const onPageHide = () => markLoadFinished();
    globalThis.addEventListener?.("pagehide", onPageHide, { once: true });

    try {
      await engine.load({
        signal: abort.signal,
        nCtx,
        onProgress: (p) => {
          task.last = p;
          for (const fn of subscribers) fn(p);
        },
      });
      task.status = "ready";
    } catch (err) {
      failure = err;
      task.status = isAbortError(err) ? "aborted" : isOomError(err) ? "oom" : "error";
      // A load that ended badly is forgotten rather than kept and re-reported, so the
      // next `ask` starts a fresh one. Cancelled downloads resume from where they
      // stopped: the shards already written stay in the cache.
      if (current !== null && current.task === task) current = null;
    } finally {
      // An abort is not a crash, and neither is a caught OOM: leaving the mark would
      // make the next `ask` in this tab default to grep-mode after a deliberate Ctrl+C.
      globalThis.removeEventListener?.("pagehide", onPageHide);
      markLoadFinished();
    }
  }

  /**
   * @param {(p: LoadProgress) => void} onProgress
   * @param {AbortSignal} [signal]
   * @returns {Promise<'ready'|'aborted'|'oom'>}
   */
  async function attach(onProgress, signal) {
    if (task.status === "loading") {
      if (task.last !== null) onProgress(task.last);
      subscribers.add(onProgress);

      /** @type {(() => void) | undefined} */
      let detach;
      if (signal !== undefined) {
        // Ctrl+C stops the download itself, not just the waiting for it. Continuing to
        // pull 87 MB that nobody is now waiting for would be worse, and the retry is
        // cheap because the completed shards are already cached.
        const onAbort = () => abort.abort();
        if (signal.aborted) abort.abort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          detach = () => signal.removeEventListener("abort", onAbort);
        }
      }

      try {
        await settled;
      } finally {
        subscribers.delete(onProgress);
        detach?.();
      }
    }
    return outcome();
  }

  /** @returns {'ready'|'aborted'|'oom'} */
  function outcome() {
    if (task.status === "ready") return "ready";
    if (task.status === "oom") return "oom";
    if (task.status === "aborted") return "aborted";
    // Anything else is a real fault -- a missing shard, a bad build -- and belongs on
    // the caller's error path rather than being flattened into a status.
    throw failure;
  }
}

/** Test seam: forget the memoised load. Mirrors resetEngineCache() in engine.js. */
export function resetLoadTask() {
  current = null;
}

/**
 * Did this fail for want of memory?
 *
 * Three shapes, because the failure can surface from three layers: the engine's own
 * ML_ERR_OOM, a failed `memory.grow` (which the browser reports as a RangeError), and
 * a rejected allocation inside `ml_alloc`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isOomError(err) {
  if (typeof err !== "object" || err === null) return false;
  const e = /** @type {{name?: string, code?: string, message?: string}} */ (err);
  if (e.code === "oom") return true;
  if (e.name === "RangeError") return true;
  return /out of memory|memory allocation|cannot allocate|ML_ERR_OOM/i.test(
    e.message ?? "",
  );
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    /** @type {{name?: string}} */ (err).name === "AbortError"
  );
}
