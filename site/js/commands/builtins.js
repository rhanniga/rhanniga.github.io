// @ts-check
/**
 * The commands a visitor types to find out whether the terminal is real.
 *
 * `whoami`, `pwd`, `date`, `echo`, `clear` are the first five things people try.
 * If they fail, the illusion dies in about ten seconds -- which is why they are in
 * the MVP rather than filed as polish.
 */

import { c, sp, blank } from "../render/chunk.js";
import { USER, identity } from "../terminal/prompt.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */

/** @type {Command} */
export const whoamiCmd = {
  name: "whoami",
  group: "shell",
  summary: "print the current user",
  run: (ctx) => {
    ctx.out([c(USER)]);
    // If the IP resolved, mention it -- `whoami` reporting something different
    // from the prompt would look like a bug.
    const id = identity();
    if (id !== USER) {
      ctx.out([c(`(the prompt shows ${id}, your public IP)`, "dim")]);
    }
    return EXIT.OK;
  },
};

/** @type {Command} */
export const pwdCmd = {
  name: "pwd",
  group: "shell",
  summary: "print the working directory",
  run: (ctx) => {
    ctx.out([c(`/home/${USER}`)]);
    return EXIT.OK;
  },
};

/** @type {Command} */
export const dateCmd = {
  name: "date",
  group: "shell",
  summary: "print the current date and time",
  run: (ctx) => {
    // Deliberately the visitor's own clock and timezone, formatted the way
    // date(1) does.
    const d = new Date();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
    const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(d)
      .find((part) => part.type === "timeZoneName")?.value ?? "";
    ctx.out([
      c(
        `${days[d.getDay()]} ${months[d.getMonth()]} ${p2(d.getDate())} ` +
          `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${tz} ${d.getFullYear()}`,
      ),
    ]);
    return EXIT.OK;
  },
};

/** @type {Command} */
export const echoCmd = {
  name: "echo",
  group: "shell",
  summary: "print arguments",
  usage: "echo [text ...]",
  synopsis: [
    "Prints its arguments separated by single spaces.",
    "",
    "The tokenizer expands $? to the previous command's exit status, so",
    "`echo $?` works. Nothing else expands: no $VAR, no ~, no globbing.",
  ],
  run: (ctx) => {
    ctx.out([c(ctx.argv.slice(1).join(" "))]);
    return EXIT.OK;
  },
};

/** @type {Command} */
export const clearCmd = {
  name: "clear",
  group: "shell",
  summary: "clear the screen",
  run: (ctx) => {
    ctx.term.clear();
    return EXIT.OK;
  },
};

/** @type {Command} */
export const historyCmd = {
  name: "history",
  group: "shell",
  summary: "show command history",
  usage: "history [-c]",
  synopsis: [
    "Lists previously entered commands, oldest first.",
    "",
    "  -c    clear the history, in memory and in localStorage",
    "",
    "History persists across visits, which is why -c exists.",
  ],
  run: (ctx) => {
    const history = ctx.history;
    if (ctx.argv.includes("-c")) {
      history.clear();
      return EXIT.OK;
    }
    const entries = history.entries();
    if (entries.length === 0) {
      ctx.out([c("history: empty", "dim")]);
      return EXIT.OK;
    }
    const width = String(entries.length).length;
    entries.forEach((line, i) => {
      ctx.out([sp(1), c(String(i + 1).padStart(width), "dim"), sp(2), c(line)]);
    });
    return EXIT.OK;
  },
};

/** @type {Command} */
export const exitCmd = {
  name: "exit",
  group: "shell",
  summary: "end the session",
  aliases: ["logout"],
  run: (ctx) => {
    ctx.out([c("logout", "dim")]);
    ctx.out(blank);
    ctx.out([c("Connection to hannigan.sh closed.", "dim")]);
    ctx.term.shutdown();
    return EXIT.OK;
  },
};

/** @type {Command} */
export const openCmd = {
  name: "open",
  group: "shell",
  summary: "open a link in a new tab",
  usage: "open github|linkedin|email|site|source|resume",
  synopsis: [
    "Opens a destination in a new tab.",
    "",
    "This exists for keyboard access: links printed in the output carry",
    "tabindex=-1 so Tab does not walk through hundreds of them, which would",
    "otherwise make them unreachable without a mouse.",
  ],
  complete: (argv, index) =>
    index === 1 ? ["github", "linkedin", "email", "site", "source", "resume"] : [],
  run: (ctx) => {
    const ci = ctx.resume.contactInfo;
    /** @type {Record<string, string>} */
    const targets = {
      github: `https://github.com/${ci.github}`,
      linkedin: `https://linkedin.com/in/${ci.linkedin}`,
      email: `mailto:${ci.email}`,
      site: `https://${ci.website}`,
      source: "https://github.com/rhanniga/rhanniga.github.io",
      resume: "./resume.json",
    };

    const what = ctx.argv[1];
    if (what === undefined) {
      ctx.err("usage: open github|linkedin|email|site|source|resume");
      return EXIT.USAGE;
    }
    const url = targets[what];
    if (url === undefined) {
      ctx.err(`open: ${what}: no such destination`);
      return EXIT.USAGE;
    }

    // Called synchronously inside the Enter keydown's task, which still counts
    // as a user gesture -- so popup blockers allow it.
    window.open(url, "_blank", "noopener,noreferrer");
    ctx.out([c(`opening ${url}`, "dim")]);
    return EXIT.OK;
  },
};

/** @type {Command} */
export const sourceCmd = {
  name: "source",
  group: "shell",
  summary: "where the code for this site lives",
  run: (ctx) => {
    ctx.out([c("This terminal is plain ES modules with no build step.", "dim")]);
    ctx.out([c("The `ask` command runs a 135M-parameter model in C, compiled to WASM.", "dim")]);
    ctx.out(blank);
    ctx.out([c("  try: "), c("open source", "bright")]);
    return EXIT.OK;
  },
};

export const builtinCommands = [
  whoamiCmd,
  pwdCmd,
  dateCmd,
  echoCmd,
  clearCmd,
  historyCmd,
  openCmd,
  sourceCmd,
  exitCmd,
];
