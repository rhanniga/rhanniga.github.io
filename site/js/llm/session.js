// @ts-check
/**
 * The generation loop: prefill, KV snapshot, decode, cancel.
 *
 * Deliberately separate from ask.worker.js, which is only plumbing. Everything here
 * runs under node against the real wasm, so the parts most likely to be wrong -- the
 * snapshot lifecycle and the cancellation yield -- are testable without a browser.
 *
 * Two things are load-bearing:
 *
 * **The KV snapshot.** Reading the 351-token system prompt costs ~3.5 s. Taking a
 * snapshot once and restoring it before each question means only the FIRST question
 * in a session pays that, and every subsequent one starts producing tokens
 * immediately. Ten lines for the single largest latency win available.
 *
 * **The yield must be a macrotask.** `postMessage` from the worker is only delivered
 * when the worker yields a macrotask, and `await Promise.resolve()` is a microtask --
 * it does not drain the message queue. Get this wrong and Ctrl+C appears to work in
 * testing, then hangs for seconds under real load, because the cancel message sits
 * unread while the loop spins. `Atomics.wait` on a SharedArrayBuffer is not an
 * option: GitHub Pages cannot send COOP/COEP headers, so SharedArrayBuffer does not
 * exist here. This is not a preference.
 */

import { allocOrThrow, describeError } from "./bindings.js";
import { encode, streamDecoder } from "./tokenizer.js";
import { makeRedactor } from "./guard.js";

/** How often to yield while prefilling. */
const PREFILL_YIELD_EVERY = 2;

/**
 * Force a real timer slot at least this often, in milliseconds.
 *
 * Bounds worst-case cancellation latency to roughly this plus one unit of work --
 * about 50 ms while decoding. Deliberately time-based rather than "every Nth
 * yield": N yields is a different amount of wall-clock during prefill (80 ms of
 * work per yield) than during decode (13 ms), so a count would bound one and not
 * the other.
 */
const TIMER_SLOT_MS = 40;

/**
 * A macrotask yield that cannot starve.
 *
 * The plan specified MessageChannel and explicitly rejected setTimeout as too slow.
 * Measured, that recommendation is incomplete: **a MessageChannel yield loop with
 * real work between the yields starves timers entirely under node.** 100 iterations
 * of 10 ms work each ran to completion in 1011 ms and a 200 ms timer did not fire
 * until afterwards, so an abort was never observed. An earlier version of this test
 * appeared to pass only because its loop body was empty, which let 538,000 yields
 * run in 300 ms and gave the timer a slot by luck.
 *
 * Measured cost per yield, with 10 ms of work between:
 *
 *     MessageChannel            0.11 ms   abort NEVER seen
 *     setTimeout(0)             1.00 ms   abort at 209 ms
 *     setImmediate              0.00 ms   abort at 200 ms   (node-only)
 *     channel + periodic timer  0.06 ms   abort at 322 ms
 *
 * Browsers are not expected to starve this way -- postMessage and timer tasks live in
 * task queues the event loop round-robins between -- but "not expected to" is a poor
 * foundation for the one feature a user reaches for when something is taking too
 * long. So: the cheap channel yield normally, and a real timer whenever
 * TIMER_SLOT_MS has passed, which bounds the latency regardless of runtime.
 * setImmediate is not used because it does not exist in browsers.
 *
 * @returns {(() => Promise<void>) & {dispose: () => void}}
 */
export function makeYield() {
  const channel = new MessageChannel();
  /** @type {(() => void) | null} */
  let resolve = null;
  channel.port1.onmessage = () => {
    const r = resolve;
    resolve = null;
    r?.();
  };

  let lastTimerSlot = Date.now();

  return Object.assign(
    () => {
      const now = Date.now();
      if (now - lastTimerSlot >= TIMER_SLOT_MS) {
        lastTimerSlot = now;
        // A genuine timer task, which every runtime interleaves with message
        // delivery. One per 40 ms, so the 1 ms cost is noise.
        return new Promise((r) => setTimeout(r, 0));
      }
      return new Promise((r) => {
        resolve = r;
        channel.port2.postMessage(0);
      });
    },
    {
      // Must be called, and NOT replaced with port.unref(): under node an unref'd
      // port lets the event loop drain before the message is delivered, so the yield
      // never resolves and the loop wedges -- which is how the first version failed.
      dispose: () => {
        channel.port1.onmessage = null;
        channel.port1.close();
        channel.port2.close();
      },
    },
  );
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
}

/**
 * @typedef {object} SessionOptions
 * @property {import('./bindings.js').Engine} engine
 * @property {any} tokenizer
 * @property {ArrayLike<number>} systemIds
 * @property {number} nCtx
 * @property {typeof import('./config.js').SAMPLING} sampling
 * @property {(done: number, total: number) => void} [onPrefill]
 * @property {AbortSignal} [signal]
 */

/**
 * Prefill the system prompt and snapshot the resulting KV cache.
 *
 * @param {SessionOptions} opts
 */
export async function createSession(opts) {
  const { engine, tokenizer, systemIds, nCtx, sampling } = opts;
  const yieldNow = makeYield();

  const nSystem = systemIds.length;
  if (nSystem >= nCtx) {
    yieldNow.dispose();
    throw new Error(`system prompt (${nSystem}) does not fit in context (${nCtx})`);
  }

  // Aborting mid-prefill is the common case -- it is the 3.9 s phase -- so the
  // channel has to be released on the way out. Leaking it kept a node process alive
  // indefinitely, which is how this was found.
  try {
    for (let pos = 0; pos < nSystem; pos++) {
      engine.forward(systemIds[pos] ?? 0, pos);
      if (pos % PREFILL_YIELD_EVERY === PREFILL_YIELD_EVERY - 1) {
      // Every 2 tokens. The yield itself costs ~0.06 ms against ~20 ms of work, and
      // the timer slot inside makeYield is what actually bounds latency.
        await yieldNow();
        throwIfAborted(opts.signal);
        opts.onPrefill?.(pos + 1, nSystem);
      }
    }
    opts.onPrefill?.(nSystem, nSystem);
  } catch (err) {
    yieldNow.dispose();
    throw err;
  }

  // Compacted to exactly nSystem positions, so the snapshot is independent of the
  // nCtx this session happens to be running at.
  const snapshotBytes = engine.kvBytes(nSystem);
  const snapshotPtr = allocOrThrow(engine, snapshotBytes);
  engine.kvSave(snapshotPtr, nSystem);

  let stats = { promptTokens: nSystem, completionTokens: 0, tokensPerSecond: 0 };

  return {
    get stats() {
      return stats;
    },

    /** Forget the conversation, keeping the cached system prompt. */
    reset() {
      engine.historyClear();
    },

    /** Release the yield channel. Without this a node process will not exit. */
    close() {
      yieldNow.dispose();
    },

    /**
     * Answer one question, streaming decoded text to onDelta.
     *
     * @param {object} args
     * @param {string} args.question
     * @param {(text: string) => void} args.onDelta
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<{reason: 'eos'|'maxTokens'|'ctxFull', tokens: number}>}
     */
    async generate({ question, onDelta, signal }) {
      // Restore the snapshot rather than re-reading the prompt. This is what makes
      // the second question in a session instant.
      engine.kvLoad(snapshotPtr, nSystem);
      engine.historyClear();

      // The rest of the ChatML turn. The system half is already in the snapshot.
      const turn = `<|im_start|>user\n${question}<|im_end|>\n<|im_start|>assistant\n`;
      const turnIds = encode(tokenizer, turn);

      let pos = nSystem;
      if (pos + turnIds.length >= nCtx) {
        return { reason: "ctxFull", tokens: 0 };
      }

      for (let i = 0; i < turnIds.length; i++, pos++) {
        engine.forward(turnIds[i] ?? 0, pos);
        if (i % PREFILL_YIELD_EVERY === PREFILL_YIELD_EVERY - 1) {
          await yieldNow();
          throwIfAborted(signal);
        }
      }

      const eos = engine.eosId();
      const decoder = streamDecoder(tokenizer);
      // Redaction happens here, not in the caller. The worker posts these deltas
      // straight across to the main thread, so this is the last place that sees the
      // output as one stream -- and a fabricated phone number spans several tokens,
      // none of which is suspicious on its own.
      const redactor = makeRedactor();
      /** @param {string} text */
      const emit = (text) => {
        const safe = redactor.push(text);
        if (safe !== "") onDelta(safe);
      };
      /** Drain both buffers, in order: decoder first, then the held partial word. */
      const drain = () => {
        const tail = decoder.flush();
        if (tail !== "") {
          const safe = redactor.push(tail);
          if (safe !== "") onDelta(safe);
        }
        const last = redactor.flush();
        if (last !== "") onDelta(last);
      };
      const started = Date.now();
      let emitted = 0;
      /** @type {'eos'|'maxTokens'|'ctxFull'} */
      let reason = "maxTokens";

      let token = engine.sample(
        sampling.temperature, sampling.topP, sampling.topK,
        sampling.repetitionPenalty, sampling.repetitionWindow,
      );

      for (; emitted < sampling.maxTokens; emitted++, pos++) {
        if (token === eos || token === 0) {
          reason = "eos";
          break;
        }
        if (pos >= nCtx) {
          reason = "ctxFull";
          break;
        }

        emit(decoder.push(token));

        // One yield per decoded token. At ~10 ms per token the ~0.1 ms channel round
        // trip is free, and it bounds Ctrl+C latency to a single token.
        await yieldNow();
        try {
          throwIfAborted(signal);
        } catch (err) {
          // Flush whatever the decoder is holding, so a partial multi-byte character
          // is not stranded, then let the caller see the abort.
          drain();
          throw err;
        }

        engine.forward(token, pos);
        token = engine.sample(
          sampling.temperature, sampling.topP, sampling.topK,
          sampling.repetitionPenalty, sampling.repetitionWindow,
        );
      }

      drain();

      const seconds = Math.max(1, Date.now() - started) / 1000;
      stats = {
        promptTokens: nSystem + turnIds.length,
        completionTokens: emitted,
        tokensPerSecond: emitted / seconds,
      };
      return { reason, tokens: emitted };
    },
  };
}

export { describeError };
