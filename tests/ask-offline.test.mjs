// @ts-check
/**
 * `ask --offline` end to end, through the real dispatcher.
 *
 * Everything below the command is real: the registry, flag parsing, the capability
 * gate, retrieval, and the formatters. Only the terminal is a stub, and only because
 * `ask` asks it for a column count and a transient row for the progress bar.
 *
 * This is the layer the unit tests do not reach. `fallback.test.mjs` proves retrieval
 * ranks correctly and `format.test.mjs` proves it renders; neither would notice if
 * `--offline` were spelled wrong in the flag spec, or if the gate were consulted after
 * the download rather than before it.
 *
 * No model, no network, no DOM -- so it runs on a bare checkout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { dispatch } from "../site/js/shell/dispatch.js";
import { buildRegistry } from "../site/js/commands/index.js";
import { Env, EXIT } from "../site/js/shell/env.js";
import { History } from "../site/js/terminal/history.js";
import { tokenize } from "../site/js/shell/tokenize.js";
import { text } from "../site/js/render/chunk.js";
import { validateResume } from "../site/js/data/resume.js";

// loadResume() fetches and validates; there is no transform step, so parsing the file
// here yields exactly the object the browser passes to commands. Validated anyway, so
// a malformed resume fails here rather than as a confusing assertion further down.
const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);
const problems = validateResume(resume);
assert.deepEqual(problems, [], "site/resume.json is malformed");

/**
 * Run one command line the way the shell does.
 * @param {string} line
 * @returns {Promise<{status: number, out: string, err: string}>}
 */
async function run(line) {
  const env = new Env();
  /** @type {string[]} */
  const outLines = [];
  /** @type {string[]} */
  const errLines = [];

  const term = {
    cols: () => 76,
    // `ask` draws its progress bar into a transient row. In offline mode it should
    // never ask for one, which the assertions below check.
    transientRow: () => {
      term.transientRows++;
      return { set: () => {}, discard: () => {} };
    },
    pushMode: () => {},
    removeMode: () => {},
    transientRows: 0,
  };

  const tokenized = tokenize(line, env);
  const argv = /** @type {any} */ (tokenized).argv ?? tokenized;

  const status = await dispatch(
    /** @type {string[]} */ (argv),
    {
      registry: buildRegistry(),
      env,
      resume,
      history: new History("test"),
      motd: () => {},
      term: /** @type {any} */ (term),
      out: (l) => outLines.push(text(l)),
      rows: (ls) => {
        for (const l of ls) outLines.push(text(l));
      },
      err: (t) => errLines.push(t),
    },
    new AbortController().signal,
  );

  return {
    status,
    out: outLines.join("\n"),
    err: errLines.join("\n"),
    transientRows: term.transientRows,
  };
}

test("--offline answers from the resume and exits 0", async () => {
  const r = await run('ask --offline "what did you do at CERN?"');
  assert.equal(r.status, EXIT.OK);
  assert.match(r.out, /CERN/);
  assert.equal(r.err, "", `unexpected stderr: ${r.err}`);
});

test("--offline says which mode it used", async () => {
  // A silent change of behaviour is the thing to avoid. The visitor asked for a
  // model; they get the resume; they should be told.
  const r = await run('ask --offline "what did you do at CERN?"');
  assert.match(r.out, /--offline/);
  assert.match(r.out, /answering from the resume/);
});

test("--offline never touches the network or the progress bar", async () => {
  // The strongest available proof that the gate runs before the download: there is
  // no fetch in this process, and the transient row the progress bar needs is never
  // requested.
  const r = await run('ask --offline "what languages does he know"');
  assert.equal(r.transientRows, 0, "offline mode allocated a progress row");
  assert.match(r.out, /Python/);
});

test("--offline with no match exits 1, like grep", async () => {
  const r = await run('ask --offline "kubernetes"');
  assert.equal(r.status, EXIT.ERROR);
  assert.match(r.out, /nothing in the resume matches/);
});

test("a contact question is intercepted even in --offline", async () => {
  // The interception must not be a property of the model path. Asked for a phone
  // number offline, the answer still comes from `contact`, not from retrieval.
  const r = await run('ask --offline "what is his phone number?"');
  assert.equal(r.status, EXIT.OK);
  assert.match(r.out, /contact details come from the resume/);
  // And the real number is only ever printed by this deterministic path, so it is
  // allowed to appear here -- but nothing phone-shaped may be invented around it.
  assert.ok(!/\[redacted\]/.test(r.out), "the deterministic answer must not be redacted");
});

test("an unknown flag is a usage error, and the usage line lists the real flags", async () => {
  const r = await run('ask --bogus "hi"');
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.err + r.out, /bogus/);
  assert.match(r.out, /--offline/);
  assert.match(r.out, /--force-llm/);
});

test("no question at all is a usage error, not an empty search", async () => {
  const r = await run("ask --offline");
  assert.equal(r.status, EXIT.USAGE);
  assert.match(r.err, /no question given/);
});

test("the question can be given unquoted", async () => {
  // `ask what did you do at CERN` -- operands are joined, so this must work the same
  // as the quoted form.
  const quoted = await run('ask --offline "what did you do at CERN"');
  const bare = await run("ask --offline what did you do at CERN");
  assert.equal(bare.status, EXIT.OK);
  assert.equal(bare.out, quoted.out);
});

test("--offline output stays inside the terminal width", async () => {
  const r = await run('ask --offline "what languages does he know"');
  for (const line of r.out.split("\n")) {
    assert.ok(line.length <= 76, `${line.length}-wide line: ${line}`);
  }
});

test("a bare `ask` with no model deployed still answers", async () => {
  // No `--offline`. resolveEngine reads `location` and probes for the manifest, and
  // under node the probe cannot succeed -- which is exactly the not-deployed case a
  // fresh checkout is in. It must degrade to the resume rather than exiting 69,
  // because the resume is right there.
  //
  // `location` has to be stubbed: engine.js reads location.search and
  // location.hostname, and a ReferenceError would be swallowed as "internal error"
  // rather than testing anything. hostname is deliberately not localhost, so the
  // mock engine is not selected.
  const had = "location" in globalThis;
  const previous = /** @type {any} */ (globalThis).location;
  Object.defineProperty(globalThis, "location", {
    value: { search: "", hostname: "www.hannigan.sh" },
    configurable: true,
    writable: true,
  });
  const { resetEngineCache } = await import("../site/js/llm/engine.js");
  resetEngineCache();
  try {
    const r = await run('ask "what did you do at CERN?"');
    assert.notEqual(r.status, EXIT.UNAVAILABLE);
    assert.match(r.out, /CERN/, "it should still have answered something");
    assert.match(r.out, /answering from the resume/);
  } finally {
    if (had) {
      Object.defineProperty(globalThis, "location", {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete /** @type {any} */ (globalThis).location;
    }
    resetEngineCache();
  }
});
