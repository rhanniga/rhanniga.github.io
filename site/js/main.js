// @ts-check
/**
 * Bootstrap.
 *
 * Two entry paths. `?plain=1` renders a semantic HTML resume and never builds a
 * terminal at all -- not a hidden one, not an idle one. Everything else boots the
 * emulator.
 */

import { Terminal } from "./terminal/terminal.js";
import { ShellMode } from "./terminal/shell-mode.js";
import { History } from "./terminal/history.js";
import { setIdentity } from "./terminal/prompt.js";
import {
  collectFacts,
  bootLines,
  revealBoot,
  readLastLogin,
  stampLastLogin,
  powerOn,
} from "./terminal/boot.js";
import { buildRegistry } from "./commands/index.js";
import { applyStoredAppearance } from "./commands/theme-cmds.js";
import { Env } from "./shell/env.js";
import { loadResume, emptyResume } from "./data/resume.js";
import { resolveIp } from "./identity.js";
import { createAnnouncer } from "./render/announcer.js";
import { mountSoftkeys } from "./terminal/softkeys.js";
import { fitToVisualViewport } from "./terminal/viewport-fit.js";
import { wantsPlain, mountPlain } from "./render/plain.js";

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function must(id) {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id} in index.html`);
  return el;
}

/* ── Resume data ─────────────────────────────────────────────────────────
 * A failure must not produce a white screen: the shell comes up either way, the
 * resume commands report honestly, and everything else keeps working. The boot
 * sequence reports the real byte count as it lands, which is why it is measured
 * here rather than assumed. */
let resume = emptyResume();
/** @type {string | null} */
let loadError = null;
/** @type {number | null} */
let resumeBytes = null;
try {
  const loaded = await loadResume();
  resume = loaded.resume;
  resumeBytes = loaded.bytes;
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err);
  console.error("[resume]", err);
}

if (wantsPlain(location.search)) {
  /* ── The plain view ───────────────────────────────────────────────────
   * Checked before anything terminal-shaped is constructed. Someone who followed
   * the skip link asked for a document; giving them a document plus a dormant
   * terminal, its keydown listener, and its module graph would miss the point. */
  if (loadError !== null) {
    document.body.textContent = "";
    const p = document.createElement("p");
    p.textContent = `Could not load the resume: ${loadError}`;
    document.body.appendChild(p);
  } else {
    mountPlain(resume);
  }
} else {
  // data-crt was already stamped before first paint by the inline script in
  // index.html; this reconciles the font and keeps both in one place.
  applyStoredAppearance();

  const root = must("terminal");
  const term = new Terminal({
    root,
    viewport: must("viewport"),
    output: must("output"),
    inputline: must("inputline"),
    kbd: /** @type {HTMLTextAreaElement} */ (must("kbd")),
    probe: must("metrics"),
  });

  powerOn(root);

  /* ── Banner ───────────────────────────────────────────────────────────── */

  const { previous, deployed } = readLastLogin();

  /** Built fresh each time so it reflects the current width and settings. */
  const buildBanner = () =>
    bootLines({
      cols: term.metrics.cols,
      facts: collectFacts({
        resumeBytes,
        crtOn: document.documentElement.dataset.crt === "on",
      }),
      previousVisit: previous,
      deployed,
      name: loadError === null ? resume.contactInfo.name : "",
      tagline:
        loadError === null ? "backend engineering manager who secretly ICs when nobody is looking, i also lecture physics at UT Austin from time to time" : "",
      error: loadError,
    });

  /** `motd` reprints instantly -- no staging, since it is an explicit request. */
  const motd = () => {
    term.writer.rows(buildBanner());
    term.writer.flush();
  };

  await revealBoot(term.writer, buildBanner());
  stampLastLogin();

  /* ── Shell ────────────────────────────────────────────────────────────── */

  const env = new Env();
  const history = new History("shell");
  const registry = buildRegistry();

  // The screen-reader sink. #output is aria-hidden and hard-wrapped; this gets the
  // same content as complete unwrapped blocks, one per command.
  const announcer = createAnnouncer(document.getElementById("announcer"));

  term.start(new ShellMode({ registry, env, resume, history, motd, announcer }));

  // Mobile only, by CSS: without these, Ctrl+C, Tab and history are unreachable on a
  // phone, because on-screen keyboards have neither Ctrl nor arrow keys.
  mountSoftkeys(document.getElementById("softkeys"), term.api, () => term.focus());

  // Keeps the prompt above the on-screen keyboard. 100dvh handles the URL bar but
  // not the keyboard, which only visualViewport reports.
  fitToVisualViewport(root, () => term.api.scrollToBottom());

  /* Resolve the visitor's IP for the prompt.
   *
   * Deliberately not awaited: the terminal is already interactive, and this is the
   * only third-party request the site makes. It fails silently for anyone running
   * an ad blocker, leaving the `visitor@` fallback in place.
   *
   * Nothing needs re-rendering when it lands. The live line is just `> `, so the
   * identity first appears on the next committed line -- and lines already in
   * scrollback keep `visitor@`, which is correct: scrollback records what was true
   * at the time, and rewriting history would be the actual bug. */
  void resolveIp().then((ip) => {
    if (ip !== null) setIdentity(ip);
  });
}
