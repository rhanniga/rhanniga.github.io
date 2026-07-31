// @ts-check
/**
 * The capability gate.
 *
 * This code decides whether a visitor gets the model or the resume search, and it runs
 * before anything is downloaded -- so a wrong answer here is either an 83 MB download
 * on a device that cannot finish it, or a visitor silently denied the feature they
 * asked for. Neither shows up in any other test.
 *
 * The probes read `globalThis.navigator`, `globalThis.sessionStorage` and
 * `WebAssembly`, all of which are absent or different under node. Rather than mocking
 * the module, these tests install real fakes on globalThis and remove them afterwards,
 * so the code under test is exactly what ships.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  hasWasm,
  hasSimd,
  canReserve,
  deviceMemoryGB,
  isIOS,
  isConstrained,
  markLoadStarted,
  markLoadFinished,
  crashedLastTime,
  plan,
  resetProbeCache,
  N_CTX_REDUCED,
  HEAP_MB_FULL,
} from "../site/js/llm/capabilities.js";

/**
 * Install fake globals for one test, restoring whatever was there before.
 * @param {Record<string, any>} values
 * @param {() => void} body
 */
function withGlobals(values, body) {
  /** @type {Array<[string, boolean, any]>} */
  const saved = [];
  for (const [key, value] of Object.entries(values)) {
    saved.push([key, key in globalThis, /** @type {any} */ (globalThis)[key]]);
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  // The probes memoise, so a swapped-in fake WebAssembly would otherwise be ignored
  // in favour of an answer computed from the real one.
  resetProbeCache();
  try {
    body();
  } finally {
    resetProbeCache();
    for (const [key, existed, value] of saved) {
      if (existed) {
        Object.defineProperty(globalThis, key, {
          value,
          configurable: true,
          writable: true,
        });
      } else {
        delete /** @type {any} */ (globalThis)[key];
      }
    }
  }
}

/** An in-memory Storage good enough for the breadcrumb. */
function fakeStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

/**
 * A WebAssembly namespace with SIMD validation forced off.
 *
 * Built by hand rather than with `{...WebAssembly}`: the namespace object's properties
 * are non-enumerable, so a spread copies nothing at all and `canReserve` then fails for
 * want of `Memory` -- which looks exactly like an out-of-memory result and sends the
 * plan down the wrong branch.
 */
function wasmWithoutSimd() {
  return {
    validate: () => false,
    Memory: WebAssembly.Memory,
    Module: WebAssembly.Module,
    Instance: WebAssembly.Instance,
    instantiate: WebAssembly.instantiate.bind(WebAssembly),
  };
}

/** A Storage that throws on every access -- Safari in private mode. */
function hostileStorage() {
  const boom = () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  return { getItem: boom, setItem: boom, removeItem: boom, clear: boom, key: boom, length: 0 };
}

/* ── The probes ─────────────────────────────────────────────────────────── */

test("wasm and SIMD are both detected under node", () => {
  // Node has both, so this is really asserting the probes are not stuck returning
  // false -- which would silently route every visitor to grep-mode.
  assert.equal(hasWasm(), true);
  assert.equal(hasSimd(), true);
});

test("the SIMD probe rejects a corrupted module", () => {
  // If WebAssembly.validate returned true for anything, the probe would be
  // meaningless. Verified against a deliberately broken module rather than assumed.
  assert.equal(WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 9, 9, 9, 9])), false);
  assert.equal(WebAssembly.validate(new Uint8Array([1, 2, 3])), false);
});

test("canReserve succeeds for a plausible size and is memoised", () => {
  assert.equal(canReserve(HEAP_MB_FULL), true);
  // Same answer, and the second call must not allocate another 160 MB.
  assert.equal(canReserve(HEAP_MB_FULL), true);
});

test("canReserve fails for an impossible size rather than throwing", () => {
  // wasm32 tops out at 4 GiB, so this is a guaranteed RangeError inside the probe.
  assert.equal(canReserve(1024 * 1024), false);
});

test("deviceMemoryGB reports null when the browser does not implement it", () => {
  // Safari, which is every iPhone -- hence the iOS check existing separately.
  withGlobals({ navigator: { userAgent: "test" } }, () => {
    assert.equal(deviceMemoryGB(), null);
  });
});

test("deviceMemoryGB reports the value when present", () => {
  withGlobals({ navigator: { userAgent: "test", deviceMemory: 4 } }, () => {
    assert.equal(deviceMemoryGB(), 4);
  });
});

test("isIOS detects iPhone", () => {
  withGlobals(
    {
      navigator: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
    },
    () => assert.equal(isIOS(), true),
  );
});

test("isIOS detects iPadOS pretending to be a Mac", () => {
  // iPadOS 13+ reports "Macintosh" verbatim. maxTouchPoints is what gives it away,
  // and without this branch every iPad would be treated as a desktop.
  withGlobals(
    {
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      },
    },
    () => assert.equal(isIOS(), true),
  );
});

test("isIOS does not fire on a real Mac", () => {
  withGlobals(
    {
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        maxTouchPoints: 0,
      },
    },
    () => assert.equal(isIOS(), false),
  );
});

test("isConstrained fires on low reported memory", () => {
  withGlobals({ navigator: { userAgent: "test", deviceMemory: 2 } }, () => {
    assert.equal(isConstrained(), true);
  });
});

test("isConstrained does not fire on a well-provisioned desktop", () => {
  withGlobals({ navigator: { userAgent: "test", deviceMemory: 8 } }, () => {
    assert.equal(isConstrained(), false);
  });
});

/* ── The crash breadcrumb ───────────────────────────────────────────────── */

test("the breadcrumb round-trips", () => {
  withGlobals({ sessionStorage: fakeStorage() }, () => {
    assert.equal(crashedLastTime(), false);
    markLoadStarted();
    // This is what a killed tab leaves behind: the mark, never cleared.
    assert.equal(crashedLastTime(), true);
    markLoadFinished();
    assert.equal(crashedLastTime(), false);
  });
});

test("a hostile sessionStorage does not break anything", () => {
  // Safari private mode throws on read AND write. Losing the breadcrumb is fine;
  // throwing out of `ask` is not.
  withGlobals({ sessionStorage: hostileStorage() }, () => {
    assert.doesNotThrow(() => markLoadStarted());
    assert.doesNotThrow(() => markLoadFinished());
    assert.equal(crashedLastTime(), false, "an unreadable store is not evidence of a crash");
  });
});

test("no sessionStorage at all does not break anything", () => {
  withGlobals({ sessionStorage: undefined }, () => {
    assert.doesNotThrow(() => markLoadStarted());
    assert.equal(crashedLastTime(), false);
  });
});

/* ── The decision ───────────────────────────────────────────────────────── */

test("--offline always chooses grep-mode and cannot be overridden", () => {
  const p = plan({ offline: true });
  assert.equal(p.mode, "grep");
  assert.equal(p.reason, "--offline");
  assert.equal(p.overridable, false);
});

test("--offline wins over --force-llm", () => {
  // Both flags at once is contradictory; the one that asks for *less* work wins,
  // because it is the one that cannot fail.
  assert.equal(plan({ offline: true, forceLlm: true }).mode, "grep");
});

test("a capable desktop gets the model with no warning", () => {
  withGlobals(
    { navigator: { userAgent: "test", deviceMemory: 8 }, sessionStorage: fakeStorage() },
    () => {
      const p = plan();
      assert.equal(p.mode, "llm");
      assert.equal(p.warn, undefined);
      assert.equal(p.nCtx, 0, "0 means the configured default");
    },
  );
});

test("a constrained device that can still run the model gets a reduced context", () => {
  withGlobals(
    { navigator: { userAgent: "test", deviceMemory: 4 }, sessionStorage: fakeStorage() },
    () => {
      const p = plan();
      assert.equal(p.nCtx, N_CTX_REDUCED);
    },
  );
});

test("a stale breadcrumb routes to grep-mode with an accurate reason", () => {
  withGlobals(
    { navigator: { userAgent: "test", deviceMemory: 8 }, sessionStorage: fakeStorage() },
    () => {
      markLoadStarted();
      const p = plan();
      assert.equal(p.mode, "grep");
      assert.match(/** @type {string} */ (p.reason), /crashed this tab/);
      assert.equal(p.overridable, true, "the visitor must be able to insist");
    },
  );
});

test("--force-llm overrides a stale breadcrumb", () => {
  withGlobals(
    { navigator: { userAgent: "test", deviceMemory: 8 }, sessionStorage: fakeStorage() },
    () => {
      markLoadStarted();
      assert.equal(plan({ forceLlm: true }).mode, "llm");
    },
  );
});

test("no WebAssembly means grep-mode, and there is nothing to override", () => {
  withGlobals({ WebAssembly: undefined, navigator: { userAgent: "test" } }, () => {
    const p = plan();
    assert.equal(p.mode, "grep");
    assert.match(/** @type {string} */ (p.reason), /WebAssembly/);
    assert.equal(p.overridable, false, "--force-llm cannot conjure an engine");
  });
});

test("--force-llm does not override a missing WebAssembly", () => {
  withGlobals({ WebAssembly: undefined, navigator: { userAgent: "test" } }, () => {
    assert.equal(plan({ forceLlm: true }).mode, "grep");
  });
});

test("no SIMD on a desktop still gets the model, with a warning", () => {
  // The departure from the original plan, recorded as a test. The plan sent every
  // no-SIMD visitor to grep-mode assuming a ~60s prefill; M10 measured the scalar
  // path at ~17s, which is a wait rather than a hang. The warning is what makes it
  // honest, and it must state a number.
  withGlobals(
    {
      WebAssembly: wasmWithoutSimd(),
      navigator: { userAgent: "test", deviceMemory: 8 },
      sessionStorage: fakeStorage(),
    },
    () => {
      const p = plan();
      assert.equal(p.mode, "llm");
      assert.match(/** @type {string} */ (p.warn), /SIMD/);
      assert.match(/** @type {string} */ (p.warn), /\d+ seconds/);
    },
  );
});

test("no SIMD on a constrained device defaults to grep-mode", () => {
  // Where 17s becomes a minute or more. Overridable, because it is a judgement call
  // about the visitor's patience rather than a hard limit.
  withGlobals(
    {
      WebAssembly: wasmWithoutSimd(),
      navigator: { userAgent: "test", deviceMemory: 2 },
      sessionStorage: fakeStorage(),
    },
    () => {
      const p = plan();
      assert.equal(p.mode, "grep");
      assert.match(/** @type {string} */ (p.reason), /SIMD/);
      assert.equal(p.overridable, true);
      assert.equal(p.nCtx, N_CTX_REDUCED, "the reduced context still applies if forced");
    },
  );
});

test("every grep-mode reason reads as a sentence fragment, not a code", () => {
  // These are printed verbatim after "ask: ", so they have to be prose. A leaked
  // identifier like ERR_NO_SIMD would be a visible bug.
  const reasons = [
    plan({ offline: true }).reason,
    ...withReasons(),
  ].filter((r) => r !== undefined);
  // SIMD and WebAssembly are the real names of the real things, so they are prose
  // here. What must not appear is an identifier: SCREAMING_SNAKE, or anything with an
  // underscore in it.
  for (const reason of reasons) {
    const text = /** @type {string} */ (reason);
    assert.ok(text.length > 2, `too terse: ${text}`);
    assert.ok(!text.includes("_"), `looks like an identifier: ${text}`);
    const stripped = text.replace(/\b(SIMD|WebAssembly)\b/g, "");
    assert.ok(!/[A-Z]{2,}/.test(stripped), `looks like an error code: ${text}`);
    assert.ok(/\s/.test(text) || text.startsWith("--"), `not a phrase: ${text}`);
  }
});

/** Collect the reasons from the branches that produce one. */
function withReasons() {
  /** @type {(string|undefined)[]} */
  const out = [];
  withGlobals({ WebAssembly: undefined, navigator: { userAgent: "test" } }, () => {
    out.push(plan().reason);
  });
  withGlobals(
    { navigator: { userAgent: "test", deviceMemory: 8 }, sessionStorage: fakeStorage() },
    () => {
      markLoadStarted();
      out.push(plan().reason);
    },
  );
  withGlobals(
    {
      WebAssembly: wasmWithoutSimd(),
      navigator: { userAgent: "test", deviceMemory: 2 },
      sessionStorage: fakeStorage(),
    },
    () => out.push(plan().reason),
  );
  return out;
}
