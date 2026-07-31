// @ts-check
/**
 * WCAG contrast audit for the Nord palette as this site uses it.
 *
 *   node tools/contrast.mjs
 *
 * Exists because the ratios written into site/styles/theme.css are load-bearing
 * -- several Nord colours fail AA outright, and the two color-mix() values are
 * there specifically to clear 4.5:1. A comment claiming a ratio is worth much
 * less than a command that recomputes it, so re-run this after any palette
 * change and update the comments to match.
 */

/** @param {string} h @returns {[number, number, number]} */
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** sRGB -> linear, per WCAG 2.1. @param {number} v */
const lin = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** @param {number[]} rgb */
const luminance = (rgb) =>
  0.2126 * lin(rgb[0] ?? 0) + 0.7152 * lin(rgb[1] ?? 0) + 0.0722 * lin(rgb[2] ?? 0);

/** @param {number[]} a @param {number[]} b */
const ratio = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/**
 * `color-mix(in srgb, A p%, B)` is a straight per-channel sRGB interpolation.
 * @param {number[]} a @param {number[]} b @param {number} p
 */
const mix = (a, b, p) => a.map((v, i) => Math.round(v * p + (b[i] ?? 0) * (1 - p)));

const N = {
  nord0: "#2e3440", nord1: "#3b4252", nord2: "#434c5e", nord3: "#4c566a",
  nord4: "#d8dee9", nord5: "#e5e9f0", nord6: "#eceff4",
  nord7: "#8fbcbb", nord8: "#88c0d0", nord9: "#81a1c1", nord10: "#5e81ac",
  nord11: "#bf616a", nord12: "#d08770", nord13: "#ebcb8b", nord14: "#a3be8c",
  nord15: "#b48ead",
};

const AA = 4.5; // normal-size text
const AA_NONTEXT = 3.0; // borders, focus rings, large text

const bg = hex(N.nord0);
let failures = 0;

console.log("Contrast against --bg (nord0 " + N.nord0 + ")\n");
console.log("  colour   ratio   AA 4.5   non-text 3.0");
for (const [name, value] of Object.entries(N)) {
  if (name === "nord0") continue;
  const r = ratio(hex(value), bg);
  console.log(
    "  " + name.padEnd(8) +
    r.toFixed(2).padStart(6) +
    (r >= AA ? "   pass" : "   FAIL").padStart(9) +
    (r >= AA_NONTEXT ? "   pass" : "   FAIL").padStart(15),
  );
}

console.log("\nSemantic roles that exist to clear AA:\n");
/** @type {Array<[string, number[], number]>} */
const roles = [
  ["--fg-dim      62% nord4 / nord0 ", mix(hex(N.nord4), bg, 0.62), AA],
  ["--error-text  70% nord11 / nord6", mix(hex(N.nord11), hex(N.nord6), 0.7), AA],
  ["--accent      96% nord15 / nord6", mix(hex(N.nord15), hex(N.nord6), 0.96), AA],
  ["--warn        96% nord12 / nord6", mix(hex(N.nord12), hex(N.nord6), 0.96), AA],
];
for (const [label, rgb, threshold] of roles) {
  const r = ratio(rgb, bg);
  const ok = r >= threshold;
  if (!ok) failures++;
  console.log("  " + label + "  " + r.toFixed(2) + (ok ? "  pass" : "  FAIL"));
}

console.log("\nRoles allowed to be non-text only:\n");
for (const [label, value] of [["--focus-ring nord10", N.nord10], ["--rule nord3", N.nord3]]) {
  const r = ratio(hex(value), bg);
  const need = label.includes("focus") ? AA_NONTEXT : 0;
  const ok = r >= need;
  if (!ok) failures++;
  console.log("  " + label.padEnd(20) + r.toFixed(2) + (ok ? "  pass" : "  FAIL"));
}

console.log("\n  selection: nord6 on nord2 = " + ratio(hex(N.nord6), hex(N.nord2)).toFixed(2));

console.log(
  "\n" + (failures === 0 ? "All roles meet their threshold." : failures + " role(s) FAIL."),
);
process.exit(failures === 0 ? 0 : 1);
