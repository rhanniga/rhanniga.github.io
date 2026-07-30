// @ts-check
/**
 * Registry assembly.
 *
 * Explicit imports, not discovery. There is no bundler to glob with, and being
 * explicit means `help` ordering is whatever this list says rather than whatever
 * the filesystem happened to return.
 */

import { Registry } from "../shell/registry.js";
import { helpCmd } from "./help.js";
import { resumeCommands } from "./resume-cmds.js";
import { builtinCommands } from "./builtins.js";
import { easterCommands } from "./easter.js";

/**
 * @returns {Registry}
 */
export function buildRegistry() {
  return new Registry([
    // The resume is the product, so it leads.
    ...resumeCommands,
    // `ask` slots in here at M6.
    helpCmd,
    ...builtinCommands,
    ...easterCommands,
  ]);
}
