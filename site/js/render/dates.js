// @ts-check
/**
 * Date formatting for resume entries.
 *
 * Ported from `format_date_range()` in the previous Leptos site
 * (`HEAD~:src/components/portfolio.rs`), with the 12-arm match replaced by a
 * table. Behaviour is identical, including the `"Present"` sentinel and the
 * pass-through fallback for anything that does not parse.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** The sentinel resume.json uses for an ongoing role, in place of a date. */
export const PRESENT = "Present";

/**
 * `"2023-10-01"` -> `"Oct 2023"`.
 *
 * Deliberately string-only. `new Date("2023-01-01")` parses as UTC midnight and
 * renders as December 2022 in any negative-offset timezone -- including the
 * author's own -- which is precisely the bug the Rust version avoided by
 * splitting the string. There is a test pinned to a negative TZ.
 *
 * @param {string} s an ISO `YYYY-MM-DD` date, or `"Present"`
 * @returns {string}
 */
export function formatDate(s) {
  if (typeof s !== "string" || s === "") return "";
  if (s === PRESENT) return PRESENT;

  const parts = s.split("-");
  // Same fallback as the Rust version: hand back whatever we were given rather
  // than inventing a date. A malformed entry should look wrong, not plausible.
  if (parts.length !== 3) return s;

  const [year, month] = parts;
  if (year === undefined || month === undefined) return s;

  const name = MONTHS[Number(month) - 1];
  return name === undefined ? `${month} ${year}` : `${name} ${year}`;
}

/**
 * `"Oct 2023 - Jul 2025"`, or `"Jan 2023 - Present"`.
 * @param {string} start
 * @param {string} end
 * @returns {string}
 */
export function formatDateRange(start, end) {
  return `${formatDate(start)} - ${formatDate(end)}`;
}

/**
 * Just the year, for the LLM system prompt -- which is token-budgeted, and where
 * month precision buys nothing.
 * @param {string} s
 * @returns {string}
 */
export function formatYear(s) {
  if (s === PRESENT) return PRESENT;
  const year = s.split("-")[0];
  return year ?? s;
}
