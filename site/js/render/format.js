// @ts-check
/**
 * Resume section formatters.
 *
 * All pure: `(resume, cols) => Line[]`. No DOM. That is what makes the layout
 * testable, lets the screen-reader path render the same data unwrapped, and keeps
 * a `?plain=1` HTML view a matter of a different renderer rather than a second
 * implementation.
 */

import { c, sp, link, blank } from "./chunk.js";
import { wrapChunks, indent, bullet, twoCol, heading, columns, kv } from "./layout.js";
import { formatDateRange } from "./dates.js";

/** @typedef {import('./chunk.js').Line} Line */
/** @typedef {import('../data/types.js').Resume} Resume */
/** @typedef {import('../data/types.js').Job} Job */
/** @typedef {import('../data/types.js').Education} Education */
/** @typedef {import('../data/types.js').Bullet} Bullet */

/** Left margin for section content, in columns. */
const PAD = 2;
/** Extra indent for bullets, on top of PAD. */
const BULLET_PAD = 2;

/* ── Keyword highlighting ─────────────────────────────────────────────── */

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Characters that must not abut a keyword for it to count as a whole token. */
const WORDISH = /[\w+#]/;

/**
 * Wrap the keyword occurrences in `text` so they render highlighted.
 *
 * Two details that are easy to get wrong and both matter for this dataset:
 *
 * 1. **Longest-first.** Both `C` and `C++` are keywords here. Without sorting,
 *    the alternation matches `C` and leaves a bare `++` unstyled.
 * 2. **Boundaries checked manually, not with `\b`.** `\bC\+\+\b` never matches,
 *    because `+` is a non-word character so there is no word boundary after it.
 *    The check therefore looks at the adjacent characters directly, treating `+`
 *    and `#` as word-ish so `C`, `C++` and a future `C#` all behave.
 *
 * Lookbehind would express this more neatly but is Safari 16.4+, and the resume
 * itself should render on older browsers even where `ask` cannot run.
 *
 * @param {string} text
 * @param {string[]} [keywords]
 * @returns {Line}
 */
export function highlight(text, keywords) {
  if (text === "") return [];
  const terms = [...new Set((keywords ?? []).filter((k) => typeof k === "string" && k !== ""))]
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [c(text)];

  const re = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  /** @type {Line} */
  const out = [];
  let last = 0;

  for (const m of text.matchAll(re)) {
    const start = m.index;
    const end = start + m[0].length;
    const before = start > 0 ? text[start - 1] : undefined;
    const after = end < text.length ? text[end] : undefined;
    // Reject a match glued to more word characters -- "Cargo" must not light up
    // because "C" is a keyword.
    if (before !== undefined && WORDISH.test(before)) continue;
    if (after !== undefined && WORDISH.test(after)) continue;

    if (start > last) out.push(c(text.slice(last, start)));
    out.push(c(m[0], "keyword"));
    last = end;
  }

  if (last < text.length) out.push(c(text.slice(last)));
  return out.length > 0 ? out : [c(text)];
}

/* ── Shared pieces ────────────────────────────────────────────────────── */

/**
 * @param {Bullet[]} bullets
 * @param {number} cols
 * @returns {Line[]}
 */
function bulletList(bullets, cols) {
  /** @type {Line[]} */
  const out = [];
  for (const b of bullets) {
    out.push(...bullet(highlight(b.text, b.keywords), cols, { indent: PAD + BULLET_PAD }));
  }
  return out;
}

/**
 * A dated entry: title flush left with the date range flush right, a subtitle
 * beneath, then bullets. Shared by jobs and education so they cannot drift apart.
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} spec.subtitle
 * @param {string} spec.location
 * @param {string} spec.startDate
 * @param {string} spec.endDate
 * @param {Bullet[]} spec.bullets
 * @param {number} cols
 * @returns {Line[]}
 */
function datedEntry(spec, cols) {
  const inner = Math.max(1, cols - PAD);
  /** @type {Line[]} */
  const out = [];

  out.push(
    ...indent(
      twoCol(
        [c(spec.title, "bright")],
        [c(formatDateRange(spec.startDate, spec.endDate), "accent")],
        inner,
      ),
      PAD,
    ),
  );

  /** @type {Line} */
  const sub = [c(spec.subtitle, "subheading")];
  if (spec.location !== "") sub.push(c(" · ", "dim"), c(spec.location, "dim"));
  out.push(...indent(wrapChunks(sub, inner), PAD));

  out.push(...bulletList(spec.bullets, cols));
  return out;
}

/* ── Sections ─────────────────────────────────────────────────────────── */

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatSummary(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("summary", cols), blank];
  for (const s of resume.summaries) {
    out.push(...indent(wrapChunks(highlight(s.text, s.keywords), cols - PAD), PAD));
    out.push(blank);
  }
  return out;
}

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatExperience(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("experience", cols), blank];
  resume.jobs.forEach((job, i) => {
    if (i > 0) out.push(blank);
    out.push(
      ...datedEntry(
        {
          title: job.title,
          subtitle: job.company,
          location: job.location,
          startDate: job.startDate,
          endDate: job.endDate,
          bullets: job.bullets,
        },
        cols,
      ),
    );
  });
  out.push(blank);
  return out;
}

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatEducation(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("education", cols), blank];
  resume.educations.forEach((ed, i) => {
    if (i > 0) out.push(blank);
    out.push(
      ...datedEntry(
        {
          title: `${ed.degree}, ${ed.fieldOfStudy}`,
          subtitle: ed.institution,
          location: ed.location,
          startDate: ed.startDate,
          endDate: ed.endDate,
          bullets: ed.bullets,
        },
        cols,
      ),
    );
  });
  out.push(blank);
  return out;
}

/** Display order and labels for the three-tier skill grouping. */
const TIERS = /** @type {const} */ ([
  ["expert", "Expert"],
  ["experienced", "Experienced"],
  ["skilled", "Skilled"],
]);

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatSkills(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("skills", cols), blank];
  for (const [key, label] of TIERS) {
    const names = resume.skills.filter((s) => s.experience === key).map((s) => s.name);
    if (names.length === 0) continue;
    out.push([sp(PAD), c(label, "subheading")]);
    out.push(...indent(columns(names, Math.max(1, cols - PAD - 2)), PAD + 2));
    out.push(blank);
  }
  return out;
}

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatHobbies(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("hobbies", cols), blank];
  for (const h of resume.hobbies ?? []) {
    /** @type {Line} */
    const body = [];
    if (h.name !== undefined && h.name !== "") {
      body.push(c(h.name, "subheading"), c(" — ", "dim"));
    }
    body.push(...highlight(h.text, h.keywords));
    out.push(...bullet(body, cols, { indent: PAD }));
    out.push(blank);
  }
  return out;
}

/**
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatProjects(resume, cols) {
  /** @type {Line[]} */
  const out = [...heading("projects", cols), blank];
  for (const p of resume.projects) {
    /** @type {Line} */
    const title = [c(p.name, "bright")];
    if (p.url !== undefined && p.url !== "") {
      title.push(c("  "), link(p.url.replace(/^https?:\/\//, ""), p.url));
    }
    out.push(...indent(wrapChunks(title, cols - PAD), PAD));
    out.push(...indent(wrapChunks([c(p.description)], cols - PAD - 2), PAD + 2));
    out.push(...bulletList(p.bullets ?? [], cols));
    out.push(blank);
  }
  return out;
}

/**
 * Contact details, with clickable links.
 *
 * Each row prints the plain text of the destination as the link label, so
 * copy-paste works for anyone who cannot or will not click. `mailto:` and `tel:`
 * deliberately get no target attribute.
 *
 * @param {Resume} resume
 * @param {number} cols
 * @returns {Line[]}
 */
export function formatContact(resume, cols) {
  const ci = resume.contactInfo;
  const KEY_WIDTH = 9;

  /** @type {Line[]} */
  const out = [...heading("contact", cols), blank];
  out.push([sp(PAD), c(ci.name, "bright")]);
  out.push(blank);

  /** @type {Array<[string, Line]>} */
  const rows = [];
  if (ci.email !== "") rows.push(["email", [link(ci.email, `mailto:${ci.email}`)]]);
  if (ci.phone !== "") {
    // tel: URIs must not contain spaces.
    rows.push(["phone", [link(ci.phone, `tel:${ci.phone.replace(/\s+/g, "")}`)]]);
  }
  if (ci.github !== "") {
    rows.push([
      "github",
      [link(`github.com/${ci.github}`, `https://github.com/${ci.github}`)],
    ]);
  }
  if (ci.linkedin !== "") {
    rows.push([
      "linkedin",
      [link(`linkedin.com/in/${ci.linkedin}`, `https://linkedin.com/in/${ci.linkedin}`)],
    ]);
  }
  if (ci.website !== "") {
    rows.push(["web", [link(ci.website, `https://${ci.website}`)]]);
  }

  for (const [key, value] of rows) {
    out.push([sp(PAD), ...kv(key.padEnd(KEY_WIDTH), value, KEY_WIDTH)]);
  }
  out.push(blank);
  return out;
}
