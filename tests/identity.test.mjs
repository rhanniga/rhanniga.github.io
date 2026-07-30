// @ts-check
/**
 * The IP validator is the security boundary for the only third-party request the
 * site makes: whatever it returns gets rendered into the prompt. Output goes
 * through textContent so there is no XSS path, but an error page or a rate-limit
 * notice reaching the prompt would still be a bug.
 *
 * resolveIp() itself is not tested here -- it needs network, and the part worth
 * pinning is the validation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isIpAddress } from "../site/js/identity.js";

test("accepts ordinary IPv4 addresses", () => {
  // Documentation-range addresses (RFC 5737) rather than anything real.
  assert.equal(isIpAddress("203.0.113.7"), true);
  assert.equal(isIpAddress("198.51.100.255"), true);
  assert.equal(isIpAddress("0.0.0.0"), true);
  assert.equal(isIpAddress("255.255.255.255"), true);
});

test("rejects out-of-range and malformed IPv4", () => {
  assert.equal(isIpAddress("256.0.0.1"), false);
  assert.equal(isIpAddress("1.2.3"), false);
  assert.equal(isIpAddress("1.2.3.4.5"), false);
  assert.equal(isIpAddress("1.2.3."), false);
  assert.equal(isIpAddress("1.2.3.-4"), false);
  assert.equal(isIpAddress("1.2.3.4 "), false, "no surrounding whitespace");
});

test("rejects leading zeros, which some parsers read as octal", () => {
  assert.equal(isIpAddress("010.0.0.1"), false);
  assert.equal(isIpAddress("1.2.3.04"), false);
  assert.equal(isIpAddress("0.0.0.0"), true, "a bare zero is still fine");
});

test("accepts IPv6 forms including elision", () => {
  assert.equal(isIpAddress("2001:db8::1"), true);
  assert.equal(isIpAddress("::1"), true);
  assert.equal(isIpAddress("::"), true);
  assert.equal(isIpAddress("2001:0db8:0000:0000:0000:ff00:0042:8329"), true);
});

test("rejects malformed IPv6", () => {
  assert.equal(isIpAddress("2001:db8::1::2"), false, "only one elision allowed");
  assert.equal(isIpAddress("2001:db8:zzzz::1"), false, "not hex");
  assert.equal(
    isIpAddress("1:2:3:4:5:6:7:8:9"),
    false,
    "more than eight groups",
  );
  assert.equal(isIpAddress("12345::1"), false, "group longer than four hex digits");
});

test("rejects anything that is not an address at all", () => {
  assert.equal(isIpAddress(""), false);
  assert.equal(isIpAddress("localhost"), false);
  assert.equal(isIpAddress("visitor"), false);
  // The realistic hostile/broken cases: an endpoint returning an error document
  // or a rate-limit notice instead of an address.
  assert.equal(isIpAddress("<html><body>429 Too Many Requests</body></html>"), false);
  assert.equal(isIpAddress("rate limit exceeded"), false);
  assert.equal(isIpAddress("Not Found"), false);
});

test("rejects overlong input that would wreck the prompt layout", () => {
  // Longest legitimate IPv6 string form is 45 characters.
  assert.equal(isIpAddress("1".repeat(46)), false);
  assert.equal(isIpAddress("2001:db8::" + "1".repeat(200)), false);
});

test("rejects non-strings without throwing", () => {
  const bad = [null, undefined, 42, {}, [], true];
  for (const v of bad) {
    // @ts-expect-error deliberately passing the wrong type
    assert.equal(isIpAddress(v), false, `${String(v)} should be rejected`);
  }
});
