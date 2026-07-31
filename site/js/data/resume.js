// @ts-check
/**
 * Loading and validating resume.json.
 *
 * Fetched at runtime rather than inlined into a module, for two reasons: the file
 * stays the single hand-editable source of truth, and it stays a real URL, so
 * `https://www.hannigan.sh/resume.json` works and `cat resume.json` in the
 * terminal is telling the truth rather than re-serialising a copy.
 *
 * The async cost is absorbed by the boot sequence, which has to render anyway.
 */

/** @typedef {import('./types.js').Resume} Resume */

const URL_PATH = "./resume.json";

/**
 * Check the shape well enough that a malformed file fails loudly here instead of
 * producing `undefined` three modules deep in a formatter.
 *
 * With no build step and no type checking in CI, this is the only real validation
 * on the client, so it earns its keep. It is deliberately shallow -- it verifies
 * the containers, not every leaf.
 *
 * @param {unknown} data
 * @returns {string[]} problems found; empty means usable
 */
export function validateResume(data) {
  /** @type {string[]} */
  const problems = [];

  if (typeof data !== "object" || data === null) {
    return ["top level is not an object"];
  }
  const r = /** @type {Record<string, unknown>} */ (data);

  const contact = r["contactInfo"];
  if (typeof contact !== "object" || contact === null) {
    problems.push("contactInfo is missing or not an object");
  } else {
    for (const key of ["name", "email", "github", "linkedin", "website"]) {
      if (typeof (/** @type {Record<string, unknown>} */ (contact)[key]) !== "string") {
        problems.push(`contactInfo.${key} is missing or not a string`);
      }
    }
  }

  for (const key of ["summaries", "educations", "jobs", "projects", "skills"]) {
    if (!Array.isArray(r[key])) problems.push(`${key} is missing or not an array`);
  }

  // hobbies is optional so the site works before the placeholders are filled in.
  if (r["hobbies"] !== undefined && !Array.isArray(r["hobbies"])) {
    problems.push("hobbies is present but not an array");
  }

  return problems;
}

/**
 * Load and validate resume.json.
 *
 * Returns the byte count alongside the data because the boot POST reports it, and
 * it must be the real size of what came over the wire -- re-serialising the parsed
 * object would give a different (smaller) number and quietly make the banner
 * wrong.
 *
 * @returns {Promise<{resume: Resume, bytes: number}>}
 * @throws {Error} on a network failure, bad JSON, or a shape problem
 */
export async function loadResume() {
  const res = await fetch(URL_PATH, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching resume.json`);

  // Read as text so the byte length is the file's, then parse.
  const raw = await res.text();
  const bytes = new TextEncoder().encode(raw).length;

  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`resume.json is not valid JSON: ${String(err)}`);
  }

  const problems = validateResume(data);
  if (problems.length > 0) {
    throw new Error(`resume.json is malformed: ${problems.join("; ")}`);
  }

  return { resume: /** @type {Resume} */ (data), bytes };
}

/**
 * A stand-in used when loading fails, so the shell still comes up. Every resume
 * command detects the empty state and reports the failure rather than rendering
 * blank sections.
 * @returns {Resume}
 */
export function emptyResume() {
  return {
    contactInfo: {
      name: "",
      phone: "",
      email: "",
      github: "",
      linkedin: "",
      website: "",
    },
    summaries: [],
    educations: [],
    jobs: [],
    projects: [],
    skills: [],
    hobbies: [],
  };
}

/**
 * @param {Resume} resume
 * @returns {boolean}
 */
export function isEmpty(resume) {
  return resume.contactInfo.name === "" && resume.jobs.length === 0;
}
