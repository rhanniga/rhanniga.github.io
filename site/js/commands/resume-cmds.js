// @ts-check
/**
 * The commands the resume actually exists to serve.
 */

import { c } from "../render/chunk.js";
import {
  formatSummary,
  formatExperience,
  formatEducation,
  formatSkills,
  formatHobbies,
  formatContact,
} from "../render/format.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */
/** @typedef {import('../shell/registry.js').CommandContext} CommandContext */
/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('../data/types.js').Resume} Resume */

/**
 * Wrap a formatter as a command, with the empty-state handling every section
 * needs. Reporting honestly beats printing a heading over nothing.
 *
 * @param {object} spec
 * @param {string} spec.name
 * @param {string} spec.summary
 * @param {(r: Resume) => boolean} spec.hasData
 * @param {(r: Resume, cols: number) => Line[]} spec.format
 * @param {string} [spec.emptyHint]
 * @param {string[]} [spec.aliases]
 * @returns {Command}
 */
function section({ name, summary, hasData, format, emptyHint, aliases }) {
  return {
    name,
    group: "resume",
    summary,
    ...(aliases !== undefined ? { aliases } : {}),
    run: (ctx) => {
      if (!hasData(ctx.resume)) {
        ctx.err(emptyHint ?? `${name}: no data`);
        return EXIT.ERROR;
      }
      ctx.rows(format(ctx.resume, ctx.cols));
      return EXIT.OK;
    },
  };
}

/** @type {Command} */
export const summaryCmd = section({
  name: "summary",
  summary: "who I am, in one paragraph",
  hasData: (r) => r.summaries.length > 0,
  format: formatSummary,
});

/** @type {Command} */
export const experienceCmd = section({
  name: "experience",
  summary: "where I have worked and what I built",
  aliases: ["work"],
  hasData: (r) => r.jobs.length > 0,
  format: formatExperience,
});

/** @type {Command} */
export const educationCmd = section({
  name: "education",
  summary: "degrees and where they came from",
  hasData: (r) => r.educations.length > 0,
  format: formatEducation,
});

/** @type {Command} */
export const skillsCmd = section({
  name: "skills",
  summary: "languages and tools, by depth",
  hasData: (r) => r.skills.length > 0,
  format: formatSkills,
});

/** @type {Command} */
export const contactCmd = section({
  name: "contact",
  summary: "how to reach me",
  aliases: ["email"],
  hasData: (r) => r.contactInfo.name !== "",
  format: formatContact,
});

/**
 * Hobbies get a bespoke empty state rather than the generic one: the section is
 * scaffolded with TODO placeholders, so "no data" would be misleading.
 * @type {Command}
 */
export const hobbiesCmd = {
  name: "hobbies",
  group: "resume",
  summary: "what I do when not working",
  run: (ctx) => {
    const hobbies = ctx.resume.hobbies ?? [];
    const real = hobbies.filter((h) => !h.text.startsWith("TODO"));
    if (real.length === 0) {
      ctx.out([c("hobbies: nothing here yet — try: ", "dim"), c('ask "what does Ryan do for fun?"')]);
      return EXIT.OK;
    }
    ctx.rows(formatHobbies({ ...ctx.resume, hobbies: real }, ctx.cols));
    return EXIT.OK;
  },
};

/* `projects` is deliberately absent. The array in resume.json is empty, the
 * formatter is written and tested, and the command gets registered the moment
 * there is something to show. Shipping a command that prints an empty section
 * would be worse than not having it. */

export const resumeCommands = [
  summaryCmd,
  experienceCmd,
  educationCmd,
  skillsCmd,
  hobbiesCmd,
  contactCmd,
];
