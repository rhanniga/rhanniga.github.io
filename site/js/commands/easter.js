// @ts-check
/**
 * Hidden commands: discoverable by trying them, absent from `help`.
 *
 * The bar for inclusion is that someone would plausibly type it into a terminal
 * unprompted, and getting a real answer is better than `command not found`.
 */

import { c } from "../render/chunk.js";
import { USER } from "../terminal/prompt.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */

/**
 * bash's actual sudoers message, which is funnier verbatim than embellished.
 * @type {Command}
 */
export const sudoCmd = {
  name: "sudo",
  group: "misc",
  summary: "elevate privileges",
  hidden: true,
  run: (ctx) => {
    if (ctx.argv.length === 1) {
      ctx.err("usage: sudo command");
      return EXIT.USAGE;
    }
    ctx.err(`${USER} is not in the sudoers file.  This incident will be reported.`);
    return EXIT.ERROR;
  },
};

/**
 * There is no filesystem to change into, so say so the way a shell would. `~`,
 * `.` and the home directory succeed silently, because they are already where you
 * are and failing on them would be wrong.
 * @type {Command}
 */
export const cdCmd = {
  name: "cd",
  group: "misc",
  summary: "change directory",
  hidden: true,
  run: (ctx) => {
    const target = ctx.argv[1];
    if (target === undefined || target === "~" || target === "." || target === `/home/${USER}`) {
      return EXIT.OK;
    }
    ctx.err(`bash: cd: ${target}: No such file or directory`);
    return EXIT.ERROR;
  },
};

/**
 * Reprints the banner. Real, and it gives the boot sequence somewhere to live
 * once M5 lands.
 * @type {Command}
 */
export const motdCmd = {
  name: "motd",
  group: "misc",
  summary: "reprint the login banner",
  hidden: true,
  aliases: ["banner"],
  run: (ctx) => {
    ctx.motd();
    return EXIT.OK;
  },
};

/** @type {Command} */
export const whichCmd = {
  name: "which",
  group: "misc",
  summary: "locate a command",
  hidden: true,
  run: (ctx) => {
    const name = ctx.argv[1];
    if (name === undefined) {
      ctx.err("usage: which command");
      return EXIT.USAGE;
    }
    const cmd = ctx.registry.get(name);
    if (cmd === undefined) {
      // `which` is silent on failure and just sets a status, like the real thing.
      return EXIT.ERROR;
    }
    ctx.out([c(`/usr/local/bin/${name}`, "dim")]);
    return EXIT.OK;
  },
};

export const easterCommands = [sudoCmd, cdCmd, motdCmd, whichCmd];
