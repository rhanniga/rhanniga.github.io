// @ts-check
/**
 * Resolve the visitor's public IP address, for the prompt.
 *
 * This is the ONLY third-party request the site makes. It is deliberately:
 *
 *   - **lazy** -- kicked off after the terminal is interactive, never awaited on
 *     the critical path, so a slow or hanging endpoint cannot delay first paint;
 *   - **sequential** -- the fallback endpoint is only contacted if the first
 *     fails, so a working request never fans out to two third parties;
 *   - **bounded** -- an AbortController timeout means a hung connection is
 *     dropped rather than left pending for the life of the page;
 *   - **validated** -- see below. This matters more than the rest.
 *
 * Expect it to fail for a real fraction of visitors: uBlock Origin and similar
 * block IP-echo endpoints by default. Failure is silent and the prompt keeps its
 * `visitor@` fallback, which is why nothing downstream may assume it resolved.
 */

/** Longest possible IPv6 string form, e.g. an IPv4-mapped address. */
const MAX_LEN = 45;
const TIMEOUT_MS = 2500;

/** @type {Array<{url: string, pick: (body: string) => string}>} */
const ENDPOINTS = [
  {
    url: "https://api.ipify.org?format=json",
    pick: (body) => {
      const parsed = JSON.parse(body);
      return typeof parsed?.ip === "string" ? parsed.ip : "";
    },
  },
  // Plain text, run by Cloudflare. Different operator and different response
  // format, so it is a genuine fallback rather than a retry.
  { url: "https://icanhazip.com", pick: (body) => body.trim() },
];

/**
 * Is this string a syntactically valid IP address?
 *
 * The prompt renders whatever this returns, so an unvalidated response would let
 * a hostile or merely broken endpoint put arbitrary text there. Output goes
 * through `textContent`, so there is no XSS path -- but an error page, a rate
 * limit notice, or a 10KB blob would still wreck the prompt, and "it can't
 * execute" is not a good enough reason to render untrusted text unchecked.
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isIpAddress(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_LEN) return false;

  // IPv4: four dot-separated octets, each 0-255, no leading zeros.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4 !== null) {
    return v4.slice(1).every((part) => {
      if (part.length > 1 && part.startsWith("0")) return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
  }

  // IPv6: hex groups separated by colons, with at most one "::" elision. Loose
  // but bounded -- it rejects anything that is not plausibly an address, which is
  // all this needs to do.
  if (!s.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  if ((s.match(/::/g) ?? []).length > 1) return false;
  const groups = s.split(":");
  if (groups.length > 8) return false;
  return groups.every((g) => g === "" || /^[0-9a-fA-F]{1,4}$/.test(g));
}

/**
 * @param {string} url
 * @returns {Promise<string>} raw body, or "" on any failure
 */
async function get(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      cache: "no-store",
      // No credentials, no referrer -- there is no reason to tell an IP-echo
      // service which page asked.
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return ""; // blocked, offline, timed out, CORS -- all the same to us
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<string | null>} a validated IP, or null if unavailable
 */
export async function resolveIp() {
  for (const { url, pick } of ENDPOINTS) {
    const body = await get(url);
    if (body === "") continue;
    let candidate = "";
    try {
      candidate = pick(body);
    } catch {
      continue; // malformed JSON
    }
    if (isIpAddress(candidate)) return candidate;
  }
  return null;
}
