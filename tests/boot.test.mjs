// @ts-check
/**
 * The boot banner's design rule is that every line states something true, and
 * anything unobtainable is omitted rather than invented. These tests pin that,
 * plus the width constraint -- a banner that overflows on a phone is the first
 * thing a visitor sees.
 *
 * boot.js touches navigator/screen/window/document/matchMedia, so they are
 * defined here. `navigator` is a getter-only global in modern Node, hence
 * defineProperty rather than assignment.
 */

import test from "node:test";
import assert from "node:assert/strict";

/** @param {string} name @param {unknown} value */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

define("navigator", { hardwareConcurrency: 8, deviceMemory: 8 });
define("screen", { width: 2560, height: 1440 });
define("window", { devicePixelRatio: 2 });
define("document", {
  lastModified: "Tue, 29 Jul 2025 19:29:00 GMT",
  documentElement: { dataset: { crt: "on" } },
});
define("matchMedia", () => ({ matches: false }));

const { collectFacts, bootLines } = await import("../site/js/terminal/boot.js");
const { text, len } = await import("../site/js/render/chunk.js");

/**
 * Join a banner into one whitespace-normalised string, so assertions survive
 * legitimate wrapping -- at 42 columns several of these lines genuinely wrap.
 * @param {import('../site/js/render/chunk.js').Line[]} lines
 */
const flat = (lines) => lines.map(text).join(" ").replace(/\s+/g, " ");

/** @param {Partial<Parameters<typeof bootLines>[0]>} [over] */
function banner(over = {}) {
  return bootLines({
    cols: 42,
    facts: collectFacts({ resumeBytes: 7027, crtOn: true }),
    previousVisit: new Date(2025, 6, 22, 9, 14, 3),
    deployed: new Date(2025, 6, 29, 19, 29, 0),
    name: "Dr. Ryan Hannigan",
    tagline: "software engineer, postdoctoral fellow, lecturer",
    error: null,
    ...over,
  });
}

test("no banner line exceeds the terminal width, at any width", () => {
  for (const cols of [20, 30, 42, 60, 80, 120]) {
    for (const line of banner({ cols })) {
      assert.ok(
        len(line) <= cols,
        `${cols} cols: ${len(line)}-wide line ${JSON.stringify(text(line))}`,
      );
    }
  }
});

test("the banner stays short enough not to bury the prompt on a phone", () => {
  // Budget from the plan: <= 10 visible lines at 375px. Blanks do not count
  // against comprehension but do against screen space, so count everything.
  const lines = banner({ cols: 42 });
  assert.ok(lines.length <= 18, `banner is ${lines.length} lines`);
});

test("reports real machine facts", () => {
  const facts = collectFacts({ resumeBytes: 7027, crtOn: true });
  const byLabel = new Map(facts.map((f) => [f.label, f.value]));
  assert.equal(byLabel.get("cpu"), "8 logical cores");
  assert.equal(byLabel.get("display"), "2560x1440 @2x");
  assert.match(byLabel.get("resume") ?? "", /6\.9 KB loaded/);
});

test("omits a fact it cannot determine rather than inventing one", () => {
  // deviceMemory is Chrome-only; Safari must simply not get that line.
  define("navigator", { hardwareConcurrency: 4 });
  const labels = collectFacts({ resumeBytes: 100, crtOn: false }).map((f) => f.label);
  assert.ok(!labels.includes("mem"), "mem must be absent when deviceMemory is");
  assert.ok(labels.includes("cpu"));

  // And with no hardwareConcurrency either.
  define("navigator", {});
  const fewer = collectFacts({ resumeBytes: 100, crtOn: false }).map((f) => f.label);
  assert.ok(!fewer.includes("cpu"));
  assert.ok(!fewer.includes("mem"));

  define("navigator", { hardwareConcurrency: 8, deviceMemory: 8 });
});

test("singularises a single core", () => {
  define("navigator", { hardwareConcurrency: 1 });
  const facts = collectFacts({ resumeBytes: 1, crtOn: false });
  assert.equal(facts.find((f) => f.label === "cpu")?.value, "1 logical core");
  define("navigator", { hardwareConcurrency: 8, deviceMemory: 8 });
});

test("omits the @Nx suffix at a device pixel ratio of exactly 1", () => {
  define("window", { devicePixelRatio: 1 });
  const facts = collectFacts({ resumeBytes: 1, crtOn: false });
  assert.equal(facts.find((f) => f.label === "display")?.value, "2560x1440");
  define("window", { devicePixelRatio: 2 });
});

test("a failed resume load is reported, not hidden", () => {
  const facts = collectFacts({ resumeBytes: null, crtOn: true });
  assert.equal(facts.find((f) => f.label === "resume")?.value, "FAILED to load");

  const all = flat(banner({ error: "HTTP 404 fetching resume.json", name: "", tagline: "" }));
  // Terminal-shaped, so it reads as a shell error rather than a web page's.
  assert.match(all, /bash: resume\.json: No such file or directory/);
  assert.match(all, /shell commands still work/);
  assert.match(all, /HTTP 404/);
});

test("a returning visitor gets a real Last login", () => {
  const all = flat(banner());
  assert.match(all, /Last login: Tue Jul 22 09:14:03/);
});

test("a first visit says deployed, not last login", () => {
  // Claiming a previous login that never happened would be a lie in a banner
  // whose entire premise is that it does not tell them.
  const all = flat(banner({ previousVisit: null }));
  assert.doesNotMatch(all, /Last login/);
  assert.match(all, /last deployed Tue Jul 29 19:29:00/);
});

test("the crt hint is dropped rather than overflowing a narrow terminal", () => {
  // A dot-leader line looks broken when word-wrapped, so the optional note goes
  // first and the alignment survives.
  const wide = flat(banner({ cols: 80 }));
  assert.match(wide, /crt off to disable/);

  const narrow = flat(banner({ cols: 30 }));
  assert.doesNotMatch(narrow, /crt off to disable/);
  assert.match(narrow, /crt \.+ enabled/);
});

test("the banner always tells the visitor what to type next", () => {
  for (const cols of [20, 42, 80]) {
    const all = flat(banner({ cols }));
    assert.match(all, /help/, `${cols} cols`);
    assert.match(all, /summary/, `${cols} cols`);
  }
});
