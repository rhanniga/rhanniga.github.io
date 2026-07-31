// @ts-check
/**
 * Syntax-coloured JSON, for `cat resume.json`.
 *
 * Produces exactly the line structure of `JSON.stringify(value, null, 2)`, so the
 * output is faithful to the file on disk rather than a prettier reinterpretation
 * of it.
 *
 * Deliberately does NOT hard-wrap long strings. A real terminal soft-wraps a long
 * `cat` line at the screen edge, and `.row` is `white-space: pre-wrap` with
 * `overflow-wrap: anywhere`, so the browser does the same thing. Hard-wrapping
 * would insert breaks that are not in the file.
 */

import { c, sp } from "./chunk.js";

/** @typedef {import('./chunk.js').Line} Line */
/** @typedef {import('./chunk.js').Chunk} Chunk */

const STEP = 2;

/**
 * @param {string} tail
 * @returns {Chunk[]}
 */
function comma(tail) {
  return tail === "" ? [] : [c(tail, "json-punct")];
}

/**
 * @param {unknown} v
 * @returns {Chunk[]}
 */
function scalar(v) {
  if (typeof v === "string") return [c(JSON.stringify(v), "json-string")];
  // Numbers, booleans and null all read as literals; nord15 for all three keeps
  // them visually distinct from strings without inventing a fourth colour.
  return [c(String(v), "json-number")];
}

/**
 * @param {unknown} v
 * @param {number} depth
 * @param {Chunk[]} lead   chunks preceding the value on its first line (a key)
 * @param {string} tail    "," when a sibling follows
 * @param {Line[]} out
 */
function emit(v, depth, lead, tail, out) {
  const pad = sp(depth * STEP);

  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push([pad, ...lead, c("[]", "json-punct"), ...comma(tail)]);
      return;
    }
    out.push([pad, ...lead, c("[", "json-punct")]);
    v.forEach((item, i) => {
      emit(item, depth + 1, [], i < v.length - 1 ? "," : "", out);
    });
    out.push([pad, c("]", "json-punct"), ...comma(tail)]);
    return;
  }

  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v);
    if (entries.length === 0) {
      out.push([pad, ...lead, c("{}", "json-punct"), ...comma(tail)]);
      return;
    }
    out.push([pad, ...lead, c("{", "json-punct")]);
    entries.forEach(([key, value], i) => {
      const keyLead = [c(JSON.stringify(key), "json-key"), c(": ", "json-punct")];
      emit(value, depth + 1, keyLead, i < entries.length - 1 ? "," : "", out);
    });
    out.push([pad, c("}", "json-punct"), ...comma(tail)]);
    return;
  }

  out.push([pad, ...lead, ...scalar(v), ...comma(tail)]);
}

/**
 * @param {unknown} value
 * @returns {Line[]}
 */
export function formatJson(value) {
  /** @type {Line[]} */
  const out = [];
  emit(value, 0, [], "", out);
  return out;
}
