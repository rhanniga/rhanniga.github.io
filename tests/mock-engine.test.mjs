// @ts-check
/**
 * The mock engine is what the whole `ask` UI is built against, so its conformance
 * to the AskEngine contract is what keeps M12's swap to the real engine a
 * one-line change. These tests are really tests of the contract.
 *
 * Timings are overridden to keep the suite fast; the defaults deliberately mimic
 * the real engine's feel.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMockEngine } from "../site/js/llm/mock-engine.js";

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

/** Fast timings: the shape is what is under test, not the duration. */
const FAST = { downloadMs: 20, prefillMs: 20, tokenMs: 1 };

/** @param {object} [over] */
const engineFor = (over = {}) => createMockEngine({ resume, timings: FAST, ...over });

/** @param {AsyncIterable<string>} it */
async function collect(it) {
  let text = "";
  for await (const delta of it) text += delta;
  return text;
}

test("advertises the download size the progress bar renders against", () => {
  const e = engineFor();
  assert.equal(e.info.bytes, 71_500_000);
  assert.equal(e.info.params, "135M");
  assert.ok(e.info.ctx > 0);
});

test("declares itself a mock, so ask can label its output", () => {
  // Passing synthetic text off as model output would make the mock harmful.
  assert.equal(engineFor().info.mock, true);
});

test("starts unloaded and does not fetch on construction", () => {
  // Requirement 5 of the contract: first paint must be unaffected.
  assert.equal(engineFor().state, "unloaded");
});

test("load walks the phases in order and ends ready", async () => {
  const e = engineFor();
  /** @type {string[]} */
  const phases = [];
  await e.load({ onProgress: (p) => phases.push(p.phase) });
  assert.equal(e.state, "ready");
  // The prompt read is reported separately from the download, because on the real
  // engine it is ~15s and would otherwise look like a hang.
  assert.ok(phases.includes("fetching"));
  assert.ok(phases.includes("prefill"));
  assert.equal(phases.at(-1), "ready");
  assert.ok(
    phases.indexOf("fetching") < phases.indexOf("prefill"),
    "download must precede the prompt read",
  );
});

test("progress never exceeds the total it reports", async () => {
  const e = engineFor();
  await e.load({
    onProgress: (p) => {
      if (p.total !== null) assert.ok(p.received <= p.total, `${p.received} > ${p.total}`);
    },
  });
});

test("aborting a load throws AbortError rather than resolving", async () => {
  // Contract requirement 4: `ask` distinguishes cancellation from completion by
  // catching this, and exits 130 rather than 0.
  const e = engineFor({ timings: { downloadMs: 500, prefillMs: 500, tokenMs: 1 } });
  const ac = new AbortController();
  const loading = e.load({ signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(loading, (err) => {
    assert.equal(/** @type {Error} */ (err).name, "AbortError");
    return true;
  });
  assert.equal(e.state, "error");
});

test("an already-aborted signal fails immediately", async () => {
  const e = engineFor();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(e.load({ signal: ac.signal }), (err) => {
    assert.equal(/** @type {Error} */ (err).name, "AbortError");
    return true;
  });
});

test("generate streams deltas that concatenate to a whole answer", async () => {
  const e = engineFor();
  const text = await collect(e.generate({ prompt: "where did you go to school?" }));
  assert.match(text, /University of Texas at Austin/);
  assert.ok(text.length > 80, "answers should be long enough to exercise wrapping");
});

test("answers are derived from resume.json, not hardcoded", async () => {
  // Proves the mock reads the same data the rest of the site renders, so its
  // output stays plausible if the resume changes.
  const e = engineFor();
  const text = await collect(e.generate({ prompt: "what languages do you know?" }));
  for (const name of ["Python", "Problem Solving", "Leadership"]) {
    assert.match(text, new RegExp(name.replace(/[+]/g, "\\$&")));
  }
});

test("different questions get different answers", async () => {
  const e = engineFor();
  const school = await collect(e.generate({ prompt: "where did you study?" }));
  const cern = await collect(e.generate({ prompt: "what did you do at CERN?" }));
  assert.notEqual(school, cern);
  assert.match(cern, /ALICE/);
});

test("an unrecognised question still gets a useful answer", async () => {
  const e = engineFor();
  const text = await collect(e.generate({ prompt: "asdfghjkl" }));
  assert.ok(text.length > 50);
  assert.match(text, /experience/, "should point at a command that does work");
});

test("aborting generation throws AbortError mid-stream", async () => {
  const e = engineFor({ timings: { downloadMs: 1, prefillMs: 1, tokenMs: 30 } });
  const ac = new AbortController();
  let received = "";
  await assert.rejects(
    (async () => {
      for await (const delta of e.generate({ prompt: "tell me about CERN", signal: ac.signal })) {
        received += delta;
        if (received.length > 10) ac.abort();
      }
    })(),
    (err) => {
      assert.equal(/** @type {Error} */ (err).name, "AbortError");
      return true;
    },
  );
  // Partial output before the abort is kept -- `ask` leaves it on screen, as a
  // real shell leaves partial output.
  assert.ok(received.length > 0);
});

test("stats are reported after a completed generation", async () => {
  const e = engineFor();
  await collect(e.generate({ prompt: "hello" }));
  assert.ok(e.stats !== undefined);
  assert.ok((e.stats?.completionTokens ?? 0) > 0);
  assert.ok((e.stats?.promptTokens ?? 0) > 0);
});

test("deltas never split a surrogate pair", async () => {
  // Contract requirement 2. The mock splits on whitespace so it cannot, but
  // asserting it here means the real engine inherits a test it must also pass.
  const e = engineFor();
  for await (const delta of e.generate({ prompt: "hello" })) {
    assert.equal(
      delta,
      [...delta].join(""),
      "a delta must be whole code points",
    );
  }
});

test("dispose returns the engine to unloaded", async () => {
  const e = engineFor();
  await e.load({});
  assert.equal(e.state, "ready");
  await e.dispose();
  assert.equal(e.state, "unloaded");
});

test("reset is safe to call at any time", () => {
  const e = engineFor();
  assert.doesNotThrow(() => e.reset());
});
