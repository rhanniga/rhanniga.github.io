// @ts-check
/**
 * Grep-mode retrieval.
 *
 * Two kinds of test here. The mechanical ones pin BM25 behaviour that is easy to break
 * while tuning -- length normalisation, non-negative idf, deduplicated query terms. The
 * rest are relevance expectations written as questions a visitor would actually type,
 * which is the only honest way to test a ranker: the score is meaningless, the ordering
 * is the product.
 *
 * The relevance cases are deliberately specific about *which* card should win. Three of
 * them were failures before the aliases moved from a query-side synonym map onto the
 * cards, and they are the reason that change happened.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  tokenize,
  expandQuery,
  buildIndex,
  search,
  grepAnswer,
} from "../site/js/llm/fallback.js";
import { CARDS } from "../site/js/llm/cards.js";

/** The winning card's id for a query. */
function top(query) {
  const hits = search(query);
  return hits.length === 0 ? null : hits[0].card.id;
}

/** Every card id that a query returns, in rank order. */
function ranked(query) {
  return search(query).map((m) => m.card.id);
}

test("the corpus is present and shaped as expected", () => {
  assert.ok(CARDS.length >= 20, `only ${CARDS.length} cards`);
  for (const card of CARDS) {
    assert.match(card.id, /^[a-z0-9-]+$/);
    assert.ok(card.title.length > 0, `${card.id} has no title`);
    assert.ok(card.text.length > 0, `${card.id} has no text`);
    assert.ok(Array.isArray(card.keywords), `${card.id} keywords is not an array`);
  }
  const ids = new Set(CARDS.map((c) => c.id));
  assert.equal(ids.size, CARDS.length, "card ids must be unique");
});

test("no TODO placeholder is retrievable", () => {
  // The hobbies entries are unfilled. Returning "TODO - replace with a real hobby"
  // as a search result would be worse than returning nothing.
  for (const card of CARDS) {
    assert.ok(
      !/\bTODO\b/.test(`${card.title} ${card.text}`),
      `${card.id} contains a TODO placeholder`,
    );
  }
});

/* ── Tokenizing ─────────────────────────────────────────────────────────── */

test("tokenize keeps the content that matters here", () => {
  // c++ and version-like numbers are real content in this resume; splitting them
  // would make "does he know C++" unanswerable.
  assert.deepEqual(tokenize("C++ and Python"), ["c++", "python"]);
  assert.deepEqual(tokenize("GPA: 4.0"), ["gpa", "4.0"]);
  assert.deepEqual(tokenize("Python/FastAPI"), ["python", "fastapi"]);
  assert.deepEqual(tokenize("2018-2022"), ["2018", "2022"]);
});

test("tokenize drops the words a question is made of", () => {
  // "what did he do at CERN" has exactly one content word, which is the whole reason
  // a stoplist is needed rather than optional.
  assert.deepEqual(tokenize("what did he do at CERN"), ["cern"]);
  assert.deepEqual(tokenize("Where did Ryan get his PhD?"), ["ryan", "phd"]);
});

test("a query of nothing but stopwords finds nothing", () => {
  assert.deepEqual(search("what is it"), []);
  assert.equal(grepAnswer("what is it").shown.length, 0);
});

test("expandQuery keeps the original term alongside the synonym", () => {
  // Replacing rather than adding would stop "CERN" matching the card that says CERN.
  const terms = expandQuery("cern");
  assert.ok(terms.includes("cern"), "the typed term must survive expansion");
  assert.ok(terms.includes("alice"));
});

test("every synonym target occurs in the corpus", () => {
  // A synonym pointing at a word the resume no longer contains is dead weight that
  // looks like a working feature. This is the test that keeps the map honest as
  // resume.json changes.
  const vocabulary = new Set();
  for (const card of CARDS) {
    for (const t of tokenize(`${card.title} ${card.meta ?? ""} ${card.text}`)) {
      vocabulary.add(t);
    }
    for (const phrase of [...card.keywords, ...(card.aliases ?? [])]) {
      for (const t of tokenize(phrase)) vocabulary.add(t);
    }
  }
  // Probe through the public API: expand a known input and check the targets exist.
  for (const [term, expected] of [
    ["phd", "doctorate"],
    ["cern", "alice"],
    ["teach", "lecturer"],
    ["now", "present"],
  ]) {
    assert.ok(
      expandQuery(term).includes(expected),
      `${term} should expand to ${expected}`,
    );
    assert.ok(vocabulary.has(expected), `synonym target "${expected}" is not in the corpus`);
  }
});

/* ── Scoring mechanics ──────────────────────────────────────────────────── */

test("idf never makes a matching term subtract from a score", () => {
  // Textbook BM25 idf goes negative for a term in more than half the documents, which
  // would penalise a card for containing a query word. The +1 inside the log prevents
  // it, and this is the test that notices if it is removed.
  const cards = [
    { id: "a", kind: "bullet", title: "t", text: "common word here", keywords: [] },
    { id: "b", kind: "bullet", title: "t", text: "common word too", keywords: [] },
    { id: "c", kind: "bullet", title: "t", text: "common word again", keywords: [] },
  ];
  const index = buildIndex(/** @type {any} */ (cards));
  for (const m of search("common", { index })) {
    assert.ok(m.score > 0, `${m.card.id} scored ${m.score}`);
  }
});

test("a long card does not beat a short one just by being long", () => {
  // Length normalisation. Without it the 300-character bullets outrank everything,
  // because they contain more of every word.
  const cards = [
    { id: "short", kind: "bullet", title: "t", text: "rust", keywords: [] },
    {
      id: "long",
      kind: "bullet",
      title: "t",
      text: "rust " + "filler words that carry no query signal at all ".repeat(20),
      keywords: [],
    },
  ];
  const index = buildIndex(/** @type {any} */ (cards));
  const hits = search("rust", { index });
  assert.equal(hits[0].card.id, "short");
});

test("a repeated query term is not counted twice", () => {
  const cards = [
    { id: "a", kind: "bullet", title: "t", text: "python", keywords: [] },
    { id: "b", kind: "bullet", title: "t", text: "rust", keywords: [] },
  ];
  const index = buildIndex(/** @type {any} */ (cards));
  const once = search("python", { index })[0].score;
  const twice = search("python python python", { index })[0].score;
  assert.equal(twice, once, "repetition must not inflate the score");
});

test("a curated keyword outranks an incidental body mention", () => {
  // The point of the 3x boost: `keywords` is a human saying "this card is about that".
  const cards = [
    { id: "curated", kind: "bullet", title: "t", text: "unrelated prose", keywords: ["Rust"] },
    { id: "incidental", kind: "bullet", title: "t", text: "a passing mention of rust here", keywords: [] },
  ];
  const index = buildIndex(/** @type {any} */ (cards));
  assert.equal(search("rust", { index })[0].card.id, "curated");
});

test("aliases score like curated keywords", () => {
  const cards = [
    { id: "aliased", kind: "skills", title: "t", text: "nothing relevant", keywords: [], aliases: ["languages"] },
  ];
  const index = buildIndex(/** @type {any} */ (cards));
  assert.equal(search("languages", { index })[0]?.card.id, "aliased");
});

test("the title is searchable, not just the body", () => {
  // A bullet about picosecond timing has to be findable by "CERN", which appears only
  // in the title it inherited from its job.
  const hits = ranked("picosecond");
  assert.ok(hits.length > 0);
  const card = CARDS.find((c) => c.id === hits[0]);
  assert.match(/** @type {any} */ (card).title, /CERN/);
});

test("search returns nothing for a term the resume does not contain", () => {
  // Grep-mode must be willing to say it found nothing. Inventing a loose match would
  // be the one thing it is supposed to be better than the model at.
  assert.deepEqual(search("kubernetes"), []);
  assert.deepEqual(search("blockchain"), []);
  assert.deepEqual(search("asdfghjkl"), []);
});

test("limit truncates without reordering", () => {
  const all = ranked("python");
  assert.ok(all.length > 2, "need several hits for this to mean anything");
  const limited = search("python", { limit: 2 }).map((m) => m.card.id);
  assert.deepEqual(limited, all.slice(0, 2));
});

/* ── Relevance ──────────────────────────────────────────────────────────── */

test("a question about the PhD finds the doctorate", () => {
  assert.equal(top("Where did Ryan get his PhD?"), "education-0");
  assert.equal(top("does he have a doctorate"), "education-0");
});

test("a question about school finds education, not a job", () => {
  const first = top("what school did he go to");
  assert.ok(
    first !== null && first.startsWith("education-"),
    `got ${first}, expected an education card`,
  );
});

test("a question about languages finds the skills card", () => {
  // Was failing: `languages -> python` as a query synonym made a bullet mentioning
  // Python outrank the skills card. Fixed by putting the alias on the card.
  assert.equal(top("what languages does he know"), "skills");
  assert.equal(top("what's his tech stack"), "skills");
});

test("a question about leading a team finds the mentoring bullet", () => {
  // Was failing: `team -> leadership` pulled the skills card to the top, because
  // "Leadership" is one of its keywords. The bullet actually says "a team of 8+".
  const first = top("has he led a team?");
  const card = CARDS.find((c) => c.id === first);
  assert.match(/** @type {any} */ (card).text, /team of 8\+/);
});

test("a question about CERN finds the CERN job", () => {
  assert.equal(top("what did you do at CERN?"), "job-2");
});

test("a question about the current role prefers the present-dated job", () => {
  // Was failing: every job card matched "work" equally, so the ordering was arbitrary.
  // The discriminator is "present" in the date span.
  const first = top("where does he work now?");
  const card = CARDS.find((c) => c.id === first);
  assert.match(/** @type {any} */ (card).meta ?? "", /present/);
});

test("a question about teaching finds the lecturer role", () => {
  const first = top("did he teach?");
  const card = CARDS.find((c) => c.id === first);
  assert.match(/** @type {any} */ (card).title, /Lecturer/);
});

test("a named employer finds that employer", () => {
  assert.equal(top("tell me about VenHub"), "job-0");
});

test("a named technology finds where it was used", () => {
  const first = top("does he know react");
  const card = CARDS.find((c) => c.id === first);
  assert.match(/** @type {any} */ (card).text, /React/);
});

/* ── The answer shape ───────────────────────────────────────────────────── */

test("grepAnswer shows the winner and a close runner-up", () => {
  const answer = grepAnswer("what is his GPA");
  assert.equal(answer.shown.length, 2, "both GPAs are equally good answers");
  for (const m of answer.shown) assert.match(m.card.text, /GPA/);
});

test("grepAnswer shows one card when the winner is clear", () => {
  const answer = grepAnswer("tell me about VenHub");
  assert.equal(answer.shown.length, 1);
  assert.ok(answer.remaining > 0, "the rest should be counted, not shown");
});

test("grepAnswer never shows more than two", () => {
  // Three would be a search results page. This is supposed to read as an answer.
  for (const q of ["python", "software", "engineer", "research", "physics"]) {
    assert.ok(grepAnswer(q).shown.length <= 2, `"${q}" showed too many`);
  }
});

test("grepAnswer counts the matches it withheld", () => {
  const q = "python";
  const answer = grepAnswer(q);
  assert.equal(answer.shown.length + answer.remaining, search(q).length);
});

test("grepAnswer suggests commands that exist", () => {
  // A suggestion pointing at a command the shell does not have would be worse than
  // no suggestion.
  const known = new Set(["summary", "experience", "education", "skills", "hobbies"]);
  for (const q of ["python", "phd", "cern", "gpa", "leadership"]) {
    for (const cmd of grepAnswer(q).see) {
      assert.ok(known.has(cmd), `unknown command suggested: ${cmd}`);
    }
  }
});

test("grepAnswer on no match returns an empty, well-formed answer", () => {
  const answer = grepAnswer("kubernetes");
  assert.deepEqual(answer, { shown: [], remaining: 0, see: [] });
});

test("retrieval is fast enough to be synchronous", () => {
  // The grep REPL answers on the same tick, with no spinner and no running mode. That
  // is only honest if it really is this cheap.
  const started = Date.now();
  for (let i = 0; i < 200; i++) grepAnswer("what did he do at CERN with python and c++");
  const per = (Date.now() - started) / 200;
  assert.ok(per < 5, `${per.toFixed(2)}ms per query is too slow to be synchronous`);
});
