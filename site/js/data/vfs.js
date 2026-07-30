// @ts-check
/**
 * A read-only virtual filesystem, backing `ls` and `cat`.
 *
 * Every size is the real UTF-8 byte length of the content, so `ls -l` is not
 * lying. That matters more than it sounds: made-up sizes are the kind of detail
 * that makes the whole thing feel like a mock-up.
 *
 * `resume.json` is the honest centrepiece -- it corresponds to a real URL, and
 * `cat`ting it shows the actual data every other command renders from.
 */

import { formatDateRange } from "../render/dates.js";

/** @typedef {import('./types.js').Resume} Resume */
/** @typedef {import('../render/chunk.js').Line} Line */

/**
 * @typedef {object} VFile
 * @property {string} name
 * @property {string} mode      as ls -l prints it
 * @property {string} content
 * @property {number} size      UTF-8 bytes
 * @property {unknown} [json]   set for .json files, so cat can colour them
 */

const encoder = new TextEncoder();

/**
 * @param {string} name
 * @param {string} content
 * @param {unknown} [json]
 * @returns {VFile}
 */
function file(name, content, json) {
  return {
    name,
    mode: "-rw-r--r--",
    content,
    size: encoder.encode(content).length,
    ...(json !== undefined ? { json } : {}),
  };
}

/**
 * @param {Resume} resume
 * @returns {string}
 */
function aboutText(resume) {
  const lines = [resume.contactInfo.name, ""];
  for (const s of resume.summaries) lines.push(s.text, "");
  return lines.join("\n");
}

/**
 * @param {Resume} resume
 * @returns {string}
 */
function skillsText(resume) {
  /** @type {string[]} */
  const lines = [];
  for (const tier of ["expert", "experienced", "skilled"]) {
    const names = resume.skills.filter((s) => s.experience === tier).map((s) => s.name);
    if (names.length === 0) continue;
    lines.push(`${tier}:`);
    for (const n of names) lines.push(`  ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {Resume} resume
 * @returns {string}
 */
function contactText(resume) {
  const ci = resume.contactInfo;
  return [
    ci.name,
    `email:    ${ci.email}`,
    `phone:    ${ci.phone}`,
    `github:   https://github.com/${ci.github}`,
    `linkedin: https://linkedin.com/in/${ci.linkedin}`,
    `web:      https://${ci.website}`,
    "",
  ].join("\n");
}

/**
 * @param {Resume} resume
 * @returns {string}
 */
function workText(resume) {
  /** @type {string[]} */
  const lines = [];
  for (const j of resume.jobs) {
    lines.push(`${j.title} — ${j.company} (${j.location})`);
    lines.push(`  ${formatDateRange(j.startDate, j.endDate)}`);
    for (const b of j.bullets) lines.push(`  - ${b.text}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {Resume} resume
 * @returns {string}
 */
function hobbiesText(resume) {
  const hobbies = (resume.hobbies ?? []).filter((h) => !h.text.startsWith("TODO"));
  if (hobbies.length === 0) {
    return "Not written yet. The schema is in resume.json under \"hobbies\".\n";
  }
  return hobbies
    .map((h) => (h.name !== undefined ? `${h.name}: ${h.text}` : h.text))
    .join("\n\n")
    .concat("\n");
}

const README = `hannigan.sh

A resume served through a terminal emulator. Plain ES modules, no build step --
the files in the repo are the files served.

The party trick is \`ask\`: a 135M-parameter language model written in C,
compiled to WebAssembly, and run entirely in your browser. There is no backend.

  help        list every command
  summary     start here
  cat resume.json
              the data everything else renders from

Source: https://github.com/rhanniga/rhanniga.github.io
`;

/**
 * @param {Resume} resume
 * @returns {VFile[]}
 */
export function buildVfs(resume) {
  // Serialised the same way JSON.stringify writes it, which is also how
  // render/json.js lays it out -- so `cat resume.json` matches the real file.
  const json = JSON.stringify(resume, null, 2) + "\n";

  return [
    file("README.md", README),
    file("about.txt", aboutText(resume)),
    file("contact.txt", contactText(resume)),
    file("hobbies.txt", hobbiesText(resume)),
    file("resume.json", json, resume),
    file("skills.txt", skillsText(resume)),
    file("work.txt", workText(resume)),
  ];
}

/**
 * @param {VFile[]} files
 * @param {string} name
 * @returns {VFile | undefined}
 */
export function findFile(files, name) {
  // Tolerate a leading ./ the way a shell would.
  const wanted = name.replace(/^\.\//, "");
  return files.find((f) => f.name === wanted);
}
