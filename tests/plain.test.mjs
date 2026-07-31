// @ts-check
/**
 * The ?plain=1 document view.
 *
 * This is the accessibility answer of record and the crawlable surface, so what it
 * needs to get right is structural: one h1, a real heading outline, every resume entry
 * present, and links that are actual links. `wantsPlain` is pure; `renderPlain` needs
 * `document`, so a small DOM stand-in is installed rather than pulling in jsdom -- the
 * function only uses createElement/createTextNode/appendChild/textContent, and a fake
 * that implements exactly that keeps the dependency count at zero.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { wantsPlain, renderPlain } from "../site/js/render/plain.js";

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

/* ── A minimal DOM ──────────────────────────────────────────────────────── */

class FakeNode {
  /** @param {string} tag */
  constructor(tag) {
    this.tag = tag;
    /** @type {FakeNode[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attrs = {};
    this._text = "";
    this.href = "";
    this.className = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  /** @param {FakeNode} child */
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  /** @param {FakeNode} child @param {FakeNode|null} before */
  insertBefore(child, before) {
    const at = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attrs[name] = value;
  }
  /** Depth-first, including self. */
  *walk() {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
  /** @param {string} tag */
  all(tag) {
    return [...this.walk()].filter((n) => n.tag === tag);
  }
}

function installDom() {
  const previous = /** @type {any} */ (globalThis).document;
  /** @type {any} */ (globalThis).document = {
    createElement: (tag) => new FakeNode(tag.toLowerCase()),
    createTextNode: (text) => {
      const n = new FakeNode("#text");
      n.textContent = text;
      return n;
    },
    createDocumentFragment: () => new FakeNode("#fragment"),
  };
  return () => {
    if (previous === undefined) delete /** @type {any} */ (globalThis).document;
    else /** @type {any} */ (globalThis).document = previous;
  };
}

/** Render once, into the fake DOM. */
function render() {
  const restore = installDom();
  try {
    return /** @type {any} */ (renderPlain(resume));
  } finally {
    restore();
  }
}

/* ── wantsPlain ─────────────────────────────────────────────────────────── */

test("wantsPlain accepts the forms a link might use", () => {
  for (const search of ["?plain=1", "?plain", "?plain=", "?plain=true", "?a=b&plain=1"]) {
    assert.equal(wantsPlain(search), true, search);
  }
});

test("wantsPlain can be turned off explicitly", () => {
  // So a link can carry ?plain=0 and mean the terminal.
  for (const search of ["?plain=0", "?plain=false", "?plain=no"]) {
    assert.equal(wantsPlain(search), false, search);
  }
});

test("wantsPlain ignores unrelated queries", () => {
  for (const search of ["", "?", "?ask=mock", "?explain=1", "?plainly=1"]) {
    assert.equal(wantsPlain(search), false, search);
  }
});

/* ── Structure ──────────────────────────────────────────────────────────── */

test("there is exactly one h1, and it is the name", () => {
  // More than one h1 breaks the document outline a screen reader navigates by.
  const doc = render();
  const h1s = doc.all("h1");
  assert.equal(h1s.length, 1);
  assert.equal(h1s[0].textContent, resume.contactInfo.name);
});

test("the heading outline does not skip a level", () => {
  // h1 -> h3 with no h2 is a real navigation bug, not a style preference.
  const doc = render();
  const levels = [...doc.walk()]
    .filter((n) => /^h[1-6]$/.test(n.tag))
    .map((n) => Number(n.tag.slice(1)));
  assert.ok(levels.length > 3);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(
      levels[i] <= levels[i - 1] + 1,
      `jumped from h${levels[i - 1]} to h${levels[i]}`,
    );
  }
});

test("every job appears with its bullets", () => {
  const doc = render();
  const text = doc.textContent;
  for (const job of resume.jobs) {
    assert.ok(text.includes(job.title), `missing job title: ${job.title}`);
    assert.ok(text.includes(job.company), `missing company: ${job.company}`);
    for (const bullet of job.bullets) {
      assert.ok(
        text.includes(bullet.text),
        `missing bullet: ${bullet.text.slice(0, 40)}…`,
      );
    }
  }
});

test("every education entry appears with its bullets", () => {
  const doc = render();
  const text = doc.textContent;
  for (const edu of resume.educations) {
    assert.ok(text.includes(edu.institution), `missing: ${edu.institution}`);
    for (const bullet of edu.bullets) assert.ok(text.includes(bullet.text));
  }
});

test("every skill appears", () => {
  const doc = render();
  const text = doc.textContent;
  for (const skill of resume.skills) {
    assert.ok(text.includes(skill.name), `missing skill: ${skill.name}`);
  }
});

test("bullets are list items, not paragraphs", () => {
  // A screen reader announces "list, 5 items" and lets you skip it. Paragraphs get
  // read straight through with no structure.
  const doc = render();
  const items = doc.all("li");
  const bulletCount =
    resume.jobs.reduce((n, j) => n + j.bullets.length, 0) +
    resume.educations.reduce((n, e) => n + e.bullets.length, 0);
  assert.ok(items.length >= bulletCount, `${items.length} <li> for ${bulletCount} bullets`);
});

test("contact details are real links with correct schemes", () => {
  const doc = render();
  const links = doc.all("a");
  const hrefs = links.map((a) => a.href);
  assert.ok(
    hrefs.some((h) => h === `mailto:${resume.contactInfo.email}`),
    `no mailto: link among ${hrefs.join(", ")}`,
  );
  assert.ok(hrefs.some((h) => h.includes("github.com/")));
  assert.ok(hrefs.some((h) => h.includes("linkedin.com/in/")));
  for (const href of hrefs) {
    assert.ok(
      /^(mailto:|https:\/\/|\.\/)/.test(href),
      `link with a suspect scheme: ${href}`,
    );
  }
});

test("there is a way back to the terminal", () => {
  // Otherwise the skip link is a one-way door.
  const doc = render();
  assert.ok(doc.all("a").some((a) => a.href === "./"));
});

test("TODO placeholders are not rendered", () => {
  // This is the crawlable, indexable surface. A section reading "TODO - replace with
  // a real hobby" is worse than no section.
  const doc = render();
  assert.ok(!/\bTODO\b/.test(doc.textContent), "a placeholder leaked into the document");
});

test("no phone number appears", () => {
  // The plain view is public and crawlable. Email, GitHub and LinkedIn are the
  // contact surface; the phone number is deliberately not, and `contact` in the
  // terminal is where it lives.
  const doc = render();
  const digits = doc.textContent.replace(/\D/g, "");
  const phone = resume.contactInfo.phone.replace(/\D/g, "");
  if (phone !== "") {
    assert.ok(!digits.includes(phone), "the phone number is exposed in the plain view");
  }
});

test("rendering does not mutate the resume", () => {
  const before = JSON.stringify(resume);
  render();
  assert.equal(JSON.stringify(resume), before);
});

test("no element is rendered empty", () => {
  // A missing resume field produced an empty <li> in the contact list: a bullet a
  // screen reader announces with nothing after it. `undefined !== ""` was the bug,
  // so emptiness is now checked rather than inequality with "".
  const doc = render();
  for (const node of doc.walk()) {
    if (node.tag === "#fragment" || node.tag === "#text") continue;
    if (["ul", "dl", "section", "article", "header", "footer", "main"].includes(node.tag)) {
      // Containers are judged by their children, not their own text.
      assert.ok(node.children.length > 0, `<${node.tag}> has no children`);
      continue;
    }
    assert.notEqual(
      node.textContent.trim(),
      "",
      `<${node.tag}> rendered with no content`,
    );
  }
});

test("a resume missing optional contact fields renders no empty items", () => {
  // The general form of the same bug, driven directly rather than relying on the
  // real file happening to omit a field.
  const restore = installDom();
  try {
    const sparse = {
      ...resume,
      contactInfo: { name: "A Person", phone: "", email: "a@b.co" },
    };
    const doc = /** @type {any} */ (renderPlain(sparse));
    const items = doc.all("li");
    for (const li of items) {
      assert.notEqual(li.textContent.trim(), "", "empty <li> from a missing field");
    }
    // Only the one field that was present.
    const contactLinks = doc.all("a").filter((a) => a.href.startsWith("mailto:"));
    assert.equal(contactLinks.length, 1);
  } finally {
    restore();
  }
});
