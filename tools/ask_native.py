#!/usr/bin/env python3
"""Ask the native engine a question. The go/no-go harness for M9.

The whole `ask` feature rests on one question: can a 135M model, quantized to
roughly 4 bits, answer something about this resume correctly? That is answerable
here, with a C binary and a Python tokenizer, before any WebAssembly exists and
before anyone downloads 87 MB.

    tools/ask_native.py --model /path/hybrid.hslm "where did you go to school?"
    tools/ask_native.py --model /path/hybrid.hslm --suite

Tokenization is Python's job here because the shipped tokenizer is JavaScript
(M11) and the engine deliberately has none -- its entire input surface is an array
of token ids, which is exactly what makes it testable like this.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"
ROOT = Path(__file__).resolve().parent.parent

# Questions with checkable answers. Each entry is (question, [acceptable
# substrings]) -- the model does not have to phrase it any particular way, it has
# to get the fact right.
SUITE = [
    ("Where did Ryan get his PhD?", ["Texas", "Austin"]),
    ("What did he do at CERN?", ["ALICE", "C++", "detector", "hardware"]),
    ("What programming languages does he know?", ["Python", "C++", "Rust"]),
    ("Where does he teach?", ["Austin", "UT", "Texas"]),
    ("What was his job at VenHub?", ["Engineer", "software", "infrastructure"]),
    ("What is his phone number?", None),  # must NOT answer: it is not in the prompt
]


def build_prompt_ids(tok, system: str, question: str) -> list[int]:
    """Render the ChatML prompt and tokenize it.

    HuggingFace applies its own chat template, because hand-encoding ChatML is a
    reliable way to produce a subtly wrong prompt -- and this is the same path
    build_prompt.py uses, so the two cannot drift.
    """
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": question},
    ]
    enc = tok.apply_chat_template(messages, tokenize=True, add_generation_prompt=True)
    # BatchEncoding is a UserDict, not a dict, so hasattr rather than isinstance.
    if hasattr(enc, "keys"):
        enc = enc["input_ids"]
    if enc and isinstance(enc[0], list):
        enc = enc[0]
    return list(enc)


def run(engine: Path, model: Path, ids: list[int], steps: int, temp: float,
        seed: int, ctx: int) -> tuple[list[int], float]:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        f.write("\n".join(str(i) for i in ids) + "\n")
        tokens_path = f.name
    try:
        started = time.time()
        proc = subprocess.run(
            [str(engine), "--model", str(model), "--tokens", tokens_path,
             "--steps", str(steps), "--temp", str(temp), "--seed", str(seed),
             "--ctx", str(ctx)],
            capture_output=True, text=True,
        )
        elapsed = time.time() - started
    finally:
        Path(tokens_path).unlink(missing_ok=True)

    if proc.returncode != 0:
        print(proc.stderr, file=sys.stderr)
        raise SystemExit(f"engine exited {proc.returncode}")
    out = [int(line) for line in proc.stdout.split() if line.strip()]
    return out, elapsed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="*", default=None)
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--engine", type=Path, default=ROOT / "engine" / "engine")
    ap.add_argument("--steps", type=int, default=60)
    ap.add_argument("--temp", type=float, default=0.0, help="0 = greedy")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--ctx", type=int, default=1024)
    ap.add_argument("--suite", action="store_true", help="run the go/no-go suite")
    args = ap.parse_args()

    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(REPO)
    system = (ROOT / "engine" / "tests" / "fixtures" / "prompt.txt").read_text().strip()
    eos = {0, 2}  # <|endoftext|>, <|im_end|>

    def ask(question: str) -> tuple[str, int, float]:
        ids = build_prompt_ids(tok, system, question)
        out, elapsed = run(args.engine, args.model, ids, args.steps, args.temp,
                           args.seed, args.ctx)
        kept = []
        for t in out:
            if t in eos:
                break
            kept.append(t)
        return tok.decode(kept).strip(), len(ids), elapsed

    if args.suite:
        print(f"model  {args.model.name}")
        print(f"greedy decode, {args.steps} max tokens\n")
        passes = failures = 0
        for question, expect in SUITE:
            answer, n_prompt, elapsed = ask(question)
            print(f"  Q: {question}")
            print(f"  A: {answer if answer else '(empty)'}")
            if expect is None:
                # Must NOT invent a phone number. The prompt deliberately omits it,
                # so any long digit run here is fabrication.
                import re
                bad = re.search(r"\d[\d\s().-]{6,}", answer)
                ok = bad is None
                print(f"     must not fabricate a number: {'ok' if ok else 'FABRICATED ' + bad.group()}")
            else:
                hits = [e for e in expect if e.lower() in answer.lower()]
                ok = len(hits) > 0
                print(f"     wanted any of {expect} -> {'found ' + str(hits) if hits else 'NONE'}")
            passes += ok
            failures += not ok
            print(f"     {n_prompt} prompt tokens, {elapsed:.2f}s\n")
        print(f"{passes}/{passes + failures} answered acceptably")
        return 0 if failures == 0 else 1

    question = " ".join(args.question) if args.question else "Who is Ryan Hannigan?"
    answer, n_prompt, elapsed = ask(question)
    print(f"Q: {question}")
    print(f"A: {answer}")
    print(f"\n({n_prompt} prompt tokens, {elapsed:.2f}s total)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
