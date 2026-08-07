// @ts-check
/**
 * The knobs: what they are called, how they move, and how they print.
 *
 * Kept apart from both the model and the widget on purpose. The model does not
 * care that `loanRate` is shown as a percentage with two decimals, and the widget
 * does not care that the default is 6.5% -- so neither of them says so, and one
 * table here is the single place a default or a step can be wrong.
 *
 * Every rate is stored as a fraction and *displayed* as a percentage, because
 * "6.50 %" is what a mortgage is quoted as and 0.065 is what the arithmetic needs.
 */

import { clamp, load, save } from "../util.js";

/** @typedef {import('./model.js').Params} Params */

/**
 * @typedef {'money'|'rate'|'years'} FieldKind
 */

/**
 * One editable parameter.
 *
 * `step` is in model units: 0.005 on a rate is half a percentage point. `decimals`
 * is display-only -- the number of decimals shown *after* conversion, so a rate
 * with `decimals: 2` prints as `6.50 %`.
 *
 * @typedef {object} Field
 * @property {keyof Params} key
 * @property {string} label
 * @property {FieldKind} kind
 * @property {number} step
 * @property {number} min
 * @property {number} max
 * @property {number} [decimals]
 */

/**
 * @typedef {{ title: string, fields: Field[] }} FieldGroup
 */

/**
 * The parameter table, in the order it is shown.
 *
 * Ordered by how likely someone is to touch it, not by where it lands in the
 * arithmetic: the five numbers that actually decide the answer are first, and the
 * tax constants nobody will change without a reason are last.
 *
 * Defaults are 2026, married filing jointly, Texas -- no state income tax, which
 * is why property tax is the only SALT item worth modelling.
 *
 * @type {FieldGroup[]}
 */
export const GROUPS = [
  {
    title: "property & loan",
    fields: [
      { key: "homeCost", label: "home price", kind: "money", step: 10_000, min: 0, max: 20_000_000 },
      { key: "downPaymentPct", label: "down payment", kind: "rate", step: 0.01, min: 0, max: 1, decimals: 1 },
      { key: "loanRate", label: "loan rate", kind: "rate", step: 0.001, min: 0, max: 0.15, decimals: 2 },
      { key: "loanTermYears", label: "loan term", kind: "years", step: 1, min: 5, max: 40 },
      { key: "horizonYears", label: "holding period", kind: "years", step: 1, min: 1, max: 40 },
    ],
  },
  {
    title: "rent & returns",
    fields: [
      { key: "monthlyRent", label: "monthly rent", kind: "money", step: 100, min: 0, max: 100_000 },
      { key: "stockRoi", label: "stock return", kind: "rate", step: 0.005, min: -0.05, max: 0.2, decimals: 1 },
      { key: "houseRoi", label: "home appreciation", kind: "rate", step: 0.005, min: -0.05, max: 0.2, decimals: 1 },
      { key: "inflation", label: "inflation", kind: "rate", step: 0.005, min: 0, max: 0.15, decimals: 1 },
      { key: "rentInflation", label: "rent inflation", kind: "rate", step: 0.005, min: 0, max: 0.15, decimals: 1 },
    ],
  },
  {
    title: "portfolio",
    fields: [
      { key: "initialPortfolio", label: "starting portfolio", kind: "money", step: 10_000, min: 0, max: 100_000_000 },
      { key: "annualInvestment", label: "added per year", kind: "money", step: 1_000, min: 0, max: 10_000_000 },
    ],
  },
  {
    title: "fees & upkeep",
    fields: [
      { key: "buyingFeePct", label: "buying fee", kind: "rate", step: 0.001, min: 0, max: 0.1, decimals: 1 },
      { key: "sellingFeePct", label: "selling fee", kind: "rate", step: 0.001, min: 0, max: 0.15, decimals: 1 },
      { key: "maintenancePct", label: "maintenance /yr", kind: "rate", step: 0.001, min: 0, max: 0.05, decimals: 1 },
      { key: "insurancePct", label: "insurance /yr", kind: "rate", step: 0.001, min: 0, max: 0.05, decimals: 1 },
      { key: "taxesPct", label: "property tax /yr", kind: "rate", step: 0.001, min: 0, max: 0.05, decimals: 1 },
      { key: "hoaMonthly", label: "HOA /month", kind: "money", step: 10, min: 0, max: 10_000 },
    ],
  },
  {
    title: "taxes",
    fields: [
      { key: "capGainsRate", label: "capital gains", kind: "rate", step: 0.01, min: 0, max: 0.35, decimals: 1 },
      { key: "incomeTaxRate", label: "marginal income", kind: "rate", step: 0.01, min: 0, max: 0.37, decimals: 1 },
      { key: "stdDeduction", label: "std deduction", kind: "money", step: 100, min: 0, max: 200_000 },
      { key: "saltCap", label: "SALT cap", kind: "money", step: 100, min: 0, max: 200_000 },
      { key: "homeGainExclusion", label: "gain exclusion", kind: "money", step: 10_000, min: 0, max: 2_000_000 },
      { key: "mortgageDeductCap", label: "interest cap", kind: "money", step: 10_000, min: 0, max: 5_000_000 },
    ],
  },
];

/** Every field, flattened, in display order. @type {Field[]} */
export const FIELDS = GROUPS.flatMap((g) => g.fields);

/**
 * Starting scenario: a $600k house in Austin against a $600k portfolio, held ten
 * years. Same numbers the Streamlit version opens with.
 * @type {Params}
 */
export const DEFAULTS = Object.freeze({
  homeCost: 600_000,
  downPaymentPct: 0.2,
  loanRate: 0.065,
  loanTermYears: 30,
  horizonYears: 10,

  monthlyRent: 2_500,
  stockRoi: 0.05,
  houseRoi: 0.04,
  inflation: 0.04,
  rentInflation: 0.045,

  initialPortfolio: 600_000,
  annualInvestment: 100_000,

  buyingFeePct: 0.035,
  sellingFeePct: 0.075,
  maintenancePct: 0.02,
  insurancePct: 0.005,
  taxesPct: 0.02,
  hoaMonthly: 300,

  capGainsRate: 0.15,
  incomeTaxRate: 0.32,
  stdDeduction: 32_200,
  saltCap: 40_400,
  homeGainExclusion: 500_000,
  mortgageDeductCap: 750_000,
});

/* ── Arithmetic on values ────────────────────────────────────────────────── */

/**
 * Snap a value to the field's grid and range.
 *
 * The rounding is not cosmetic. 0.065 + 0.005 is 0.07000000000000001 in binary
 * floating point, and a rate that has been nudged twenty times would otherwise
 * print as `7.00 %` while carrying a tail that shows up in the answer.
 *
 * @param {Field} field
 * @param {number} value
 * @returns {number}
 */
export function quantize(field, value) {
  const snapped = field.kind === "years" ? Math.round(value) : Math.round(value / field.step) * field.step;
  // Rates need five decimals to hold a 0.1% step exactly; money needs cents.
  const places = field.kind === "money" ? 2 : 5;
  const rounded = Number(snapped.toFixed(places));
  return clamp(field.min, rounded, field.max);
}

/**
 * Nudge a value one step, or ten with `big`.
 *
 * Ten rather than five or a hundred: at a 0.5%-per-step rate that is a five-point
 * jump, which is the size of a "what if the market does badly" question.
 *
 * @param {Field} field
 * @param {number} value
 * @param {-1 | 1} dir
 * @param {boolean} [big]
 * @returns {number}
 */
export function adjust(field, value, dir, big = false) {
  return quantize(field, value + dir * field.step * (big ? 10 : 1));
}

/**
 * Read a typed value in the units the field is *displayed* in.
 *
 * So `6.5` on a rate means 6.5%, and `650k` on a money field means 650,000 --
 * because that is what someone typing into a field labelled `loan rate  6.50 %`
 * means, and asking them to type 0.065 would be a small act of hostility.
 *
 * @param {Field} field
 * @param {string} text
 * @returns {number | null} null if the text is not a number yet
 */
export function parseTyped(field, text) {
  const cleaned = text.replace(/[$,\s%]/g, "");
  const m = /^(-?\d*\.?\d*)([kKmM]?)$/.exec(cleaned);
  if (m === null) return null;
  const digits = m[1] ?? "";
  if (digits === "" || digits === "-" || digits === "." || digits === "-.") return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;

  const suffix = (m[2] ?? "").toLowerCase();
  const scale = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
  const raw = field.kind === "rate" ? (n * scale) / 100 : n * scale;
  return quantize(field, raw);
}

/* ── Formatting ──────────────────────────────────────────────────────────── */

/**
 * Thousands separators, without Intl.
 *
 * `toLocaleString()` would be shorter and is the obvious choice, but this is a
 * fixed-width grid: a French locale renders 600000 as `600 000` with a
 * non-breaking space, and a German one as `600.000`. Column alignment computed
 * against one and rendered in another is the kind of bug that only ever appears on
 * someone else's machine.
 *
 * @param {number} n
 * @returns {string}
 */
export function groupDigits(n) {
  const neg = n < 0;
  const digits = String(Math.round(Math.abs(n)));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return (neg ? "-" : "") + out;
}

/**
 * `$1,684,213`. Whole dollars: cents in a projection thirty years out would be a
 * claim to precision the model does not have.
 * @param {number} n
 * @returns {string}
 */
export function money(n) {
  const s = groupDigits(n);
  return s.startsWith("-") ? `-$${s.slice(1)}` : `$${s}`;
}

/**
 * `$1.68M`, `$684k`, `$0` -- for axis labels, where six digits do not fit.
 * @param {number} n
 * @returns {string}
 */
export function compactMoney(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * A field's value as shown in its row.
 * @param {Field} field
 * @param {number} value
 * @returns {string}
 */
export function formatValue(field, value) {
  switch (field.kind) {
    case "money":
      return money(value);
    case "rate":
      return `${(value * 100).toFixed(field.decimals ?? 1)}%`;
    case "years":
      return `${Math.round(value)} yr`;
  }
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

const STORE_KEY = "rent";

/**
 * @returns {Params} a fresh mutable copy of the defaults
 */
export function defaultParams() {
  return { ...DEFAULTS };
}

/**
 * Restore the last scenario, falling back to the defaults for anything missing,
 * unknown, or not a finite number.
 *
 * Field-by-field rather than wholesale, so a stored blob written by an older
 * version -- or hand-edited in devtools -- degrades to the default for that one
 * knob instead of throwing the whole scenario away.
 *
 * @returns {Params}
 */
export function loadParams() {
  const params = defaultParams();
  const raw = load(STORE_KEY);
  if (raw === null) return params;

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return params;
  }
  if (typeof parsed !== "object" || parsed === null) return params;

  const stored = /** @type {Record<string, unknown>} */ (parsed);
  for (const field of FIELDS) {
    const v = stored[field.key];
    if (typeof v === "number" && Number.isFinite(v)) params[field.key] = quantize(field, v);
  }
  return params;
}

/** @param {Params} params */
export function saveParams(params) {
  save(STORE_KEY, JSON.stringify(params));
}
