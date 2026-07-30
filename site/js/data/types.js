// @ts-check
/**
 * Shape of resume.json.
 *
 * Types only -- this module exports no runtime values. A faithful port of the
 * serde structs from the previous Leptos site (`HEAD~:src/resume.rs`), with the
 * camelCase keys preserved so no renaming layer is needed.
 *
 * These are a developer aid inside the editor, not a guarantee: nothing
 * type-checks in CI. The runtime backstop is validateResume() in resume.js.
 */

/**
 * @typedef {object} ContactInfo
 * @property {string} name
 * @property {string} phone
 * @property {string} email
 * @property {string} github    bare username, not a URL
 * @property {string} linkedin  bare username, not a URL
 * @property {string} website   bare hostname, not a URL
 */

/**
 * The shared shape of every piece of prose in the file. `keywords` drives inline
 * highlighting, and doubles as a hand-curated relevance signal for `ask`'s
 * offline fallback.
 * @typedef {object} Keyworded
 * @property {string} text
 * @property {string[]} keywords
 */

/** @typedef {Keyworded} Summary */
/** @typedef {Keyworded} Bullet */

/**
 * @typedef {object} Education
 * @property {string} institution
 * @property {string} location
 * @property {string} degree
 * @property {string} fieldOfStudy
 * @property {string} startDate  ISO YYYY-MM-DD
 * @property {string} endDate    ISO YYYY-MM-DD, or the literal "Present"
 * @property {Bullet[]} bullets
 */

/**
 * @typedef {object} Job
 * @property {string} title
 * @property {string} company
 * @property {string} location
 * @property {string} startDate  ISO YYYY-MM-DD
 * @property {string} endDate    ISO YYYY-MM-DD, or the literal "Present"
 * @property {Bullet[]} bullets
 */

/**
 * `experience` is a three-value enum by convention. Typing it as a union makes
 * the tiered grouping in formatSkills() safe.
 * @typedef {object} Skill
 * @property {string} name
 * @property {'expert'|'experienced'|'skilled'} experience
 */

/**
 * `name` is optional: without it the entry renders as a plain bulleted
 * paragraph rather than a titled one.
 * @typedef {object} Hobby
 * @property {string} text
 * @property {string[]} keywords
 * @property {string} [name]
 */

/**
 * @typedef {object} Project
 * @property {string} name
 * @property {string} description
 * @property {string} [url]
 * @property {Bullet[]} [bullets]
 */

/**
 * @typedef {object} Resume
 * @property {ContactInfo} contactInfo
 * @property {Summary[]} summaries
 * @property {Education[]} educations
 * @property {Job[]} jobs
 * @property {Project[]} projects
 * @property {Skill[]} skills
 * @property {Hobby[]} [hobbies]
 */

export {};
