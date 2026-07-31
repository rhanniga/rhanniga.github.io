// @ts-check
/**
 * Run the wasm engine under node and check it against the native build.
 *
 * Node is the right place for this: it has full WebAssembly SIMD, a debugger, and
 * no browser. Finding a SIMD bug in a browser tab, where the only symptom is
 * "answers seem slightly worse", would be close to impossible.
 *
 *   node engine/tests/run_wasm.mjs --model <path.hslm> [--native ./engine] [--bench]
 *
 * The comparison is token-for-token, not approximate, and that is deliberate. The
 * SIMD kernels do all their work in INTEGER arithmetic -- exact and associative --
 * and leave the float operations in scalar order, so the two builds must agree
 * bit-for-bit on a quantized model. "Close enough" would hide exactly the class of
 * bug this exists to catch.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const wasmPath = String(args["wasm"] ?? resolve(HERE, "../../site/ask/engine.simd.wasm"));
const modelPath = args["model"];
const nativePath = args["native"];
const nCtx = Number(args["ctx"] ?? 256);
const steps = Number(args["steps"] ?? 20);
const bench = Boolean(args["bench"]);

if (typeof modelPath !== "string") {
  console.error("usage: run_wasm.mjs --model <path.hslm> [--wasm f] [--native ./engine] [--bench]");
  process.exit(2);
}

let failures = 0;
/** @param {boolean} cond @param {string} what */
function check(cond, what) {
  console.log(`  ${what.padEnd(56)} ${cond ? "ok" : "FAIL"}`);
  if (!cond) failures++;
}

/* ── Instantiate ─────────────────────────────────────────────────────────── */

const wasmBytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(wasmBytes);

console.log(`wasm module  ${wasmPath.split("/").pop()}  ${wasmBytes.length} bytes`);

const imports = WebAssembly.Module.imports(module);
check(imports.length === 0,
  `zero imports (found ${imports.length}${imports.length ? ": " + imports.map((i) => `${i.module}.${i.name}`).join(", ") : ""})`);
check(wasmBytes.length < 204800, `under 200KB (${wasmBytes.length})`);

// No import object at all -- possible precisely because there are no imports and
// memory is exported rather than imported.
const instance = new WebAssembly.Instance(module);
const ex = /** @type {Record<string, any>} */ (instance.exports);

const exported = Object.keys(ex).sort();
check(exported.includes("memory"), "memory is exported");
for (const fn of ["ml_alloc", "ml_init", "ml_forward", "ml_logits", "ml_sample",
                  "ml_n_vocab", "ml_shutdown", "ml_kv_save", "ml_kv_load"]) {
  check(typeof ex[fn] === "function", `exports ${fn}`);
}

/* ── Heap views ──────────────────────────────────────────────────────────
 * memory.grow DETACHES every existing TypedArray over memory.buffer. Every access
 * therefore goes through these accessors, which rebuild on a buffer identity
 * change. The plan flagged this as the single most likely JS-side bug, and it is
 * silent when you get it wrong: reads return zeroes and writes go nowhere. */
/** @type {ArrayBuffer | null} */
let cached = null;
/** @type {Uint8Array} */
let heapU8 = new Uint8Array(0);

function refreshHeap() {
  const buf = /** @type {WebAssembly.Memory} */ (ex["memory"]).buffer;
  if (buf !== cached) {
    cached = buf;
    heapU8 = new Uint8Array(buf);
  }
}

/* ── Load the model ──────────────────────────────────────────────────────── */

const modelBytes = readFileSync(modelPath);
const ptr = ex["ml_alloc"](modelBytes.length);
check(ptr !== 0, `ml_alloc(${(modelBytes.length / 1e6).toFixed(1)} MB) succeeded`);
if (ptr === 0) process.exit(1);

// ml_alloc just grew memory, so any view taken before now is detached.
refreshHeap();
heapU8.set(modelBytes, ptr);

const rc = ex["ml_init"](ptr, modelBytes.length, nCtx);
check(rc === 0, `ml_init returned ML_OK (got ${rc})`);
if (rc !== 0) process.exit(1);

const nVocab = ex["ml_n_vocab"]();
check(nVocab > 0, `n_vocab = ${nVocab}`);

/* ── Greedy generation ───────────────────────────────────────────────────── */

const tokens = readFileSync(resolve(HERE, "fixtures/tokens_12.txt"), "utf8")
  .split(/\s+/)
  .filter((s) => s !== "")
  .map(Number);

ex["ml_seed"](1234, 0);

const t0 = process.hrtime.bigint();
for (let pos = 0; pos < tokens.length; pos++) ex["ml_forward"](tokens[pos], pos);
const prefillNs = process.hrtime.bigint() - t0;

/** Greedy: temp 0, and the repetition penalty matched to the native default. */
const generated = [];
const t1 = process.hrtime.bigint();
{
  let pos = tokens.length;
  let token = ex["ml_sample"](0.0, 0.9, 40, 1.1, 64);
  const eos = ex["ml_eos_id"]();
  for (let i = 0; i < steps && pos < nCtx; i++, pos++) {
    generated.push(token);
    if (token === eos) break;
    ex["ml_forward"](token, pos);
    token = ex["ml_sample"](0.0, 0.9, 40, 1.1, 64);
  }
}
const decodeNs = process.hrtime.bigint() - t1;

console.log(`\n  wasm generated: [${generated.join(", ")}]`);

/* ── Compare with native ─────────────────────────────────────────────────── */

if (typeof nativePath === "string") {
  const stdout = execFileSync(nativePath, [
    "--model", modelPath,
    "--tokens", resolve(HERE, "fixtures/tokens_12.txt"),
    "--steps", String(steps),
    "--temp", "0",
    "--seed", "1234",
    "--ctx", String(nCtx),
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  const nativeTokens = stdout.split(/\s+/).filter((s) => s !== "").map(Number);
  console.log(`  native generated: [${nativeTokens.join(", ")}]`);

  const same = generated.length === nativeTokens.length &&
    generated.every((t, i) => t === nativeTokens[i]);
  console.log();
  check(same, "wasm matches native token-for-token");
  if (!same) {
    for (let i = 0; i < Math.max(generated.length, nativeTokens.length); i++) {
      if (generated[i] !== nativeTokens[i]) {
        console.log(`    first divergence at index ${i}: `
          + `wasm ${generated[i]} vs native ${nativeTokens[i]}`);
        break;
      }
    }
  }
}

/* ── Bench ───────────────────────────────────────────────────────────────── */

if (bench) {
  const prefillMs = Number(prefillNs) / 1e6;
  const decodeMs = Number(decodeNs) / 1e6;
  console.log();
  console.log(`  prefill ${tokens.length} tok in ${prefillMs.toFixed(1)}ms `
    + `= ${(tokens.length / (prefillMs / 1000)).toFixed(1)} tok/s`);
  if (generated.length > 0) {
    const rate = generated.length / (decodeMs / 1000);
    console.log(`  decode  ${generated.length} tok in ${decodeMs.toFixed(1)}ms `
      + `= ${rate.toFixed(1)} tok/s`);
    // 2 * (106.2M non-embedding + 28.3M lm_head) FLOP per decoded token.
    console.log(`  ~${((rate * 269e6) / 1e9).toFixed(1)} GFLOP/s`);
  }
}

ex["ml_shutdown"]();

console.log();
console.log(failures === 0 ? "PASS" : `FAILED: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
