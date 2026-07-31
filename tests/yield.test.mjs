// @ts-check
/**
 * The cancellation yield.
 *
 * This is the mechanism Ctrl+C depends on, and the plan's recommendation for it turned
 * out to be incomplete in a way that only shows up with real work in the loop. These
 * tests pin the behaviour that matters: a queued message must be delivered, and it
 * must be delivered even when each iteration does meaningful computation.
 *
 * `Atomics.wait` on a SharedArrayBuffer is not an alternative -- GitHub Pages cannot
 * send COOP/COEP headers, so SharedArrayBuffer does not exist here.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeYield } from "../site/js/llm/session.js";

/** Burn wall-clock synchronously, standing in for engine.forward(). */
function burn(ms) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    /* spin */
  }
}

test("a microtask does NOT deliver a queued message", () => {
  // The trap, asserted so nobody "simplifies" the yield back into
  // `await Promise.resolve()`. Ctrl+C would then appear to work in a quick test and
  // hang for seconds under load, because the cancel sits unread while the loop spins.
  const channel = new MessageChannel();
  let delivered = false;
  channel.port1.onmessage = () => {
    delivered = true;
  };
  channel.port2.postMessage("cancel");

  return Promise.resolve().then(() => {
    assert.equal(delivered, false, "a microtask must not have drained the queue");
    channel.port1.close();
    channel.port2.close();
  });
});

test("the yield does deliver a queued message", async () => {
  const channel = new MessageChannel();
  let delivered = false;
  channel.port1.onmessage = () => {
    delivered = true;
  };
  channel.port2.postMessage("cancel");

  const yieldNow = makeYield();
  await yieldNow();
  assert.equal(delivered, true);
  yieldNow.dispose();
  channel.port1.close();
  channel.port2.close();
});

test("an abort is observed within ~100ms even with real work between yields", async () => {
  // The case a bare MessageChannel yield fails. Measured: 100 iterations of 10ms work
  // each ran to completion in 1011ms under node while a 200ms timer never fired, so
  // the abort was never seen. The time-based timer slot in makeYield fixes it.
  const yieldNow = makeYield();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);

  const started = Date.now();
  let iterations = 0;
  let sawAbort = false;
  for (let i = 0; i < 200; i++) {
    burn(10);
    await yieldNow();
    iterations++;
    if (controller.signal.aborted) {
      sawAbort = true;
      break;
    }
  }
  const elapsed = Date.now() - started;
  clearTimeout(timer);
  yieldNow.dispose();

  assert.ok(sawAbort, `abort never observed after ${iterations} iterations / ${elapsed}ms`);
  // Bounded by the timer slot plus one unit of work, not by the whole loop.
  assert.ok(elapsed < 300, `abort took ${elapsed}ms, expected well under 300ms`);
});

test("the yield stays cheap despite the periodic timer", async () => {
  const yieldNow = makeYield();
  const started = Date.now();
  const N = 2000;
  for (let i = 0; i < N; i++) await yieldNow();
  const perYield = (Date.now() - started) / N;
  yieldNow.dispose();
  // One timer per 40ms amortises to nothing; the channel path dominates.
  assert.ok(perYield < 0.5, `${perYield.toFixed(3)}ms per yield is too slow`);
});

test("dispose releases the channel", async () => {
  // Without this a node process never exits, and a leaked channel per aborted session
  // would accumulate in a long-lived tab. It is also why createSession disposes on
  // throw -- a leak there kept a test process alive indefinitely.
  const yieldNow = makeYield();
  await yieldNow();
  assert.doesNotThrow(() => yieldNow.dispose());
  assert.doesNotThrow(() => yieldNow.dispose(), "dispose must be idempotent");
});
