// @ts-check
/**
 * `help`, and `help <command>`.
 */

import { c, sp, blank } from "../render/chunk.js";
import { wrapChunks, indent, heading } from "../render/layout.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */
/** @typedef {import('../shell/registry.js').CommandContext} CommandContext */

/** Group display order and labels. */
const GROUPS = /** @type {const} */ ([
  ["resume", "the resume"],
  ["ai", "ask me things"],
  ["tools", "tools"],
  ["shell", "shell"],
  ["misc", "appearance"],
]);

/**
 * @param {CommandContext} ctx
 * @param {Command} cmd
 * @returns {number}
 */
function helpForCommand(ctx, cmd) {
  ctx.out([c(cmd.name, "bright"), c(" — "), c(cmd.summary)]);
  ctx.out(blank);
  ctx.out([sp(2), c("usage: ", "dim"), c(cmd.usage ?? cmd.name)]);
  if (cmd.aliases !== undefined && cmd.aliases.length > 0) {
    ctx.out([sp(2), c("alias: ", "dim"), c(cmd.aliases.join(", "))]);
  }
  if (cmd.synopsis !== undefined && cmd.synopsis.length > 0) {
    ctx.out(blank);
    for (const line of cmd.synopsis) {
      if (line === "") {
        ctx.out(blank);
      } else {
        ctx.rows(indent(wrapChunks([c(line)], ctx.cols - 2), 2));
      }
    }
  }
  ctx.out(blank);
  return EXIT.OK;
}

/** @type {Command} */
export const helpCmd = {
  name: "help",
  group: "shell",
  summary: "list commands, or explain one",
  usage: "help [command]",
  aliases: ["man"],
  complete: (argv, index) => (index === 1 ? [] : []),
  run: (ctx) => {
    const which = ctx.argv[1];

    if (which !== undefined) {
      const cmd = ctx.registry.get(which);
      if (cmd === undefined) {
        ctx.err(`help: no help topics match \`${which}'`);
        return EXIT.ERROR;
      }
      return helpForCommand(ctx, cmd);
    }

    // Width of the widest visible name, so the summaries line up in one column.
    const width = ctx.registry
      .completions()
      .reduce((m, n) => Math.max(m, n.length), 0);

    for (const [group, label] of GROUPS) {
      const cmds = ctx.registry.byGroup(group);
      if (cmds.length === 0) continue;
      ctx.rows(heading(label, ctx.cols));
      ctx.out(blank);
      for (const cmd of cmds) {
        ctx.out([sp(2), c(cmd.name.padEnd(width), "bright"), sp(2), c(cmd.summary, "dim")]);
      }
      ctx.out(blank);
    }

    ctx.rows(heading("keys", ctx.cols));
    ctx.out(blank);
    /** @type {Array<[string, string]>} */
    const keys = [
      ["Tab", "complete a command name"],
      ["Up / Down", "walk history"],
      ["Ctrl+A / Ctrl+E", "start / end of line"],
      ["Ctrl+U / Ctrl+K", "kill to start / end"],
      ["Alt+Backspace", "kill the previous word"],
      ["Ctrl+Y", "yank what was killed"],
      ["Ctrl+L", "clear the screen"],
      ["Ctrl+C", "abort — or copy, if text is selected"],
      ["Ctrl+D", "end the session"],
    ];
    const keyWidth = keys.reduce((m, [k]) => Math.max(m, k.length), 0);
    for (const [key, what] of keys) {
      ctx.out([sp(2), c(key.padEnd(keyWidth), "bright"), sp(2), c(what, "dim")]);
    }
    ctx.out(blank);

    // Honest about a limitation rather than letting people think it is broken.
    ctx.rows(
      indent(
        wrapChunks(
          [
            c("Ctrl+W", "bright"),
            c(
              " would normally kill a word, but Chrome and Firefox both close the" +
                " tab on it and do not let a page intercept it. Alt+Backspace does" +
                " the same job.",
              "dim",
            ),
          ],
          ctx.cols - 2,
        ),
        2,
      ),
    );
    ctx.out(blank);
    ctx.rows(
      indent(
        wrapChunks(
          [c("Pasted newlines become spaces, so a pasted block never runs itself.", "dim")],
          ctx.cols - 2,
        ),
        2,
      ),
    );
    ctx.out(blank);
    return EXIT.OK;
  },
};
