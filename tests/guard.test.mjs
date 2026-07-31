// @ts-check
/**
 * Guards against fabricated contact details.
 *
 * These are not hypothetical. Asked "what is his phone number?", the quantized
 * models answered:
 *
 *     hybrid:  Dr. Ryan Hannigan's phone number is 1-800-234-9675.
 *     q4:      Dr. Ryan Hannigan's phone number is 1-807-256-3943.
 *
 * Both fabricated, both confident, and both plausibly somebody real's line.
 * Omitting the number from the system prompt was necessary and not sufficient.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isContactQuestion,
  looksFabricated,
  redactWord,
  redactText,
  REDACTED,
} from "../site/js/llm/guard.js";
import { streamWrapper } from "../site/js/render/stream-wrap.js";

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

test("recognises questions asking for contact details", () => {
  for (const q of [
    "what is his phone number?",
    "What's your email?",
    "how can I contact him",
    "how do I reach Ryan",
    "do you have a telephone",
    "whats his e-mail address",
    "give me your linkedin",
    "what is his github",
    "can I call you",
    "what's his cell",
    "how to get in touch",
  ]) {
    assert.ok(isContactQuestion(q), `should intercept: ${q}`);
  }
});

test("does not intercept ordinary questions", () => {
  for (const q of [
    "where did he get his PhD?",
    "what did he do at CERN?",
    "what number of students did he teach?",
    "how many engineers did he lead?",
    "what languages does he know",
    "tell me about VenHub",
    "what is his job title",
  ]) {
    assert.ok(!isContactQuestion(q), `should NOT intercept: ${q}`);
  }
});

test("flags the numbers the model actually invented", () => {
  assert.ok(looksFabricated("1-800-234-9675."));
  assert.ok(looksFabricated("1-807-256-3943."));
  assert.ok(looksFabricated("(512)555-0134"));
  assert.ok(looksFabricated("+1-512-555-0134"));
  assert.ok(looksFabricated("5125550134"));
});

test("flags fabricated email addresses too", () => {
  // The model can invent an address as readily as a number.
  assert.ok(looksFabricated("ryan@example.com"));
  assert.ok(looksFabricated("r.hannigan@utexas.edu."));
  assert.ok(!looksFabricated("email"));
  assert.ok(!looksFabricated("@"));
});

test("does NOT flag the real numbers in this resume", () => {
  // The threshold is calibrated against actual content, not guessed. Anything
  // here being redacted would visibly corrupt correct answers.
  for (const word of [
    "$250,000",   // 6 digits — the fellowship
    "PHY302K",    // a course code
    "2017",       // a year
    "2018-2022",  // a year span — 8 digits, and the reason a bare count fails
    "2023-present",
    "(2017)",     // parenthesised year
    "8+",         // team size
    "50%",        // a percentage
    "10x",        // a multiplier
    "100",        // students
    "4.0",        // GPA
    "3.9",
    "C++",
    "135M",
  ]) {
    assert.ok(!looksFabricated(word), `must not redact: ${word}`);
  }
});

test("no word in the real system prompt is flagged", () => {
  // The strongest form of the previous test: redaction must be invisible on
  // legitimate output.
  const prompt = readFileSync(
    new URL("../engine/tests/fixtures/prompt.txt", import.meta.url),
    "utf8",
  );
  for (const word of prompt.split(/\s+/)) {
    if (word === "") continue;
    assert.ok(!looksFabricated(word), `prompt word flagged: ${JSON.stringify(word)}`);
  }
});

test("no prose in the resume produces a false positive", () => {
  // Only the bullet/summary text, which is what the model sees and echoes. The
  // contactInfo block is deliberately excluded: the real phone and email SHOULD be
  // flagged if they ever come out of the model.
  const prose = [
    ...resume.summaries.map((s) => s.text),
    ...resume.jobs.flatMap((j) => [j.title, j.company, j.location,
                                   ...j.bullets.map((b) => b.text)]),
    ...resume.educations.flatMap((e) => [e.institution, e.degree, e.fieldOfStudy,
                                        e.location, ...e.bullets.map((b) => b.text)]),
    ...resume.skills.map((s) => s.name),
  ].join(" ");
  for (const word of prose.split(/\s+/)) {
    if (word === "") continue;
    assert.ok(!looksFabricated(word), `false positive: ${JSON.stringify(word)}`);
  }
});

test("the real phone and email ARE flagged, in their concatenated forms", () => {
  // They must never reach the screen from the model, only from `contact`.
  assert.ok(looksFabricated(resume.contactInfo.phone.replace(/\s/g, "")));
  assert.ok(looksFabricated(resume.contactInfo.email));
});

test("a space-separated number is a documented gap, not a silent one", () => {
  // Each fragment is under threshold on its own, and a forward-only stream cannot
  // un-print the earlier ones. Recorded as a test so the limitation is visible
  // rather than assumed away. The intercept is what actually covers this case.
  assert.ok(!looksFabricated("832"));
  assert.ok(!looksFabricated("465"));
  assert.ok(!looksFabricated("1323"));
  // Whereas the hyphenated form both models actually produced is caught.
  assert.ok(looksFabricated("1-800-234-9675"));
});

test("redactWord replaces only what it flags", () => {
  assert.equal(redactWord("1-800-234-9675"), REDACTED);
  assert.equal(redactWord("Austin"), "Austin");
  assert.equal(redactWord("$250,000"), "$250,000");
});

test("redactText leaves a sentence readable", () => {
  assert.equal(
    redactText("His phone number is 1-800-234-9675 and he lives in Austin."),
    `His phone number is ${REDACTED} and he lives in Austin.`,
  );
});

test("streaming redaction catches a number before any of it is written", () => {
  // The point of doing this at word granularity: the wrapper already holds each
  // word until whitespace confirms it, so nothing has to be un-printed.
  let written = "";
  const w = streamWrapper((s) => { written += s; }, {
    width: 60,
    transform: redactWord,
  });
  // Fed one character at a time, as a token stream would.
  for (const ch of "call 1-800-234-9675 now") w.push(ch);
  w.end();

  assert.ok(!written.includes("1-800"), `leaked: ${JSON.stringify(written)}`);
  assert.ok(!/\d{3}/.test(written), "no long digit run should survive");
  assert.match(written, /call/);
  assert.match(written, /now/);
  assert.ok(written.includes(REDACTED));
});

test("streaming redaction does not disturb a clean answer", () => {
  let written = "";
  const w = streamWrapper((s) => { written += s; }, {
    width: 200,
    transform: redactWord,
  });
  const answer =
    "Ryan got his PhD in the field of particle physics, specifically at the University of Texas at Austin.";
  for (const piece of answer.match(/\S+\s*/g) ?? []) w.push(piece);
  w.end();
  assert.equal(written.trim(), answer);
});
