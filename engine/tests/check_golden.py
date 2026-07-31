#!/usr/bin/env python3
"""Compare the native engine against the PyTorch reference.

    engine/tests/check_golden.py --engine ./engine --model /path/f32.hslm

Exits nonzero on any mismatch. Argmax must be exact at every position -- a single
wrong token is a wrong model -- and the top logits must agree to the tolerance
recorded in golden.json.

When the trace-instrumented binary is used, per-layer checksums are compared too,
which turns "the logits are wrong" into "layer 7 is where it diverges".
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def rel(a: float, b: float) -> float:
    """Relative difference, guarded for near-zero references."""
    scale = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / scale


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", default=str(HERE.parent / "engine"))
    ap.add_argument("--model", required=True)
    ap.add_argument("--golden", default=str(HERE / "fixtures" / "golden.json"))
    ap.add_argument("--tokens", default=str(HERE / "fixtures" / "tokens_12.txt"))
    ap.add_argument("--ctx", default="1024")
    args = ap.parse_args()

    golden = json.loads(Path(args.golden).read_text())
    tol = float(golden["tolerance"]["max_abs_logit_diff"])

    cmd = [args.engine, "--model", args.model, "--tokens", args.tokens,
           "--ctx", args.ctx, "--dump-logits"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(f"engine exited {proc.returncode}\n{proc.stderr}", file=sys.stderr)
        return 1
    try:
        got = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        print(f"engine output is not JSON: {e}\n{proc.stdout[:2000]}", file=sys.stderr)
        return 1

    failures = 0

    # ── Argmax, which must be exact ────────────────────────────────────────
    print("pos  token   ref->argmax   engine        max|dlogit|  status")
    for ref, mine in zip(golden["positions"], got["positions"], strict=True):
        assert ref["pos"] == mine["pos"]
        diffs = [abs(a - b) for a, b in zip(ref["top_logits"], mine["top_logits"])]
        worst = max(diffs)
        ok_argmax = ref["argmax"] == mine["argmax"]
        ok_logits = worst <= tol
        status = "ok" if (ok_argmax and ok_logits) else "FAIL"
        if not (ok_argmax and ok_logits):
            failures += 1
        print(f"{ref['pos']:3d}  {ref['token']:6d}  {ref['argmax']:11d}   "
              f"{mine['argmax']:<11d}   {worst:10.5f}   {status}"
              + ("" if ok_argmax else "  <-- ARGMAX DIFFERS"))

    # Also compare the top-id ordering, which catches a systematic bias that
    # happens to preserve the winner.
    for ref, mine in zip(golden["positions"], got["positions"], strict=True):
        if ref["top_ids"][:5] != mine["top_ids"][:5]:
            print(f"  pos {ref['pos']}: top-5 ordering differs\n"
                  f"    ref    {ref['top_ids'][:5]}\n"
                  f"    engine {mine['top_ids'][:5]}")
            failures += 1

    # ── Per-layer bisection, when the trace build was used ─────────────────
    trace = {(t["name"], t["layer"]): t for t in got.get("trace", [])}
    if trace:
        print("\nlayer checksums (sum_sq, relative):")
        hidden = golden["hidden_states"]

        def compare(label: str, ref: dict, key: tuple[str, int]) -> None:
            nonlocal failures
            t = trace.get(key)
            if t is None:
                return
            d = rel(ref["sum_sq"], t["sum_sq"])
            mark = "ok" if d < 1e-3 else "FAIL"
            if d >= 1e-3:
                failures += 1
            print(f"  {label:22s} ref {ref['sum_sq']:14.4f}  "
                  f"engine {t['sum_sq']:14.4f}  rel {d:.2e}  {mark}")

        # hidden_states[0] is the embedding output; [i] for i in 1..29 is the
        # output of layer i-1. HF's last entry, [30], is AFTER the final norm --
        # the output of layer 29 never appears in its tuple.
        compare("embeddings", hidden[0], ("embed", 0))
        for i in range(1, len(hidden) - 1):
            compare(f"after layer {i - 1}", hidden[i], ("layer_out", i - 1))
        compare("after final norm", hidden[-1], ("final_norm", 0))

        for name in ("layer0_attn_out", "layer0_mlp_out"):
            if name in golden.get("layer0", {}):
                compare(name, golden["layer0"][name], (name, 0))

    print()
    if failures:
        print(f"FAILED: {failures} mismatch(es)")
        return 1
    print("PASS: argmax exact at every position, logits within tolerance")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
