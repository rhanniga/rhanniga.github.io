// @ts-check
/**
 * Guards against the model inventing contact details.
 *
 * Excluding the phone number and email from the system prompt is necessary but
 * NOT sufficient. Asked "what is his phone number?", the quantized model
 * confidently answered `1-800-234-9675` (hybrid) and `1-807-256-3943` (q4) --
 * both fabricated, and both plausibly belonging to somebody real. That is worse
 * than leaking the true number: it is actively misleading, and it could send a
 * recruiter to a stranger.
 *
 * So there are two layers, neither of which trusts the model:
 *
 *   1. **Intercept.** A question that is asking for contact details never reaches
 *      the model at all; `ask` answers it deterministically. Faster and correct.
 *   2. **Redact.** Any long digit run or address-shaped token in generated output
 *      is replaced, because the model can volunteer a fabricated number in an
 *      answer to something else entirely.
 */

/**
 * Is this question asking how to get in touch?
 *
 * Deliberately not triggered by a bare "number" -- "what number of students did he
 * teach?" is a real question with a real answer in the prompt.
 */
const CONTACT_QUESTION =
  /\b(phone|telephone|mobile|cell(?:phone)?|e-?mail|contact|linkedin|github|website|reach|get in touch|call him|call you|call ryan)\b/i;

/**
 * @param {string} question
 * @returns {boolean}
 */
export function isContactQuestion(question) {
  return CONTACT_QUESTION.test(question);
}

/**
 * A year, or a span of years. Exempt, and the exemption is load-bearing: the
 * system prompt is full of `2018-2022` and `2023-present`, and a naive digit count
 * flags `2018-2022` at 8 digits -- which would redact dates out of correct answers.
 */
const YEAR_OR_SPAN = /^\d{4}(?:[-–—](?:\d{4}|present))?$/i;

/** Full phone length. Ten digits or more is not any other kind of number here. */
const PHONE_DIGITS = 10;
/** A shorter run still shaped like a number: three digits, a separator, four. */
const PHONE_SHAPE = /\d{3}[-.\s]\d{4}/;

/**
 * Does this word look like a fabricated phone number or email address?
 *
 * The thresholds are calibrated against what is actually in this resume rather
 * than guessed. Legitimate content includes `$250,000` (6 digits), `2018-2022`
 * (8), `PHY302K`, `4.0`, `50%`, `10x` and bare years -- none of which may be
 * redacted, because that would visibly corrupt a correct answer.
 *
 * KNOWN GAP: a number the model emits space-separated (`832 465 1323`) is not
 * caught, because each fragment is under the threshold on its own and a
 * forward-only stream cannot un-print the earlier fragments. Both models observed
 * so far produce the hyphenated form, and the real defence is the intercept above:
 * a question asking for contact details never reaches the model at all. This layer
 * exists for a number volunteered in answer to something else.
 *
 * @param {string} word
 * @returns {boolean}
 */
export function looksFabricated(word) {
  // An email-shaped token. The model can invent these as readily as numbers, and it
  // does not confine itself to well-formed ones: asked how to get in touch it produced
  // `hannigan@rustyassistant`, which a TLD-requiring pattern lets straight through
  // while a reader would still take it for an address. So any `@` joining two word
  // characters counts. Nothing in this resume legitimately contains one -- asserted in
  // guard.test.mjs against every word of the real system prompt.
  if (/\w@\w/.test(word)) return true;

  // Strip surrounding punctuation before pattern-matching, so a trailing full
  // stop does not defeat the year exemption.
  const core = word.replace(/^[^\w+(]+/, "").replace(/[^\w)]+$/, "");
  if (YEAR_OR_SPAN.test(core)) return false;

  const digits = word.replace(/\D/g, "");
  if (digits.length >= PHONE_DIGITS) return true;
  if (digits.length >= 7 && PHONE_SHAPE.test(word)) return true;

  return false;
}

/** What replaces a redacted token. Says what happened rather than hiding it. */
export const REDACTED = "[redacted]";

/**
 * Replace anything that looks fabricated in a single word.
 *
 * Applied per word as output streams, which works because the streaming wrapper
 * already holds each word until whitespace confirms it -- so a number is caught
 * before any of it reaches the screen, rather than being un-printed afterwards.
 *
 * @param {string} word
 * @returns {string}
 */
export function redactWord(word) {
  return looksFabricated(word) ? REDACTED : word;
}

/**
 * Redact a whole block of text. Used for non-streamed paths.
 * @param {string} text
 * @returns {string}
 */
export function redactText(text) {
  return text.replace(/\S+/g, (word) => redactWord(word));
}

/**
 * A streaming redactor: feed it decoded text, get back text safe to emit.
 *
 * Word-level redaction needs word boundaries, and tokens do not respect them --
 * `123-456-7890` arrives as several tokens, none of which looks fabricated alone. So
 * the trailing partial word is held until whitespace confirms it is complete. A
 * fabricated number is therefore caught before any part of it is emitted, rather than
 * being un-printed afterwards, which a forward-only stream cannot do.
 *
 * This belongs at the point text is produced rather than in each consumer: the worker
 * posts deltas straight to the main thread, and anything that reads the engine gets the
 * protection without having to remember to ask for it.
 *
 * @returns {{push: (text: string) => string, flush: () => string}}
 */
export function makeRedactor() {
  let pending = "";
  return {
    push(text) {
      pending += text;
      // Everything through the last whitespace is settled; the tail may still grow.
      let last = -1;
      for (let i = pending.length - 1; i >= 0; i--) {
        const code = pending.charCodeAt(i);
        if (code === 32 || code === 9 || code === 10 || code === 13) {
          last = i;
          break;
        }
      }
      if (last === -1) return "";
      const ready = pending.slice(0, last + 1);
      pending = pending.slice(last + 1);
      return redactText(ready);
    },
    flush() {
      const rest = pending;
      pending = "";
      return redactText(rest);
    },
  };
}
