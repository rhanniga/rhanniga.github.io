// @ts-check
/**
 * Guards the generated system prompt.
 *
 * site/js/llm/prompt.js is produced by tools/build_prompt.py, which needs torch and
 * transformers -- far too heavy to run in CI. So the generated file is committed and
 * these assertions police it instead. They catch the two ways it can go wrong:
 * drifting over the prefill budget, and leaking contact details into text a
 * stochastic model will recite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_TOKENS,
  SYSTEM_PROMPT_IDS,
  CHAT_TEMPLATE,
} = await import("../site/js/llm/prompt.js");

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

/** Matches tools/build_prompt.py. */
const TOKEN_CEILING = 400;

test("the prompt stays under the prefill ceiling", () => {
  // At ~54ms/token, 400 tokens is ~22s before the first word. The verbatim resume
  // came to 640, which is 35s, and nobody waits that long.
  assert.ok(
    SYSTEM_PROMPT_TOKENS <= TOKEN_CEILING,
    `${SYSTEM_PROMPT_TOKENS} tokens exceeds the ${TOKEN_CEILING} ceiling — ` +
      `re-run tools/build_prompt.py and trim`,
  );
  assert.ok(SYSTEM_PROMPT_TOKENS > 100, "suspiciously short — did tokenization fail?");
});

test("the token count matches the token array", () => {
  // The first version of build_prompt.py reported 2 tokens, because
  // apply_chat_template returns a UserDict and len() counted its keys.
  assert.equal(SYSTEM_PROMPT_IDS.length, SYSTEM_PROMPT_TOKENS);
});

test("no phone number reaches the prompt", () => {
  // A 135M model reciting a phone number is PII amplification, and it would get
  // the digits wrong. The deterministic `contact` command serves these instead.
  const digits = resume.contactInfo.phone.replace(/\D/g, "");
  assert.ok(digits.length >= 10, "test fixture assumption: phone has digits");
  assert.ok(!SYSTEM_PROMPT.includes(digits), "full phone digits leaked");
  // Also check the formatted form and any run of 7+ digits.
  assert.ok(!SYSTEM_PROMPT.includes(resume.contactInfo.phone));
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{7,}/, "a long digit run looks like a phone number");
});

test("no email address reaches the prompt", () => {
  assert.ok(!SYSTEM_PROMPT.includes(resume.contactInfo.email));
  assert.doesNotMatch(SYSTEM_PROMPT, /@/, "no at-sign at all, so no address can hide");
});

test("the prompt tells the model to defer contact questions", () => {
  assert.match(SYSTEM_PROMPT, /contact/i);
});

test("the prompt is prose, never JSON", () => {
  // A 135M model shown `{"jobs": [...]}` will cheerfully continue emitting JSON
  // instead of answering.
  assert.doesNotMatch(SYSTEM_PROMPT, /[{}]/);
  assert.doesNotMatch(SYSTEM_PROMPT, /"\w+":/);
});

test("no clipped clause is left trailing off", () => {
  // "focusing on." and "performing multi-dimensional angular." both escaped the
  // first version of the clipper. A fragment spends tokens and invites the model to
  // finish the dangling thought.
  for (const sentence of SYSTEM_PROMPT.split(/(?<=\.)\s+/)) {
    const trimmed = sentence.trim();
    if (trimmed === "") continue;
    assert.doesNotMatch(
      trimmed,
      /\b(on|in|of|for|with|and|the|a|to|at|including|focusing|performing|using)\.$/i,
      `sentence trails off: ${JSON.stringify(trimmed)}`,
    );
  }
});

test("the prompt carries the facts questions are actually asked about", () => {
  for (const needle of ["CERN", "UT Austin", "VenHub", "Particle Physics", "Python"]) {
    assert.ok(SYSTEM_PROMPT.includes(needle), `missing ${needle}`);
  }
});

test("dates are years, not ISO timestamps", () => {
  // Month precision buys nothing and costs tokens.
  assert.doesNotMatch(SYSTEM_PROMPT, /\d{4}-\d{2}-\d{2}/);
  assert.match(SYSTEM_PROMPT, /2018-2022/);
});

test("the chat template is ChatML with a generation prompt", () => {
  assert.match(CHAT_TEMPLATE, /<\|im_start\|>system/);
  assert.match(CHAT_TEMPLATE, /<\|im_end\|>/);
  assert.match(CHAT_TEMPLATE, /<\|im_start\|>assistant/);
});

test("the token ids begin with im_start and end with im_end + newline", () => {
  // <|im_start|> is 1 and <|im_end|> is 2. No BOS is prepended -- the template
  // starts with im_start directly, and adding one would shift every position.
  assert.equal(SYSTEM_PROMPT_IDS[0], 1);
  assert.ok(
    Array.from(SYSTEM_PROMPT_IDS).includes(2),
    "the system turn must be closed with <|im_end|>",
  );
});
