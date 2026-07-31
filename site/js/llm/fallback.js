// @ts-check
/**
 * Grep-mode: answer a question by retrieving the resume, not generating text.
 *
 * This is a first-class answer path, not an apology. For most questions a visitor
 * actually asks -- where did he work, what did he do at CERN, what languages does he
 * know -- returning the relevant bullet verbatim is *more* useful than what a 135M
 * model produces, and it is instant, needs no download, and cannot hallucinate. It is
 * the right default on a phone and the only option without WebAssembly.
 *
 * Scoring is BM25. The "lite" part is that there is no stemming and no phrase handling;
 * what is not cut is the length normalisation, because card lengths here span two
 * orders of magnitude -- "GPA: 4.0" against a 300-character bullet -- and without it
 * the short cards win everything on term-frequency alone.
 *
 * Two signals beyond plain BM25:
 *
 *   - The `keywords` arrays already in resume.json, boosted 3x. Hand-curated relevance,
 *     free, and maintained as a side effect of maintaining the resume.
 *   - A small query-side synonym map, because visitors say "PhD" and "school" while the
 *     resume says "Doctorate" and "University". Every target is asserted to occur in the
 *     corpus by fallback.test.mjs, so the map cannot rot silently as the resume changes.
 */

import { CARDS } from "./cards.js";

/**
 * Words carrying no retrieval signal. Questions are mostly made of these, which is
 * exactly why they have to go: "what did he do at CERN" has one content word.
 *
 * Deliberately absent: "c" (a language), and anything appearing in a job title.
 */
const STOPWORDS = new Set([
  "a", "about", "all", "am", "an", "and", "any", "are", "as", "at", "be", "been",
  "but", "by", "can", "did", "do", "does", "for", "from", "get", "got", "had",
  "has", "have", "he", "her", "him", "his", "how", "i", "in", "into", "is", "it",
  "its", "many", "me", "much", "of", "on", "or", "s", "she", "so", "some", "tell",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "to", "us", "was", "we", "were", "what", "whats", "when", "where", "which",
  "who", "whom", "why", "will", "with", "you", "your", "yours",
]);

/**
 * Query-side synonyms: what visitors type -> what the resume says.
 *
 * Deliberately tiny. Most of what a synonym map would do belongs on the cards instead
 * (see EXTRA_KEYWORDS in tools/build_cards.py), because a query-side expansion fires on
 * every card containing the target and distorts the ranking. Measured: mapping
 * `languages -> python` made a bullet mentioning Python outrank the skills card, and
 * mapping `team -> leadership` made the skills card outrank "Mentored and guided a team
 * of 8+ engineers". Both went away when the alias moved onto the card.
 *
 * What is left is the case aliases cannot cover: a different word for the *same thing*,
 * where the corpus word is specific rather than a category. Every target is asserted to
 * occur in the corpus by fallback.test.mjs.
 *
 * @type {Record<string, string[]>}
 */
const SYNONYMS = {
  phd: ["doctorate"],
  "ph.d": ["doctorate"],
  phds: ["doctorate"],
  dphil: ["doctorate"],
  doctoral: ["doctorate"],
  cern: ["alice"],
  teach: ["lecturer"],
  teaches: ["lecturer"],
  teacher: ["lecturer"],
  professor: ["lecturer"],
  current: ["present"],
  currently: ["present"],
  now: ["present"],
};

/** BM25 term-frequency saturation. 1.2 is the standard starting point. */
const K1 = 1.2;
/** BM25 length normalisation. 0.75 is standard; 0 would disable it. */
const B = 0.75;
/** How much a curated keyword match is worth relative to a body match. */
const KEYWORD_BOOST = 3;
/** A runner-up this close to the winner is worth showing too. */
const RUNNER_UP_RATIO = 0.8;

/**
 * Split text into scoring terms.
 *
 * Keeps `c++` and `4.0` whole, since both are real content here, and splits
 * `Python/FastAPI` into two terms because that is how someone would search for it.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lowered = text.toLowerCase();
  const matches = lowered.match(/[a-z0-9]+(?:\+\+|#|\.[0-9]+)?/g) ?? [];
  return matches.filter((t) => !STOPWORDS.has(t));
}

/**
 * Tokenize a query and add synonyms.
 *
 * The original term is always kept: `cern -> [cern, alice]`, never just `alice`, or a
 * question about CERN would stop matching the card that says CERN.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function expandQuery(query) {
  /** @type {string[]} */
  const out = [];
  for (const term of tokenize(query)) {
    out.push(term);
    for (const syn of SYNONYMS[term] ?? []) {
      if (syn !== term) out.push(syn);
    }
  }
  return out;
}

/**
 * @typedef {object} Index
 * @property {import('./cards.js').Card[]} cards
 * @property {Array<Map<string, number>>} tf      Term -> count, per card.
 * @property {Array<Set<string>>} keywords        Curated terms, per card.
 * @property {Map<string, number>} df             Term -> document frequency.
 * @property {number[]} length                    Term count, per card.
 * @property {number} avgLength
 * @property {number} n
 */

/**
 * Build the inverted index. ~24 cards, so this is well under a millisecond and there is
 * no reason to precompute it at build time.
 *
 * @param {import('./cards.js').Card[]} [cards]
 * @returns {Index}
 */
export function buildIndex(cards = CARDS) {
  /** @type {Array<Map<string, number>>} */
  const tf = [];
  /** @type {Array<Set<string>>} */
  const keywords = [];
  /** @type {Map<string, number>} */
  const df = new Map();
  /** @type {number[]} */
  const length = [];

  for (const card of cards) {
    // The title is part of the searchable text: a bullet about picosecond timing should
    // still match "CERN", which only appears in its title.
    const terms = tokenize(`${card.title} ${card.meta ?? ""} ${card.text}`);
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const term of counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    tf.push(counts);
    length.push(terms.length);

    // Curated keywords and generated aliases score identically. The distinction is
    // about provenance -- which file owns them -- not about weight.
    /** @type {Set<string>} */
    const kw = new Set();
    for (const phrase of [...card.keywords, ...(card.aliases ?? [])]) {
      for (const t of tokenize(phrase)) kw.add(t);
    }
    keywords.push(kw);
  }

  const total = length.reduce((a, b) => a + b, 0);
  return {
    cards,
    tf,
    keywords,
    df,
    length,
    avgLength: cards.length === 0 ? 0 : total / cards.length,
    n: cards.length,
  };
}

/** @type {Index | null} */
let defaultIndex = null;

/** The shared index over the shipped cards. */
function getIndex() {
  if (defaultIndex === null) defaultIndex = buildIndex();
  return defaultIndex;
}

/**
 * BM25 inverse document frequency.
 *
 * The `+1` inside the log keeps this non-negative: without it a term present in more
 * than half the cards scores negatively, so a card could be *penalised* for containing
 * a query term, which is never what anyone means.
 *
 * @param {number} df
 * @param {number} n
 * @returns {number}
 */
function idf(df, n) {
  return Math.log((n - df + 0.5) / (df + 0.5) + 1);
}

/**
 * @typedef {object} Match
 * @property {import('./cards.js').Card} card
 * @property {number} score
 * @property {string[]} terms  Query terms that matched, for highlighting.
 */

/**
 * Score every card against a query, best first. Zero-scoring cards are dropped.
 *
 * @param {string} query
 * @param {{index?: Index, limit?: number}} [opts]
 * @returns {Match[]}
 */
export function search(query, opts = {}) {
  const index = opts.index ?? getIndex();
  const terms = expandQuery(query);
  if (terms.length === 0 || index.n === 0) return [];

  /** @type {Match[]} */
  const scored = [];
  for (let i = 0; i < index.n; i++) {
    const counts = index.tf[i];
    const len = index.length[i];
    let score = 0;
    /** @type {string[]} */
    const matched = [];

    // Deduplicated: a query term repeated (directly or via a synonym) must not count
    // twice, or "python python" would outrank a better card.
    for (const term of new Set(terms)) {
      const freq = counts.get(term) ?? 0;
      const inKeywords = index.keywords[i].has(term);
      if (freq === 0 && !inKeywords) continue;

      const weight = idf(index.df.get(term) ?? 0, index.n);
      // Standard BM25 saturation, then the curated-keyword boost on top. A keyword
      // match with no body occurrence still scores, which is the point of having them.
      const norm = len === 0 ? 1 : 1 - B + (B * len) / (index.avgLength || 1);
      const saturated = (freq * (K1 + 1)) / (freq + K1 * norm);
      score += weight * (saturated + (inKeywords ? KEYWORD_BOOST : 0));
      matched.push(term);
    }

    if (score > 0) scored.push({ card: index.cards[i], score, terms: matched });
  }

  // Ties broken by card order, which puts the summary and whole-job cards ahead of
  // individual bullets -- the more general answer first.
  scored.sort((a, b) => b.score - a.score);
  return opts.limit === undefined ? scored : scored.slice(0, opts.limit);
}

/**
 * @typedef {object} GrepAnswer
 * @property {Match[]} shown     The winner, plus any near-tie runner-up.
 * @property {number} remaining  Further matches not shown.
 * @property {string[]} see      Commands that would show more.
 */

/**
 * Answer a question: the best card, plus a runner-up when it is nearly as good.
 *
 * Showing two is a deliberate hedge -- retrieval on a 24-card corpus is often close
 * between a job card and one of its bullets, and both are usually worth reading. Three
 * would be a search results page rather than an answer.
 *
 * @param {string} query
 * @param {{index?: Index}} [opts]
 * @returns {GrepAnswer}
 */
export function grepAnswer(query, opts = {}) {
  const all = search(query, opts);
  if (all.length === 0) return { shown: [], remaining: 0, see: [] };

  const shown = [all[0]];
  if (all.length > 1 && all[1].score >= all[0].score * RUNNER_UP_RATIO) {
    shown.push(all[1]);
  }

  /** @type {string[]} */
  const see = [];
  for (const m of all) {
    const cmd = m.card.see;
    if (cmd !== undefined && !see.includes(cmd)) see.push(cmd);
  }

  return { shown, remaining: all.length - shown.length, see };
}
