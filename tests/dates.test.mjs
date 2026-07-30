// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { formatDate, formatDateRange, formatYear, PRESENT } from "../site/js/render/dates.js";

test("formats ISO dates as month and year", () => {
  assert.equal(formatDate("2023-10-01"), "Oct 2023");
  assert.equal(formatDate("2012-09-01"), "Sep 2012");
  assert.equal(formatDate("2017-01-01"), "Jan 2017");
  assert.equal(formatDate("2025-12-31"), "Dec 2025");
});

test("passes the Present sentinel through", () => {
  // resume.json uses a bare string here rather than a date, which is why the
  // types call this field a string.
  assert.equal(formatDate(PRESENT), "Present");
  assert.equal(formatDate("Present"), "Present");
});

test("hands back malformed input rather than inventing a date", () => {
  // A broken entry should look broken, not plausible.
  assert.equal(formatDate("2023"), "2023");
  assert.equal(formatDate("2023-10"), "2023-10");
  assert.equal(formatDate("garbage"), "garbage");
  assert.equal(formatDate(""), "");
});

test("an out-of-range month falls back to the raw number", () => {
  assert.equal(formatDate("2023-13-01"), "13 2023");
  assert.equal(formatDate("2023-00-01"), "00 2023");
});

test("formats ranges, including ongoing roles", () => {
  assert.equal(formatDateRange("2023-10-01", "2025-07-10"), "Oct 2023 - Jul 2025");
  assert.equal(formatDateRange("2023-01-01", "Present"), "Jan 2023 - Present");
});

test("formatYear keeps only the year", () => {
  assert.equal(formatYear("2023-10-01"), "2023");
  assert.equal(formatYear("Present"), "Present");
  assert.equal(formatYear("nonsense"), "nonsense");
});

test("does NOT shift dates in a negative-offset timezone", () => {
  // The bug this function exists to avoid: `new Date("2023-01-01")` parses as UTC
  // midnight, which is 2022-12-31 in any negative-offset zone -- including the
  // author's own. Every date here must be immune, because the implementation
  // splits the string and never constructs a Date.
  const original = process.env.TZ;
  try {
    for (const tz of ["America/Chicago", "America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(formatDate("2023-01-01"), "Jan 2023", `wrong in ${tz}`);
      assert.equal(formatDate("2023-12-31"), "Dec 2023", `wrong in ${tz}`);
      assert.equal(formatYear("2023-01-01"), "2023", `wrong in ${tz}`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
