// @ts-check
/**
 * `rent`: the rent-vs-buy model as a keyboard-driven panel.
 *
 * The Streamlit original is twenty-odd sliders in a sidebar, and the reason it
 * works is that you can sweep one and watch the answer move. That is the feature
 * worth keeping, so this is not a report -- it is a panel that redraws on every
 * keystroke, with the arrow keys standing in for the sliders.
 *
 * Two things it does differently:
 *
 *   - The gap is reported in **today's dollars**. See model.js: the nominal figure
 *     overstates it by the whole inflation factor over the holding period, which is
 *     exactly the number a visitor is here to read.
 *   - There is no "show me everything" mode. Twenty-four knobs do not fit on a
 *     phone, so they scroll, and the five that decide the answer are first.
 */

import { c, sp, blank } from "../render/chunk.js";
import { box, rule, wrapChunks, indent, sideBySide } from "../render/layout.js";
import { plot, legend } from "../render/plot.js";
import { simulate } from "./model.js";
import {
  GROUPS,
  FIELDS,
  adjust,
  compactMoney,
  defaultParams,
  formatValue,
  loadParams,
  money,
  parseTyped,
  saveParams,
} from "./fields.js";

/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('../render/chunk.js').TokenClass} TokenClass */
/** @typedef {import('../terminal/keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../terminal/widget-mode.js').Widget} Widget */
/** @typedef {import('../terminal/widget-mode.js').WidgetAction} WidgetAction */
/** @typedef {import('./fields.js').Field} Field */
/** @typedef {import('./model.js').Params} Params */
/** @typedef {import('./model.js').Result} Result */

/** A knob row, or the group heading above it. Headings are not selectable. */
/** @typedef {{kind: 'head', title: string} | {kind: 'field', field: Field}} Item */

/** Below this the chart is a smear of asterisks and the space is better spent. */
const MIN_CHART_COLS = 40;
/** Above this there is room for the knobs and the chart side by side. */
const WIDE_COLS = 74;

/** Colour and glyph are both carried per series -- colour alone is not a key. */
const BUY = /** @type {const} */ ({ glyph: "#", cls: "success" });
const RENT = /** @type {const} */ ({ glyph: "o", cls: "accent" });

/** @type {Item[]} */
const ITEMS = GROUPS.flatMap((g) => [
  /** @type {Item} */ ({ kind: "head", title: g.title }),
  ...g.fields.map((field) => /** @type {Item} */ ({ kind: "field", field })),
]);

/** @implements {Widget} */
export class RentWidget {
  id = "rent";
  label = "rent vs buy — hannigan.sh";

  /** @type {Params} */ #params;
  /** Index into ITEMS; always lands on a field, never a heading. */
  /** @type {number} */ #sel;
  /** First visible item, i.e. the scroll offset of the knob pane. */
  /** @type {number} */ #top = 0;
  /** Digits typed so far, or null when not editing a value. */
  /** @type {string | null} */ #typed = null;
  /** @type {'chart'|'table'} */ #view = "chart";

  constructor() {
    // Picks up the scenario from a previous visit: someone who spent two minutes
    // dialling in their actual rent should not have to do it again.
    this.#params = loadParams();
    this.#sel = ITEMS.findIndex((it) => it.kind === "field");
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */

  /**
   * @param {number} cols
   * @returns {Line[]}
   */
  render(cols) {
    const sim = simulate(this.#params);
    const head = titleRule("rent vs buy", "today's $", cols);

    if (cols >= WIDE_COLS) {
      // 42% to the knobs, floored at 30 columns so a long label plus `$1,684,213`
      // still fits, and capped at 38 so the chart keeps the better half.
      const leftW = Math.min(38, Math.max(30, Math.floor(cols * 0.42)));
      const rightW = cols - leftW - 2;
      const left = this.#knobPane(leftW, 14);
      const right = [...this.#dataPane(sim, rightW, 10), blank, ...resultLines(sim, rightW)];
      return [head, blank, ...sideBySide(left, right, leftW, 2), blank];
    }

    // Stacked, and the knob pane is capped rather than stretched: a label at column
    // 0 with its value flush against column 60 is two separate things to read, and
    // the eye has to travel to pair them up.
    return [
      head,
      blank,
      ...this.#knobPane(Math.min(cols, 44), 8),
      blank,
      ...resultLines(sim, cols),
      blank,
      ...this.#dataPane(sim, cols, 7),
      blank,
    ];
  }

  /**
   * The frame left behind in scrollback.
   *
   * No selection marker, no scrolling knob pane, no key hints: those describe an
   * interaction that has ended. What stays is the answer and the scenario it came
   * from, which is what makes the transcript worth reading later.
   *
   * @param {number} cols
   * @returns {Line[]}
   */
  summary(cols) {
    const sim = simulate(this.#params);
    return [
      titleRule("rent vs buy", "today's $", cols),
      blank,
      ...scenarioLines(this.#params, cols),
      blank,
      ...this.#dataPane(sim, cols, cols >= WIDE_COLS ? 10 : 7),
      blank,
      ...resultLines(sim, cols),
      blank,
    ];
  }

  /**
   * The status bar, rendered as the mode's prompt.
   *
   * `rent` in the repl hue for the same reason `ask>` is: the colour is what tells
   * you which keys are live and what Ctrl+C will do.
   *
   * @param {number} cols
   * @returns {Line}
   */
  status(cols) {
    if (this.#typed !== null) {
      const field = this.#field();
      const unit = field.kind === "rate" ? " %" : field.kind === "years" ? " yr" : "";
      return [
        c("rent", "prompt-repl"),
        c("  ", "dim"),
        c(`${field.label} = `, "bright"),
        c(this.#typed === "" ? "_" : `${this.#typed}_`, "accent"),
        c(unit, "dim"),
        c(cols < 56 ? "" : "   enter to set, esc to cancel", "dim"),
      ];
    }
    const keys =
      cols < 56
        ? "  up/down pick, left/right adjust, q quit"
        : `  up/down pick   left/right adjust (shift x10)   0-9 set   v ${
            this.#view === "chart" ? "table" : "chart"
          }   r reset   q quit`;
    return [c("rent", "prompt-repl"), c(keys, "dim")];
  }

  /**
   * The knob list: one scrolling window over group headings and fields.
   *
   * @param {number} width
   * @param {number} rows how many item rows to show
   * @returns {Line[]}
   */
  #knobPane(width, rows) {
    this.#scrollInto(rows);
    /** @type {Line[]} */
    const out = [];

    for (let i = this.#top; i < Math.min(ITEMS.length, this.#top + rows); i++) {
      const item = ITEMS[i];
      if (item === undefined) continue;
      if (item.kind === "head") {
        out.push([c(item.title.toUpperCase(), "subheading")]);
        continue;
      }
      const selected = i === this.#sel;
      out.push(
        knobRow(item.field, this.#params[item.field.key], width, {
          selected,
          typed: selected ? this.#typed : null,
        }),
      );
    }

    if (ITEMS.length > rows) {
      const n = FIELDS.indexOf(this.#field()) + 1;
      const more = this.#top + rows < ITEMS.length ? " v" : "";
      const less = this.#top > 0 ? "^" : "";
      out.push([sp(2), c(`knob ${n}/${FIELDS.length}  ${less}${more}`.trimEnd(), "dim")]);
    }
    return out;
  }

  /**
   * Whichever of the chart and the table is showing.
   * @param {Result} sim
   * @param {number} width
   * @param {number} height plot rows, when it is the chart
   * @returns {Line[]}
   */
  #dataPane(sim, width, height) {
    if (this.#view === "table") return tableLines(sim, width);
    return chartLines(sim, width, height);
  }

  /* ── Input ─────────────────────────────────────────────────────────────── */

  /**
   * @param {KeyEvent} ev
   * @returns {WidgetAction}
   */
  onKey(ev) {
    if (this.#typed !== null) return this.#editKey(ev);

    switch (ev.action) {
      case "up":
        return this.#move(-1);
      case "down":
        return this.#move(1);
      case "tab":
        return this.#move(1);
      case "tab-back":
        return this.#move(-1);
      // Shift multiplies the step by ten, which is how you ask "what if rates were
      // a whole point higher" without holding an arrow key down.
      case "left":
        return this.#nudge(-1, ev.shift);
      case "right":
        return this.#nudge(1, ev.shift);
      case "home":
        return this.#select(ITEMS.findIndex((it) => it.kind === "field"));
      case "end":
        return this.#select(lastFieldIndex());
      case "enter":
        this.#typed = "";
        return "repaint";
      // Both leave, and neither is a surprise: Ctrl+C because nothing here is
      // running, Ctrl+D because the widget is the session.
      case "interrupt":
      case "eof":
        return "exit";
      default:
        return ev.key === "Escape" ? "exit" : "none";
    }
  }

  /**
   * @param {string} text
   * @returns {WidgetAction}
   */
  onText(text) {
    if (this.#typed !== null) {
      // A minus sign is only meaningful as the first character (stock return can be
      // negative); everywhere else it is a stray keystroke.
      const filtered = [...text]
        .filter((ch) => /[0-9.,kKmM]/.test(ch) || (ch === "-" && this.#typed === ""))
        .join("");
      if (filtered === "") return "none";
      this.#typed += filtered;
      return "repaint";
    }

    const ch = text[0];
    if (ch === undefined) return "none";

    switch (ch) {
      case "q":
      case "Q":
        return "exit";
      case "r":
      case "R":
        this.#params = defaultParams();
        this.#persist();
        return "repaint";
      case "v":
      case "V":
        this.#view = this.#view === "chart" ? "table" : "chart";
        return "repaint";
      // hjkl, because the audience for a terminal resume site is the audience that
      // will try it. j/k walk the list, h/l adjust -- the same axes as the arrows.
      case "j":
        return this.#move(1);
      case "k":
        return this.#move(-1);
      case "h":
        return this.#nudge(-1);
      case "l":
        return this.#nudge(1);
      case "g":
        return this.#select(ITEMS.findIndex((it) => it.kind === "field"));
      case "G":
        return this.#select(lastFieldIndex());
      // Reachable on a phone, where the soft-key bar has no left or right arrow.
      case "+":
      case "=":
        return this.#nudge(1);
      case "-":
      case "_":
        return this.#nudge(-1);
      default:
        // A digit starts typing a value, as it would in any spreadsheet.
        if (/[0-9.]/.test(ch)) {
          this.#typed = ch;
          return "repaint";
        }
        return "none";
    }
  }

  /** Called by the host when the widget is torn down, however that happened. */
  onClose() {
    this.#persist();
  }

  /**
   * @param {KeyEvent} ev
   * @returns {WidgetAction}
   */
  #editKey(ev) {
    switch (ev.action) {
      case "enter": {
        const field = this.#field();
        const value = parseTyped(field, this.#typed ?? "");
        // An unparseable entry is simply not applied. There is nowhere sensible to
        // put an error message in a panel this size, and the old value is still
        // visible the moment the edit closes -- which says "that did nothing"
        // clearly enough.
        if (value !== null) {
          this.#params[field.key] = value;
          this.#persist();
        }
        this.#typed = null;
        return "repaint";
      }
      case "backspace":
        // Backspacing past the start cancels, which is what an empty field means.
        this.#typed = this.#typed === "" ? null : (this.#typed ?? "").slice(0, -1);
        return "repaint";
      // Ctrl+C abandons the edit and stays in the widget, mirroring how it abandons
      // a line but not the session at a shell prompt.
      case "interrupt":
      case "eof":
        this.#typed = null;
        return "repaint";
      default:
        if (ev.key === "Escape") {
          this.#typed = null;
          return "repaint";
        }
        return "none";
    }
  }

  /* ── State ─────────────────────────────────────────────────────────────── */

  /** @returns {Field} */
  #field() {
    const item = ITEMS[this.#sel];
    if (item === undefined || item.kind !== "field") {
      // Only reachable if the item list and the selection ever disagree, which would
      // be a bug here rather than bad input -- so fail loudly in development terms
      // by falling back to the first field rather than rendering something wrong.
      const first = FIELDS[0];
      if (first === undefined) throw new Error("no fields");
      return first;
    }
    return item.field;
  }

  /**
   * Move the selection by `dir` fields, skipping headings. Clamps rather than
   * wrapping: a list this long is easier to keep your place in when the ends stop.
   * @param {-1|1} dir
   * @returns {WidgetAction}
   */
  #move(dir) {
    for (let i = this.#sel + dir; i >= 0 && i < ITEMS.length; i += dir) {
      if (ITEMS[i]?.kind === "field") return this.#select(i);
    }
    return "none";
  }

  /**
   * @param {number} index
   * @returns {WidgetAction}
   */
  #select(index) {
    if (index < 0 || index === this.#sel) return "none";
    this.#sel = index;
    return "repaint";
  }

  /**
   * @param {-1|1} dir
   * @param {boolean} [big]
   * @returns {WidgetAction}
   */
  #nudge(dir, big = false) {
    const field = this.#field();
    const next = adjust(field, this.#params[field.key], dir, big);
    if (next === this.#params[field.key]) return "none"; // already at the limit
    this.#params[field.key] = next;
    return "repaint";
  }

  /**
   * Keep the selected row inside the visible window.
   * @param {number} rows
   */
  #scrollInto(rows) {
    // The heading above the selected field is worth keeping visible, so scrolling
    // up stops one row early rather than parking the selection at the top edge.
    if (this.#sel <= this.#top) this.#top = Math.max(0, this.#sel - 1);
    if (this.#sel >= this.#top + rows) this.#top = this.#sel - rows + 1;
    // Never leave a gap at the bottom when there is more list above.
    this.#top = Math.max(0, Math.min(this.#top, ITEMS.length - rows));
  }

  #persist() {
    saveParams(this.#params);
  }
}

/** @returns {number} */
function lastFieldIndex() {
  for (let i = ITEMS.length - 1; i >= 0; i--) {
    if (ITEMS[i]?.kind === "field") return i;
  }
  return 0;
}

/* ── Pure renderers ───────────────────────────────────────────────────────
 * Everything below is (data, width) => Line[], so the `--report` path can reuse it
 * without a widget, a mode, or a keyboard. */

/**
 * `── rent vs buy ─────────────── today's $ ──`
 *
 * @param {string} title
 * @param {string} right
 * @param {number} width
 * @returns {Line}
 */
export function titleRule(title, right, width) {
  const g = box();
  if (width < title.length + 8) return [c(title, "heading")];

  const suffix = width >= title.length + right.length + 12 ? right : "";
  const fixed = 2 + 1 + title.length + 1 + (suffix === "" ? 0 : suffix.length + 2) + 2;
  const fill = Math.max(0, width - fixed);

  /** @type {Line} */
  const line = [
    c(g.h.repeat(2), "rule"),
    sp(1),
    c(title, "heading"),
    sp(1),
    c(g.h.repeat(fill), "rule"),
  ];
  if (suffix !== "") line.push(sp(1), c(suffix, "dim"), sp(1));
  line.push(c(g.h.repeat(2), "rule"));
  return line;
}

/**
 * One knob row: `> home price          $600,000`.
 *
 * @param {Field} field
 * @param {number} value
 * @param {number} width
 * @param {{selected: boolean, typed: string | null}} state
 * @returns {Line}
 */
function knobRow(field, value, width, { selected, typed }) {
  // `>` and not `▸`: see layout.js. A double-width marker would push every value in
  // the column one cell right, on some fonts only.
  const marker = selected ? ">" : " ";
  const shown = typed === null ? formatValue(field, value) : `${typed}_`;
  const room = Math.max(1, width - 2 - shown.length - 1);
  const label = field.label.length > room ? field.label.slice(0, room) : field.label;
  const pad = Math.max(1, width - 2 - label.length - shown.length);

  /** @type {TokenClass} */
  const labelCls = selected ? "bright" : "text";
  /** @type {TokenClass} */
  const valueCls = typed !== null ? "warn" : selected ? "accent" : "bright";

  return [
    c(marker, "accent"),
    sp(1),
    c(label, labelCls),
    sp(pad),
    c(shown, valueCls),
  ];
}

/**
 * The chart: both series in today's dollars, by exit year.
 *
 * Real rather than nominal for the same reason the verdict is: a nominal curve
 * climbs even when you are standing still, which makes both lines look like wins.
 *
 * @param {Result} sim
 * @param {number} width
 * @param {number} height
 * @returns {Line[]}
 */
export function chartLines(sim, width, height) {
  if (width < MIN_CHART_COLS) {
    return indent(
      wrapChunks([c("(too narrow for the chart — rotate, or widen the window)", "dim")], width - 2),
      2,
    );
  }

  const years = sim.rows.map((r) => r.year);
  const last = years[years.length - 1] ?? 1;
  const mid = years[Math.floor((years.length - 1) / 2)] ?? 1;

  const body = plot(
    [
      { label: "buy", glyph: BUY.glyph, cls: BUY.cls, points: sim.rows.map((r) => r.buyReal) },
      { label: "rent", glyph: RENT.glyph, cls: RENT.cls, points: sim.rows.map((r) => r.rentReal) },
    ],
    {
      width,
      height,
      format: compactMoney,
      xTicks: ["yr 1", `yr ${mid}`, `yr ${last}`],
    },
  );

  return [
    [c("net worth by exit year", "subheading")],
    ...body,
    [
      ...legend([
        { label: "buy", glyph: BUY.glyph, cls: BUY.cls, points: [] },
        { label: "rent", glyph: RENT.glyph, cls: RENT.cls, points: [] },
      ]),
    ],
  ];
}

/**
 * The same series as a table, for anyone who wants the numbers.
 *
 * Long horizons are thinned to every other year rather than truncated, and the
 * final year is always shown -- it is the one row that answers the question.
 *
 * @param {Result} sim
 * @param {number} width
 * @returns {Line[]}
 */
export function tableLines(sim, width) {
  // 12 columns is not negotiable: `-$1,124,819` is eleven characters and two
  // adjacent figures that touch are unreadable. So the number of columns bends to
  // the width instead of their width bending, and below two columns there is no
  // table worth drawing.
  const colW = 12;
  const yearW = 5;
  if (width < yearW + colW * 2) {
    return indent(wrapChunks([c("(too narrow for the table — press v for the chart)", "dim")], width - 2), 2);
  }
  const showDelta = width >= yearW + colW * 3;
  const step = sim.rows.length > 20 ? 2 : 1;

  /** @param {string} s @param {TokenClass} [cls] */
  const cell = (s, cls) => c(s.padStart(colW), cls);

  /** @type {Line[]} */
  const out = [
    [
      c("year".padStart(yearW), "dim"),
      cell("buy", "dim"),
      cell("rent", "dim"),
      ...(showDelta ? [cell("delta", "dim")] : []),
    ],
  ];

  for (let i = 0; i < sim.rows.length; i++) {
    const r = sim.rows[i];
    if (r === undefined) continue;
    if (i % step !== 0 && i !== sim.rows.length - 1) continue;
    const delta = r.buyReal - r.rentReal;
    out.push([
      c(String(r.year).padStart(yearW)),
      cell(money(r.buyReal), BUY.cls),
      cell(money(r.rentReal), RENT.cls),
      ...(showDelta ? [cell(money(delta), delta >= 0 ? BUY.cls : RENT.cls)] : []),
    ]);
  }

  if (step > 1) out.push([sp(2), c("(every other year)", "dim")]);
  return out;
}

/**
 * The verdict.
 *
 * The gap is stated in today's dollars and the nominal figure is shown next to it,
 * dimmed. Both, rather than one: the real number is the honest one, and quietly
 * replacing a figure someone may have seen elsewhere -- in the Streamlit version,
 * say -- without saying so would just look like a different bug.
 *
 * @param {Result} sim
 * @param {number} width
 * @returns {Line[]}
 */
export function resultLines(sim, width) {
  const final = sim.rows[sim.rows.length - 1];
  if (final === undefined) return [];

  const horizon = final.year;
  const buyAhead = final.buyReal >= final.rentReal;
  const gap = Math.abs(final.buyReal - final.rentReal);
  const nominalGap = Math.abs(final.buy - final.rent);
  const keyW = 11;

  // Wrapped rather than laid out flat: at 20 columns -- the narrowest the terminal
  // goes -- `crossover  none within 10 yr` is wider than the screen, and a row that
  // soft-wraps in the browser breaks mid-figure instead of between the label and
  // the value. At any normal width these are one line each and nothing changes.
  /** @param {string} key @param {string} value @param {TokenClass} [cls] */
  const row = (key, value, cls) =>
    wrapChunks([c(key.padEnd(keyW), "dim"), c(value, cls ?? "bright")], width);

  /** @type {Line[]} */
  const out = [
    ...row(`buy yr ${horizon}`, money(final.buyReal), BUY.cls),
    ...row(`rent yr ${horizon}`, money(final.rentReal), RENT.cls),
    rule(Math.min(width, keyW + 12)),
    ...wrapChunks(
      [
        c(buyAhead ? "buying" : "renting", buyAhead ? BUY.cls : RENT.cls),
        c(" ahead by "),
        c(money(gap), "bright"),
      ],
      width,
    ),
    ...wrapChunks([c(`in today's dollars — ${money(nominalGap)} nominal`, "dim")], width),
    ...row(
      "crossover",
      sim.crossover === null ? `none within ${horizon} yr` : `year ${sim.crossover}`,
      sim.crossover === null ? "text" : "bright",
    ),
    ...row("mortgage", `${money(sim.monthlyPayment)}/mo`),
  ];
  return out;
}

/**
 * The scenario in one or two lines: what the answer above was computed from.
 * @param {Params} p
 * @param {number} width
 * @returns {Line[]}
 */
export function scenarioLines(p, width) {
  return wrapChunks(
    [
      c(`${money(p.homeCost)} home`, "bright"),
      c(` at ${(p.loanRate * 100).toFixed(2)}% with ${(p.downPaymentPct * 100).toFixed(0)}% down`, "dim"),
      c(`, vs ${money(p.monthlyRent)}/mo rent`, "dim"),
      c(`, held ${Math.round(p.horizonYears)} yr`, "dim"),
      c(
        `, ${(p.stockRoi * 100).toFixed(1)}% stocks / ${(p.houseRoi * 100).toFixed(1)}% homes / ` +
          `${(p.inflation * 100).toFixed(1)}% inflation`,
        "dim",
      ),
    ],
    width,
  );
}

/**
 * The whole thing as static rows, for `rent --report`.
 *
 * Not a lesser version for the sake of having one: the widget's frames never reach
 * the screen-reader announcer (they are painted straight into the output region,
 * which is aria-hidden), and a panel driven by arrow keys is not much use to
 * someone who cannot see it. This path is the same model, announced properly.
 *
 * @param {Params} params
 * @param {number} width
 * @returns {Line[]}
 */
export function reportLines(params, width) {
  const sim = simulate(params);
  return [
    titleRule("rent vs buy", "today's $", width),
    blank,
    ...scenarioLines(params, width),
    blank,
    ...resultLines(sim, width),
    blank,
    ...tableLines(sim, width),
    blank,
    ...knobLines(params, width),
    blank,
  ];
}

/**
 * Every knob and its value, in two columns if there is room. Only the report needs
 * this -- the widget shows a scrolling window instead.
 * @param {Params} params
 * @param {number} width
 * @returns {Line[]}
 */
function knobLines(params, width) {
  /** @type {Line[]} */
  const flat = [];
  /** Row indices the second column is allowed to start at. */
  /** @type {number[]} */
  const breaks = [];
  for (const group of GROUPS) {
    breaks.push(flat.length);
    flat.push([c(group.title.toUpperCase(), "subheading")]);
    for (const field of group.fields) {
      flat.push([
        sp(2),
        c(field.label.padEnd(20), "text"),
        c(formatValue(field, params[field.key]), "bright"),
      ]);
    }
    flat.push(blank);
  }

  // Two columns above 76 cols: 24 knobs plus headings is thirty-odd rows, which is
  // most of a screen for reference material.
  if (width < 76) return flat;
  // Split at a group boundary rather than at the exact midpoint, so the second
  // column starts with a heading instead of orphaning three knobs from theirs.
  const half = flat.length / 2;
  const split = breaks.reduce((best, at) => (Math.abs(at - half) < Math.abs(best - half) ? at : best), 0);
  const colW = Math.floor(width / 2) - 2;
  return sideBySide(flat.slice(0, split), flat.slice(split), colW, 2);
}
