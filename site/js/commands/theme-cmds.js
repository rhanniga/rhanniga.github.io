// @ts-check
/**
 * Appearance: the CRT effects and the font.
 *
 * Both persist, and both read their stored value from an inline script in
 * index.html before first paint so there is no flash of the wrong appearance.
 */

import { c, sp, blank } from "../render/chunk.js";
import { GLYPH, ASCII_RULE, setRuleGlyph } from "../render/layout.js";
import { load, save } from "../util.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */
/** @typedef {import('../shell/registry.js').CommandContext} CommandContext */

const CRT_KEY = "crt";
const FONT_KEY = "font";

/**
 * The default when nothing is stored. Static texture is not motion, so
 * prefers-reduced-motion does not by itself disable scanlines -- but
 * prefers-contrast: more genuinely should, and someone who has set a preference
 * explicitly always overrides the default either way.
 * @returns {boolean}
 */
function crtDefault() {
  return !(
    matchMedia("(prefers-reduced-motion: reduce)").matches ||
    matchMedia("(prefers-contrast: more)").matches
  );
}

/** @returns {boolean} */
function crtEnabled() {
  const stored = load(CRT_KEY);
  if (stored === "on") return true;
  if (stored === "off") return false;
  return crtDefault();
}

/** @param {boolean} on */
function applyCrt(on) {
  document.documentElement.dataset.crt = on ? "on" : "off";
}

/** @type {Command} */
export const crtCmd = {
  name: "crt",
  group: "misc",
  summary: "scanlines, vignette and phosphor glow",
  usage: "crt [on|off]",
  synopsis: [
    "With no argument, reports the current setting.",
    "",
    "The effects are static -- there is no animated flicker or rolling scanline,",
    "both of which are motion-sickness inducing and cost real battery on mobile.",
    "",
    "Defaults to off if you have asked for reduced motion or increased contrast.",
    "The setting persists.",
  ],
  complete: (argv, index) => (index === 1 ? ["on", "off"] : []),
  run: (ctx) => {
    const arg = ctx.argv[1];

    if (arg === undefined) {
      const on = crtEnabled();
      ctx.out([
        c("crt: "),
        c(on ? "on" : "off", on ? "success" : "dim"),
        c("  (scanlines, vignette, glow)", "dim"),
      ]);
      return EXIT.OK;
    }

    if (arg !== "on" && arg !== "off") {
      ctx.err(`crt: ${arg}: expected on or off`);
      return EXIT.USAGE;
    }

    const on = arg === "on";
    save(CRT_KEY, arg);
    applyCrt(on);
    ctx.out([c(`crt: ${arg}`, "dim")]);
    return EXIT.OK;
  },
};

/* ── Font ─────────────────────────────────────────────────────────────── */

/** @returns {'system'|'pixel'} */
function currentFont() {
  return load(FONT_KEY) === "pixel" ? "pixel" : "system";
}

/**
 * @param {'system'|'pixel'} which
 */
function applyFont(which) {
  if (which === "pixel") document.documentElement.dataset.font = "pixel";
  else delete document.documentElement.dataset.font;
}

/** @type {Command} */
export const fontCmd = {
  name: "font",
  group: "misc",
  summary: "switch between the system mono and PixelOperatorMono",
  usage: "font [system|pixel]",
  synopsis: [
    "system  the platform's own monospace face — the default",
    "pixel   PixelOperatorMono, salvaged from the previous version of this site",
    "",
    "The system stack is the default deliberately: it costs no bytes, has no",
    "flash of unstyled text, and shows you the font your own terminal uses.",
    "",
    "Pixel fonts are crisp only at exact integer multiples of their 16px em",
    "grid, so at fractional display scaling they go soft. Switching runs a",
    "measurement first and refuses if the face is not genuinely monospaced.",
  ],
  complete: (argv, index) => (index === 1 ? ["system", "pixel"] : []),
  run: (ctx) => {
    const arg = ctx.argv[1];

    if (arg === undefined) {
      const which = currentFont();
      const probe = ctx.term.probeFont();
      ctx.out([c("font: "), c(which, "bright")]);
      ctx.out([
        sp(2),
        c("monospaced ", "dim"),
        probe.mono ? c("yes", "success") : c("NO", "error"),
        c("   rule glyph ", "dim"),
        probe.rule ? c("ok", "success") : c("falling back to ASCII", "warn"),
      ]);
      return EXIT.OK;
    }

    if (arg !== "system" && arg !== "pixel") {
      ctx.err(`font: ${arg}: expected system or pixel`);
      return EXIT.USAGE;
    }

    const previous = currentFont();
    applyFont(arg);

    // Measure the face we just selected before trusting it. A proportional or
    // partially-covered font silently breaks every aligned layout in the site,
    // and that is much harder to diagnose after the fact than a refusal now.
    const probe = ctx.term.probeFont();
    if (!probe.mono) {
      applyFont(previous);
      ctx.term.remeasure();
      ctx.err(`font: ${arg}: not monospaced on this system — keeping ${previous}`);
      return EXIT.ERROR;
    }

    setRuleGlyph(probe.rule ? "─" : ASCII_RULE);
    save(FONT_KEY, arg);
    const cols = ctx.term.remeasure();

    ctx.out([c(`font: ${arg}`, "dim"), c(`  ${cols} columns`, "dim")]);
    if (!probe.rule) {
      ctx.out([
        sp(2),
        c("note: ", "warn"),
        c(`this face has no U+2500, so rules now use '${GLYPH.RULE}'`, "dim"),
      ]);
    }
    ctx.out([c("  earlier output keeps its old wrapping", "dim")]);
    return EXIT.OK;
  },
};

/** @type {Command} */
export const themeCmd = {
  name: "theme",
  group: "misc",
  summary: "report the current appearance settings",
  run: (ctx) => {
    const probe = ctx.term.probeFont();
    /** @type {Array<[string, import('../render/chunk.js').Line]>} */
    const rows = [
      ["palette", [c("Nord", "bright"), c("  (nord0 background, 16-colour ANSI)", "dim")]],
      ["font", [c(currentFont(), "bright")]],
      ["crt", [crtEnabled() ? c("on", "success") : c("off", "dim")]],
      ["columns", [c(String(ctx.cols))]],
      ["cell", [c(`${probe.mono ? "monospaced" : "NOT monospaced"}`, probe.mono ? "text" : "error")]],
      ["rule", [c(GLYPH.RULE === ASCII_RULE ? "ASCII fallback" : "U+2500")]],
    ];
    const width = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
    for (const [key, value] of rows) {
      ctx.out([sp(2), c(key.padEnd(width), "dim"), sp(2), ...value]);
    }
    ctx.out(blank);
    return EXIT.OK;
  },
};

/**
 * Apply stored settings at startup. The inline script in index.html already
 * stamped data-crt before first paint; this covers the font, which cannot flash
 * because it only ever changes away from the default.
 */
export function applyStoredAppearance() {
  applyCrt(crtEnabled());
  applyFont(currentFont());
}

export const themeCommands = [crtCmd, fontCmd, themeCmd];
