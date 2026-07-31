# Measured performance

`make -C engine wasm wasm-scalar && node engine/tests/run_wasm.mjs --bench`
Model: SmolLM2-135M-Instruct, hybrid quantization (86.9 MB). One machine, 8 cores.

| build | decode | GFLOP/s | vs plan estimate |
|---|---|---|---|
| native fp32 | 22.6 tok/s | 6.1 | — |
| native hybrid | 103.1 tok/s | 27.7 | — |
| **wasm SIMD** | **99.1 tok/s** | **26.7** | planned ~18 tok/s / 5 GFLOP/s |
| wasm scalar | 21.1 tok/s | 5.7 | — |

## Two plan assumptions were wrong

**"wasm within ~3x of native" was the wrong shape of question.** wasm SIMD runs at
96% of native. There is no meaningful gap to measure: the same C, the same integer
kernels, and wasm engines JIT this well.

**SIMD is 4.6x faster than scalar wasm** (97.6 vs 21.1 tok/s), against a >=3x
target. The nibble-unpacking inner loop is exactly what LLVM's auto-vectorizer
does not produce on its own.

**The whole thing is ~5x faster than planned.** 26.7 GFLOP/s versus an estimated
5. Which means:

- The 351-token system prompt costs about **3.5 s** of prefill, not the ~19 s the
  plan's arithmetic implied. The token budget in tools/build_prompt.py was
  therefore tighter than it needed to be -- the 640-token verbatim version would
  cost ~6.3 s. Worth revisiting if prompt fidelity ever matters more than latency,
  though the KV snapshot means either is paid once per session.

- **The M13 fallback plan needs rethinking.** It assumed scalar wasm would be too
  slow to use and defaulted no-SIMD visitors straight to keyword search. But
  scalar decodes at 21 tok/s with ~17 s prefill -- roughly what the plan expected
  from SIMD, and perfectly usable. Those visitors should probably get the real
  model with a warning rather than being denied it.

## Bit-identical across targets

wasm and native produce the same tokens exactly, for both the SIMD and scalar
builds. That is by construction: the SIMD kernels do all their work in integer
arithmetic, which is exact and associative, so reassociating across lanes changes
nothing, and the float operations stay in scalar order.

It did not hold at first. The two builds agreed for 14 tokens and then diverged,
because native used libm's expf while wasm used the polynomial in expf_poly.h.
They differ in the last couple of bits, softmax runs 30 times per token, and a
near-tie eventually flips. Both targets now share the one expf -- which also means
every native test exercises it, rather than it only ever running in a browser.

## Size

| | |
|---|---|
| engine.simd.wasm | 20,177 bytes |
| engine.wasm | 17,531 bytes |
| imports | **zero** |

Zero imports is asserted by the harness. It means no import object is needed, no
accidental dependency on a JS callback is possible, and there is no reentrancy
hazard. Compare Emscripten: ~1 GB to install, 60-120 s of CI, and 100-300 KB of
module plus JS glue -- for a libc and a binding layer that nineteen functions
taking only i32 and f32 do not need.
