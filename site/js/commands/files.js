// @ts-check
/**
 * `ls` and `cat` over the virtual filesystem.
 *
 * These are what give the terminal a reason to exist beyond a menu of sections:
 * `cat resume.json` shows the actual data every other command renders from.
 */

import { c, sp } from "../render/chunk.js";
import { columns, wrapChunks } from "../render/layout.js";
import { formatJson } from "../render/json.js";
import { buildVfs, findFile } from "../data/vfs.js";
import { parseFlags, invalidOptionMessage } from "../shell/flags.js";
import { EXIT } from "../shell/env.js";
import { USER } from "../terminal/prompt.js";

/** @typedef {import('../shell/registry.js').Command} Command */
/** @typedef {import('../data/vfs.js').VFile} VFile */

/**
 * A real mtime: the Last-Modified of index.html, i.e. when the site was actually
 * deployed. With no build step there is no timestamp to inject, and inventing one
 * would be exactly the kind of fake detail worth avoiding.
 * @returns {string}
 */
function mtime() {
  const d = new Date(document.lastModified);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** @type {Command} */
export const lsCmd = {
  name: "ls",
  group: "shell",
  summary: "list files",
  usage: "ls [-l] [file ...]",
  synopsis: [
    "Lists the virtual files this terminal serves.",
    "",
    "  -l    long format, with real byte sizes",
    "",
    "The sizes are the actual UTF-8 byte lengths of the content, and the",
    "timestamp is the real Last-Modified of the deployed page.",
  ],
  complete: (argv, index) => (index >= 1 ? lsNames() : []),
  run: (ctx) => {
    const parsed = parseFlags(ctx.argv, { bools: { long: ["l"] } });
    if (!parsed.ok) {
      ctx.err(invalidOptionMessage("ls", parsed.badFlag));
      return EXIT.USAGE;
    }

    const files = buildVfs(ctx.resume);

    /** @type {VFile[]} */
    let listing;
    if (parsed.operands.length === 0) {
      listing = files;
    } else {
      listing = [];
      let missing = false;
      for (const name of parsed.operands) {
        const f = findFile(files, name);
        if (f === undefined) {
          ctx.err(`ls: cannot access '${name}': No such file or directory`);
          missing = true;
        } else {
          listing.push(f);
        }
      }
      if (missing && listing.length === 0) return EXIT.ERROR;
    }

    if (!parsed.flags["long"]) {
      ctx.rows(columns(listing.map((f) => f.name), ctx.cols));
      return EXIT.OK;
    }

    const total = listing.reduce((n, f) => n + f.size, 0);
    ctx.out([c(`total ${Math.ceil(total / 1024)}`, "dim")]);

    const sizeWidth = listing.reduce((m, f) => Math.max(m, String(f.size).length), 0);
    const when = mtime();
    for (const f of listing) {
      ctx.out([
        c(f.mode, "dim"),
        sp(1),
        c(`1 ${USER} ${USER}`, "dim"),
        sp(1),
        c(String(f.size).padStart(sizeWidth)),
        sp(1),
        c(when, "dim"),
        sp(1),
        c(f.name, f.name.endsWith(".json") ? "accent" : "text"),
      ]);
    }
    return EXIT.OK;
  },
};

/** @returns {string[]} */
function lsNames() {
  // Names are static, so completion does not need the resume loaded.
  return [
    "README.md",
    "about.txt",
    "contact.txt",
    "hobbies.txt",
    "resume.json",
    "skills.txt",
    "work.txt",
  ];
}

/** @type {Command} */
export const catCmd = {
  name: "cat",
  group: "shell",
  summary: "print a file",
  usage: "cat file ...",
  synopsis: [
    "Prints one or more of the virtual files.",
    "",
    "resume.json is syntax-coloured, and is the same data every other command",
    "renders from. It is also a real URL: /resume.json.",
  ],
  complete: (argv, index) => (index >= 1 ? lsNames() : []),
  run: (ctx) => {
    const names = ctx.argv.slice(1);
    if (names.length === 0) {
      ctx.err("usage: cat file ...");
      return EXIT.USAGE;
    }

    const files = buildVfs(ctx.resume);
    let status = EXIT.OK;

    for (const name of names) {
      const f = findFile(files, name);
      if (f === undefined) {
        ctx.err(`cat: ${name}: No such file or directory`);
        status = EXIT.ERROR;
        continue;
      }

      if (f.json !== undefined) {
        // Coloured, and structurally identical to the file on disk. Long strings
        // are left unwrapped: a real terminal soft-wraps them at the screen edge,
        // and the CSS does the same.
        ctx.rows(formatJson(f.json));
        continue;
      }

      for (const line of f.content.split("\n")) {
        if (line === "") {
          ctx.out([]);
        } else {
          ctx.rows(wrapChunks([c(line)], ctx.cols));
        }
      }
    }

    return status;
  },
};

export const fileCommands = [lsCmd, catCmd];
