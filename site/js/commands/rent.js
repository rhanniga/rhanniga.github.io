// @ts-check
/**
 * `rent` -- the rent-vs-buy calculator, as a terminal panel.
 *
 * The command is thin on purpose: it validates its flags, then either prints a
 * static report or hands a RentWidget to the generic widget host and returns. The
 * panel outlives the command, exactly as the `ask -i` sub-REPL does, which is why
 * the mode stack removes a finished command's running mode by reference.
 */

import { c, blank } from "../render/chunk.js";
import { WidgetMode } from "../terminal/widget-mode.js";
import { RentWidget, reportLines } from "../rent/widget.js";
import { loadParams } from "../rent/fields.js";
import { parseFlags, invalidOptionMessage } from "../shell/flags.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */

const USAGE = "rent [--report]";

/** @type {Command} */
export const rentCmd = {
  name: "rent",
  group: "tools",
  summary: "rent vs buy, as a panel you can drive",
  usage: USAGE,
  synopsis: [
    "Opens a live rent-vs-buy model. Both columns are the same thing: after-tax,",
    "after-transaction-cost net worth if you sold and walked away at the end of the",
    "holding period. The crossover year is the break-even hold.",
    "",
    "  up / down      pick a knob        j / k also work",
    "  left / right   adjust it          shift for ten steps; h / l, + / - also work",
    "  0-9            type a value       enter to set, esc to cancel",
    "  v              chart or table",
    "  r              back to defaults",
    "  q, Ctrl+C      leave; the last frame stays in the transcript",
    "",
    "Values are typed in the units shown: 6.5 on a rate means 6.5%, and 650k on a",
    "dollar figure means 650,000. Your scenario is remembered in this browser.",
    "",
    "The gap is reported in today's dollars, not in the dollars of the year you",
    "sell. At 4% inflation over ten years those differ by about a third, and the",
    "nominal figure is shown dimmed beside it so both are visible.",
    "",
    "What is not modelled: PMI below 20% down, rent-vs-own differences in space or",
    "commute, moving costs, a variable-rate loan, or any state income tax. The",
    "defaults are 2026, married filing jointly, Texas.",
    "",
    "--report prints the whole thing as static text instead -- the same model,",
    "readable by a screen reader, and greppable.",
  ],
  run: (ctx) => {
    const parsed = parseFlags(ctx.argv, { bools: { report: ["report"] } });
    if (!parsed.ok) {
      ctx.err(invalidOptionMessage("rent", parsed.badFlag));
      ctx.out([c(`usage: ${USAGE}`, "dim")]);
      return EXIT.USAGE;
    }
    if (parsed.operands.length > 0) {
      ctx.err(`rent: unexpected argument \`${parsed.operands[0] ?? ""}'`);
      ctx.out([c(`usage: ${USAGE}`, "dim")]);
      return EXIT.USAGE;
    }

    if (parsed.flags["report"] === true) {
      ctx.rows(reportLines(loadParams(), ctx.cols));
      return EXIT.OK;
    }

    // Before the mode is pushed, so it lands above the panel: opening the block
    // flushes whatever is pending, and anything written afterwards would appear
    // below the widget rather than between it and the echoed command line.
    ctx.out(blank);
    ctx.term.pushMode(new WidgetMode(new RentWidget()));
    return EXIT.OK;
  },
};
