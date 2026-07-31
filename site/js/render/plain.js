// @ts-check
/**
 * The `?plain=1` view: a real semantic HTML resume.
 *
 * The honest accessibility answer. A terminal emulator is a deliberately unusual
 * interface, and no amount of `aria-label` makes it a good one for someone using a
 * screen reader, a braille display, or reader mode -- so there is a document version,
 * reachable from the skip link that is the first focusable element on the page.
 *
 * It is also the crawlable surface. Recruiters google people, and `index.html`
 * deliberately contains no resume text -- putting it there would duplicate
 * `resume.json` into markup that then rots. So this view is what `robots.txt` points at
 * and what a search engine gets a real document from.
 *
 * Built as a DOM tree rather than an HTML string: no escaping to get wrong, and
 * `textContent` cannot inject markup even if the resume one day contains a `<`.
 */

/** @typedef {import('../data/types.js').Resume} Resume */

import { formatDateRange } from "./dates.js";

/**
 * @param {string} tag
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {string} label
 * @param {string} href
 * @returns {HTMLAnchorElement}
 */
function link(label, href) {
  const a = /** @type {HTMLAnchorElement} */ (el("a", label));
  a.href = href;
  return a;
}

/**
 * @param {import('../data/types.js').Bullet[]} bullets
 * @returns {HTMLElement | null}
 */
function bulletList(bullets) {
  if (bullets.length === 0) return null;
  const ul = el("ul");
  for (const b of bullets) ul.appendChild(el("li", b.text));
  return ul;
}

/**
 * Render the resume into a semantic document fragment.
 *
 * Headings are a real outline -- one `h1`, `h2` per section, `h3` per entry -- because
 * that outline is how a screen-reader user navigates. Dates go in `<time>`-adjacent
 * plain text rather than a table, since a two-column layout read linearly is worse
 * than a sentence.
 *
 * @param {Resume} resume
 * @returns {DocumentFragment}
 */
export function renderPlain(resume) {
  const frag = document.createDocumentFragment();
  const ci = resume.contactInfo;

  const header = el("header");
  header.appendChild(el("h1", ci.name));
  if (resume.summaries.length > 0) {
    header.appendChild(el("p", resume.summaries[0].text));
  }
  frag.appendChild(header);

  /* ── Contact ─────────────────────────────────────────────────────────── */
  const contact = el("section");
  contact.appendChild(el("h2", "Contact"));
  const list = el("ul");

  /**
   * Append a link item, skipping the whole item when the value is absent.
   *
   * Truthiness rather than `!== ""`: a field missing from resume.json is
   * `undefined`, which is not `""`, and the first version of this rendered an empty
   * bullet for one. A stray empty list item is a real defect here -- a screen reader
   * announces "bullet" and then nothing.
   *
   * @param {string | undefined} value
   * @param {(v: string) => {label: string, href: string}} shape
   */
  const item = (value, shape) => {
    if (value === undefined || value.trim() === "") return;
    const { label, href } = shape(value.trim());
    const li = el("li");
    li.appendChild(link(label, href));
    list.appendChild(li);
  };

  // The phone number is deliberately absent. This view is public and crawlable, and
  // `contact` in the terminal is where the number lives.
  item(ci.email, (v) => ({ label: v, href: `mailto:${v}` }));
  item(ci.github, (v) => ({ label: `github.com/${v}`, href: `https://github.com/${v}` }));
  item(ci.linkedin, (v) => ({
    label: `linkedin.com/in/${v}`,
    href: `https://linkedin.com/in/${v}`,
  }));
  item(ci.website, (v) => ({ label: v, href: `https://${v}` }));

  contact.appendChild(list);
  frag.appendChild(contact);

  /* ── Experience ──────────────────────────────────────────────────────── */
  if (resume.jobs.length > 0) {
    const section = el("section");
    section.appendChild(el("h2", "Experience"));
    for (const job of resume.jobs) {
      const article = el("article");
      article.appendChild(el("h3", `${job.title}, ${job.company}`));
      const meta = [job.location, formatDateRange(job.startDate, job.endDate)]
        .filter((s) => s !== "")
        .join(" · ");
      if (meta !== "") article.appendChild(el("p", meta));
      const ul = bulletList(job.bullets);
      if (ul !== null) article.appendChild(ul);
      section.appendChild(article);
    }
    frag.appendChild(section);
  }

  /* ── Education ───────────────────────────────────────────────────────── */
  if (resume.educations.length > 0) {
    const section = el("section");
    section.appendChild(el("h2", "Education"));
    for (const edu of resume.educations) {
      const article = el("article");
      const degree =
        edu.fieldOfStudy === "" ? edu.degree : `${edu.degree} in ${edu.fieldOfStudy}`;
      article.appendChild(el("h3", `${degree}, ${edu.institution}`));
      const meta = [edu.location, formatDateRange(edu.startDate, edu.endDate)]
        .filter((s) => s !== "")
        .join(" · ");
      if (meta !== "") article.appendChild(el("p", meta));
      const ul = bulletList(edu.bullets);
      if (ul !== null) article.appendChild(ul);
      section.appendChild(article);
    }
    frag.appendChild(section);
  }

  /* ── Skills ──────────────────────────────────────────────────────────── */
  if (resume.skills.length > 0) {
    const section = el("section");
    section.appendChild(el("h2", "Skills"));
    // Grouped by proficiency, because a flat list of eleven names says less than
    // three short lists do.
    /** @type {Map<string, string[]>} */
    const byLevel = new Map();
    for (const skill of resume.skills) {
      const level = skill.experience;
      const names = byLevel.get(level);
      if (names === undefined) byLevel.set(level, [skill.name]);
      else names.push(skill.name);
    }
    const dl = el("dl");
    for (const [level, names] of byLevel) {
      dl.appendChild(el("dt", level));
      dl.appendChild(el("dd", names.join(", ")));
    }
    section.appendChild(dl);
    frag.appendChild(section);
  }

  /* ── Hobbies ─────────────────────────────────────────────────────────── */
  // Skipped entirely while the entries are TODO placeholders. A section reading
  // "TODO - replace with a real hobby" is worse than no section, and this is the
  // crawlable surface.
  const hobbies = resume.hobbies.filter(
    (h) => !h.name.trim().toUpperCase().startsWith("TODO"),
  );
  if (hobbies.length > 0) {
    const section = el("section");
    section.appendChild(el("h2", "Interests"));
    for (const hobby of hobbies) {
      const article = el("article");
      article.appendChild(el("h3", hobby.name));
      article.appendChild(el("p", hobby.text));
      section.appendChild(article);
    }
    frag.appendChild(section);
  }

  /* ── Back to the terminal ────────────────────────────────────────────── */
  const footer = el("footer");
  const back = el("p");
  back.appendChild(link("Back to the terminal", "./"));
  footer.appendChild(back);
  const source = el("p");
  source.appendChild(link("resume.json", "./resume.json"));
  source.insertBefore(document.createTextNode("Source data: "), source.firstChild);
  footer.appendChild(source);
  frag.appendChild(footer);

  return frag;
}

/**
 * Is `?plain=1` (or `?plain`) requested?
 * @param {string} search
 * @returns {boolean}
 */
export function wantsPlain(search) {
  const params = new URLSearchParams(search);
  if (!params.has("plain")) return false;
  const value = params.get("plain");
  // `?plain`, `?plain=1`, `?plain=true` all mean yes; `?plain=0` means no, so a link
  // can turn it off explicitly.
  return value === null || value === "" || !/^(0|false|no)$/i.test(value);
}

/**
 * Take over the document with the plain view.
 *
 * Replaces the body rather than hiding the terminal: the terminal's DOM, listeners,
 * and its 83 MB `ask` path should not exist on a page whose whole purpose is to be a
 * simple document.
 *
 * @param {Resume} resume
 */
export function mountPlain(resume) {
  document.documentElement.dataset.view = "plain";
  // The CRT overlay and scanlines are actively unhelpful here, and data-crt drives
  // them from the root element.
  document.documentElement.dataset.crt = "off";

  const main = el("main");
  main.className = "plain";
  main.appendChild(renderPlain(resume));

  document.body.textContent = "";
  document.body.appendChild(main);

  const title = `${resume.contactInfo.name} — resume`;
  document.title = title;
}
