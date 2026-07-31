#!/usr/bin/env python3
"""Does int4 damage this model enough to justify the hybrid scheme?

The plan committed to deciding this by measurement rather than by taste, with the
rule: ship all-int4 if perplexity on the actual system prompt degrades by no more
than 35%, otherwise ship the hybrid (int8 for the tied embedding/lm_head, int4 for
the transformer blocks) and pay the extra 15 MB.

Uses HuggingFace's own forward pass for every variant, so the only thing that
differs between measurements is the weights. A forward pass I wrote myself would
confound quantization error with my own bugs.

    tools/.venv/bin/python tools/quant_gate.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from convert import quantize_q4, quantize_q8, sqnr_db  # noqa: E402

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"
GROUP = 64
RATIO_THRESHOLD = 1.35

ROOT = Path(__file__).resolve().parent.parent


def perplexity(model, ids: torch.Tensor) -> float:
    """Perplexity of a single sequence, teacher-forced."""
    with torch.no_grad():
        out = model(ids, labels=ids)
    return float(torch.exp(out.loss))


def requantize(model, *, embed_bits: int, block_bits: int) -> dict[str, float]:
    """Quantize then dequantize every weight in place, returning per-tensor SQNR.

    Round-tripping through the quantizer and running HF's fp32 forward pass on the
    result isolates exactly the error the C engine will incur, without needing the
    C engine to exist yet.
    """
    sqnrs: dict[str, float] = {}

    def apply(param: torch.nn.Parameter, name: str, bits: int) -> None:
        w = param.detach().to(torch.float32).numpy()
        if w.ndim != 2 or w.shape[1] % GROUP != 0:
            return
        if bits == 8:
            _, _, deq = quantize_q8(w, GROUP)
        elif bits == 4:
            _, _, deq = quantize_q4(w, GROUP)
        else:
            return
        sqnrs[name] = sqnr_db(w, deq)
        param.data = torch.from_numpy(deq)

    for name, param in model.named_parameters():
        if "embed_tokens" in name:
            apply(param, name, embed_bits)
        elif "norm" in name:
            pass  # never quantized: 35 KB total and the most sensitive tensors
        elif param.ndim == 2:
            apply(param, name, block_bits)
    return sqnrs


def main() -> int:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.set_grad_enabled(False)
    prompt = (ROOT / "engine" / "tests" / "fixtures" / "prompt.txt").read_text()
    tok = AutoTokenizer.from_pretrained(REPO)
    ids = torch.tensor([tok(prompt)["input_ids"]])
    print(f"system prompt: {ids.shape[1]} tokens\n")

    def fresh():
        m = AutoModelForCausalLM.from_pretrained(REPO, dtype=torch.float32)
        m.eval()
        return m

    base = perplexity(fresh(), ids)
    print(f"  fp32                        ppl {base:8.4f}")

    results = {}
    for label, embed_bits, block_bits in (
        ("all-int4", 4, 4),
        ("hybrid (int8 embed)", 8, 4),
        ("all-int8", 8, 8),
    ):
        m = fresh()
        sqnrs = requantize(m, embed_bits=embed_bits, block_bits=block_bits)
        ppl = perplexity(m, ids)
        ratio = ppl / base
        worst = min(sqnrs.items(), key=lambda kv: kv[1])
        results[label] = (ppl, ratio)
        print(f"  {label:26s}  ppl {ppl:8.4f}   x{ratio:5.3f}   "
              f"worst SQNR {worst[1]:5.2f} dB  ({worst[0].split('.')[-2]})")
        del m

    print()
    q4_ratio = results["all-int4"][1]
    print(f"decision rule: all-int4 if ppl ratio <= {RATIO_THRESHOLD}")
    if q4_ratio <= RATIO_THRESHOLD:
        print(f"  all-int4 degrades perplexity x{q4_ratio:.3f} -> SHIP ALL-INT4 (~72 MB)")
        verdict = "q4"
    else:
        hy = results["hybrid (int8 embed)"][1]
        print(f"  all-int4 degrades perplexity x{q4_ratio:.3f}, over threshold")
        print(f"  hybrid degrades x{hy:.3f} -> SHIP HYBRID (~87 MB)")
        verdict = "hybrid"

    # Size arithmetic, so the cost of the decision is visible next to its benefit.
    embed_params = 49152 * 576
    block_params = 106_200_000
    mb = lambda n, bpp: n * bpp / 1e6
    q4_bpp, q8_bpp = 0.53125, 1.0625
    print()
    print(f"  all-int4 size  {mb(embed_params, q4_bpp) + mb(block_params, q4_bpp):5.1f} MB")
    print(f"  hybrid size    {mb(embed_params, q8_bpp) + mb(block_params, q4_bpp):5.1f} MB")
    print()
    print(f"VERDICT: {verdict}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
