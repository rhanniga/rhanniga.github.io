// @ts-check
/**
 * The login banner: a POST-style report, then a MOTD.
 *
 * The design rule is that **every line states something true about the visitor's
 * own machine or about this page**, and any fact that cannot be obtained is
 * omitted rather than invented. That is what separates a boot sequence worth
 * having from cargo-culted fake progress, and it is why there is no simulated
 * "loading kernel modules" theatre here.
 *
 * The reveal is line-by-line, never character-by-character. A full typewriter
 * intro is the thing everyone does; it delays interactivity and is the first
 * thing a returning visitor resents.
 */

import { c, sp, blank, len } from "../render/chunk.js";
import { rule, wrapChunks, indent } from "../render/layout.js";
import { load, save } from "../util.js";
import { hasWasm, hasSimd } from "../llm/capabilities.js";

/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('./writer.js').Writer} Writer */

/** Total time the staged reveal may take. */
const BUDGET_MS = 900;
const MAX_PER_LINE_MS = 80;
const LAST_VISIT_KEY = "lastvisit";
/** Width of the dot-leader column, so the values line up. */
const LEADER = 12;

/**
 * @typedef {{ label: string, value: string, note?: string }} Fact
 */

/**
 * Gather what we can actually determine. Anything unavailable is left out --
 * `navigator.deviceMemory` is Chrome-only, for instance, and guessing at it would
 * be worse than saying nothing.
 *
 * @param {{ resumeBytes: number | null, crtOn: boolean }} opts
 * @returns {Fact[]}
 */
export function collectFacts({ resumeBytes, crtOn }) {
  /** @type {Fact[]} */
  const facts = [];

  const cores = navigator.hardwareConcurrency;
  if (typeof cores === "number" && cores > 0) {
    facts.push({ label: "cpu", value: `${cores} logical core${cores === 1 ? "" : "s"}` });
  }

  // Non-standard and Chrome-only. Omitted entirely elsewhere.
  const mem = /** @type {{deviceMemory?: number}} */ (navigator).deviceMemory;
  if (typeof mem === "number" && mem > 0) {
    facts.push({ label: "mem", value: `${mem} GB or more` });
  }

  if (typeof screen !== "undefined" && screen.width > 0) {
    const dpr = window.devicePixelRatio;
    const scale = dpr === 1 ? "" : ` @${Number(dpr.toFixed(2))}x`;
    facts.push({ label: "display", value: `${screen.width}x${screen.height}${scale}` });
  }

  if (hasWasm()) {
    facts.push({
      label: "wasm",
      value: hasSimd() ? "ok (simd: ok)" : "ok (simd: unavailable)",
    });
  } else {
    facts.push({ label: "wasm", value: "unavailable" });
  }

  if (resumeBytes !== null) {
    facts.push({ label: "resume", value: `${(resumeBytes / 1024).toFixed(1)} KB loaded` });
  } else {
    facts.push({ label: "resume", value: "FAILED to load" });
  }

  facts.push({
    label: "crt",
    value: crtOn ? "enabled" : "disabled",
    note: crtOn ? "crt off to disable" : "crt on to enable",
  });

  return facts;
}

/**
 * date(1)-style timestamp in the visitor's own locale and zone.
 * @param {Date} d
 * @returns {string}
 */
function stamp(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return (
    `${days[d.getDay()]} ${months[d.getMonth()]} ${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/**
 * The previous visit, if there was one.
 *
 * With no build step there is no `__BUILD_DATE__` to inject, and
 * `document.lastModified` is better anyway: it is the real Last-Modified of this
 * page, so on a first visit it reports when the site was actually deployed. It is
 * labelled as a deploy rather than as a login, because calling it a previous
 * login when there wasn't one would be a small lie in a banner whose whole point
 * is that it does not tell them.
 *
 * @returns {{ previous: Date | null, deployed: Date }}
 */
export function readLastLogin() {
  const raw = load(LAST_VISIT_KEY);
  let previous = null;
  if (raw !== null) {
    const t = Number(raw);
    if (Number.isFinite(t) && t > 0) previous = new Date(t);
  }
  return { previous, deployed: new Date(document.lastModified) };
}

/** Record this visit, for next time. */
export function stampLastLogin() {
  save(LAST_VISIT_KEY, String(Date.now()));
}

/**
 * Build the banner.
 *
 * @param {object} opts
 * @param {number} opts.cols
 * @param {Fact[]} opts.facts
 * @param {Date | null} opts.previousVisit
 * @param {Date} opts.deployed
 * @param {string} opts.name
 * @param {string} [opts.tagline]
 * @param {string | null} [opts.error] a resume load failure to report
 * @returns {Line[]}
 */
export function bootLines({ cols, facts, previousVisit, deployed, name, tagline, error }) {
  /** @type {Line[]} */
  const out = [];
  /** Prose wraps; nothing in the banner may exceed the terminal width. */
  const prose = (/** @type {Line} */ line) => out.push(...wrapChunks(line, cols));

  prose([c("hannigan.sh", "bright"), c(" BIOS v1.0", "dim"), c("  --  POST", "dim")]);

  // Width of the fixed scaffolding around a value: indent, label, space, one
  // dot, space. Decided across ALL facts rather than per-fact: a block where some
  // rows are stacked and others inline looks like a rendering bug, so at a width
  // where any fact cannot fit on one line, none of them try.
  const inlineFits = facts.every(
    (f) => 2 + f.label.length + 3 + len([c(f.value)]) <= cols,
  );

  for (const fact of facts) {
    const cls = fact.value.startsWith("FAILED") ? "error" : "text";

    if (!inlineFits) {
      // At 20 columns "cpu ......... 8 logical cores" simply does not fit.
      out.push([sp(2), c(fact.label, "dim")]);
      out.push(...indent(wrapChunks([c(fact.value, cls)], Math.max(1, cols - 4)), 4));
      continue;
    }

    // Shrink the leader before giving up on alignment.
    const room = cols - 2 - fact.label.length - 2 - len([c(fact.value)]);
    const leader = ".".repeat(Math.max(1, Math.min(LEADER - fact.label.length, room)));
    /** @type {Line} */
    const base = [
      sp(2),
      c(fact.label, "dim"),
      sp(1),
      c(leader, "rule"),
      sp(1),
      c(fact.value, cls),
    ];

    // The note is garnish. A dot-leader line looks broken when word-wrapped, so
    // narrow terminals lose the hint rather than the alignment.
    if (fact.note !== undefined) {
      const withNote = [...base, c(`  (${fact.note})`, "dim")];
      out.push(len(withNote) <= cols ? withNote : base);
    } else {
      out.push(base);
    }
  }

  out.push(blank);
  out.push(rule(cols));

  if (error !== null && error !== undefined) {
    // Terminal-authentic failure rather than a blank section or a modal.
    prose([c("bash: resume.json: No such file or directory", "error")]);
    out.push(
      ...indent(
        wrapChunks(
          [c("the resume data failed to load; shell commands still work", "dim")],
          cols - 2,
        ),
        2,
      ),
    );
    out.push(...indent(wrapChunks([c(error, "dim")], cols - 2), 2));
  } else {
    if (name !== "") prose([c(name, "bright")]);
    if (tagline !== undefined && tagline !== "") prose([c(tagline, "dim")]);
  }

  out.push(blank);
  prose(
    previousVisit !== null
      ? [c("Last login: ", "dim"), c(stamp(previousVisit))]
      : [c("Welcome. This page was last deployed ", "dim"), c(stamp(deployed)), c(".", "dim")],
  );
  prose([
    c("Type "),
    c("help", "bright"),
    c(" for commands, or "),
    c("summary", "bright"),
    c(" to start."),
  ]);
  out.push(blank);

  return out;
}

/**
 * Reveal the banner line by line, and resolve when it is done.
 *
 * Any keypress, click, or touch completes it immediately. That is
 * non-negotiable: a returning visitor must never be held hostage by an
 * animation, and the whole reason it is short is that it is in the way.
 *
 * @param {Writer} writer
 * @param {Line[]} lines
 * @param {{ reduced?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function revealBoot(writer, lines, opts = {}) {
  const reduced =
    opts.reduced ?? matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (reduced || lines.length === 0) {
    writer.rows(lines);
    writer.flush();
    return Promise.resolve();
  }

  const perLine = Math.min(MAX_PER_LINE_MS, Math.floor(BUDGET_MS / lines.length));

  return new Promise((resolve) => {
    let i = 0;
    let timer = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Flush whatever is left in one go.
      for (; i < lines.length; i++) writer.row(lines[i] ?? []);
      writer.flush();
      removeSkip();
      resolve();
    };

    const step = () => {
      if (done) return;
      if (i >= lines.length) {
        finish();
        return;
      }
      writer.row(lines[i] ?? []);
      writer.flush();
      i++;
      timer = setTimeout(step, perLine);
    };

    const onSkip = () => finish();
    const removeSkip = () => {
      window.removeEventListener("keydown", onSkip, true);
      window.removeEventListener("pointerdown", onSkip, true);
      window.removeEventListener("touchstart", onSkip, true);
    };
    window.addEventListener("keydown", onSkip, true);
    window.addEventListener("pointerdown", onSkip, true);
    window.addEventListener("touchstart", onSkip, true);

    step();
  });
}

/**
 * Play the one-shot CRT power-on flash.
 *
 * Opacity and filter only -- deliberately no transform. Scaling the terminal would
 * change its layout width mid-animation, and the column count is measured from
 * that width, so the whole grid would be computed against a transient size.
 *
 * @param {HTMLElement} root
 */
export function powerOn(root) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (document.documentElement.dataset.crt !== "on") return;
  root.dataset.powerOn = "1";
  setTimeout(() => {
    delete root.dataset.powerOn;
  }, 400);
}
