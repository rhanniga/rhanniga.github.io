#!/usr/bin/env python3
"""Generate tokenizer fixtures from HuggingFace's own tokenizer.

The JavaScript tokenizer has to agree with this one EXACTLY. There is no tolerance
to trade against: a single wrong merge rule shifts every subsequent token, and the
model then reads a subtly different prompt from the one intended. The symptom would
be "answers are a bit worse", which is close to undiagnosable.

Cases are chosen to hit the things most likely to differ between a Rust
implementation and a JavaScript one -- whitespace runs, digits (which this tokenizer
splits individually), the contraction alternatives in the split regex, astral-plane
characters, and the 21 bytes that have no vocabulary entry.

    tools/make_fixtures.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"
ROOT = Path(__file__).resolve().parent.parent


def cases() -> list[str]:
    out: list[str] = []

    # ── Trivial ──────────────────────────────────────────────────────────
    out += ["", " ", "a", "A", "  ", "\n", "\t", "\n\n", " \n ", "hello",
            "Hello", "HELLO", "hello world", " hello", "hello ", " hello "]

    # ── Whitespace runs, which the `\\s+(?!\\S)` alternative governs ────────
    out += ["a  b", "a   b", "a\tb", "a\nb", "a \n b", "  leading", "trailing  ",
            "\n\n\nmany", "many\n\n\n", "a\n\nb", " \t \n ", "a" + " " * 20 + "b"]

    # ── Digits: split individually by the Digits pre-tokenizer ───────────
    out += ["0", "1", "9", "10", "42", "100", "2023", "2023-2025", "3.14",
            "1,000", "$250,000", "v1.2.3", "PHY302K", "8+", "50%", "10x",
            "1e-9", "0x1F", "2018-2022", "1st", "22nd", "1/2", "-1", "+1",
            "1234567890", "0.0001", "1_000_000"]

    # ── The contraction alternatives, in regex order ──────────────────────
    out += ["it's", "don't", "they're", "we've", "I'm", "he'll", "she'd",
            "IT'S", "It's", "'s", "'t alone", "y'all", "o'clock",
            "can't won't shan't", "rock'n'roll", "'''", "it''s"]

    # ── Punctuation and symbols ──────────────────────────────────────────
    out += ["C++", "C#", "a.b", "a,b", "a;b", "a:b", "(a)", "[a]", "{a}",
            "a/b", "a\\b", "a|b", "a-b", "a_b", "a=b", "a<b>c", "!!!", "???",
            "...", "--", "->", "=>", "::", "@", "#", "$", "%", "^", "&", "*",
            "~", "`", '"quoted"', "'single'", "«guillemets»", "—em dash—"]

    # ── Unicode ──────────────────────────────────────────────────────────
    out += ["café", "naïve", "Zürich", "Meyrin", "über", "señor", "ÅÄÖ",
            "Ω", "π", "µ", "°C", "½", "²", "³", "Ⅻ",
            "日本語", "中文", "한국어", "Привет", "مرحبا", "שלום",
            "ελληνικά", "ไทย", "हिन्दी"]

    # ── Astral plane: two UTF-16 code units each ─────────────────────────
    out += ["🎉", "a🎉b", "🎉🎉🎉", "👨‍👩‍👧", "🇬🇧", "🏳️‍🌈",
            "é", "é", "́", "à́b", "𝓗𝓮𝓵𝓵𝓸", "𠀋"]

    # ── The 17 special tokens, alone and embedded ────────────────────────
    specials = ["<|endoftext|>", "<|im_start|>", "<|im_end|>", "<repo_name>",
                "<reponame>", "<file_sep>", "<filename>", "<gh_stars>",
                "<issue_start>", "<issue_comment>", "<issue_closed>",
                "<jupyter_start>", "<jupyter_text>", "<jupyter_code>",
                "<jupyter_output>", "<jupyter_script>", "<empty_output>"]
    out += specials
    out += [f"before{s}after" for s in specials[:5]]
    out += ["<|im_start|>system\nhi<|im_end|>\n",
            "<|im_start|><|im_end|>",
            "<|im_start|>" * 3,
            "not <|a special|> token",
            "<|im_start", "im_end|>", "<>", "<||>"]

    # ── Bytes with no vocabulary entry (silently dropped by HF) ──────────
    for b in (4, 6, 19, 20, 22, 29):
        out.append(f"a{chr(b)}b")
    out += ["a\x00b", "a\x01b", "a\x1fb", "a\x7fb", "\x00", "\x04\x06\x13"]

    # ── Resume content, which is what actually gets tokenized ────────────
    out += [
        "Dr. Ryan Hannigan",
        "University of Texas at Austin",
        "ALICE at CERN (Meyrin, Switzerland)",
        "Principal Software Engineer, VenHub (Pasadena, CA).",
        "2018-2022 Software Engineer, ALICE at CERN",
        "Skills: expert in Python, Problem Solving, Leadership",
        "strange and heavy-flavor quark production at the LHC",
        "picosecond timing resolution and high-throughput data transfers",
        "Developed early software infrastructure, including microcontroller firmware (C++).",
        "Recipient of Graduate Provost's Excellence Fellowship, valued over $250,000",
        "Taught full semester of PHY302K, an introductory physics course",
        "Website hannigan.sh, GitHub rhanniga.",
        "Python/FastAPI",
        "Python/PyTorch/torchvision",
        "TypeScript/React/React Native",
        "hannigan.sh",
        "rhanniga",
        "Where did Ryan get his PhD?",
        "What did he do at CERN?",
        "what programming languages does he know?",
        "how can I contact him",
    ]

    # ── Adversarial ──────────────────────────────────────────────────────
    out += [
        "a" * 200,
        " " * 50,
        "ab" * 100,
        "\n" * 20,
        "the " * 60,
        "aardvark antidisestablishmentarianism pneumonoultramicroscopicsilicovolcanoconiosis",
        "ZZZZZZZZZZZZ",
        "qqqqqqqqqqqq",
        "🎉" * 20,
        "café" * 30,
        "0123456789" * 10,
        "​", " ", "﻿", " ", " ",
        "a​b", "a b",
        "\r", "\r\n", "a\r\nb",
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path,
                    default=ROOT / "tests" / "fixtures" / "tokenizer-cases.json")
    args = ap.parse_args()

    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(REPO)

    texts = cases()
    # The exact rendered system prompt: the single most important case, since it is
    # what actually goes into the model on every question.
    system = (ROOT / "engine" / "tests" / "fixtures" / "prompt.txt").read_text().strip()
    texts.append(system)
    texts.append(
        tok.apply_chat_template(
            [{"role": "system", "content": system},
             {"role": "user", "content": "Where did Ryan get his PhD?"}],
            tokenize=False, add_generation_prompt=True,
        )
    )

    # Deduplicate while preserving order, so a case added twice does not inflate
    # the count.
    seen = set()
    unique = []
    for t in texts:
        if t not in seen:
            seen.add(t)
            unique.append(t)

    fixtures = []
    for text in unique:
        ids = tok(text, add_special_tokens=False)["input_ids"]
        fixtures.append({"text": text, "ids": ids})

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "_comment": (
            "GENERATED by tools/make_fixtures.py from HuggingFace's own tokenizer. "
            "The JavaScript tokenizer must reproduce every id sequence EXACTLY -- "
            "one wrong merge shifts everything after it and the model silently reads "
            "a different prompt."
        ),
        "repo": REPO,
        "count": len(fixtures),
        "cases": fixtures,
    }, ensure_ascii=False, indent=1) + "\n")

    total = sum(len(f["ids"]) for f in fixtures)
    print(f"wrote {args.out.relative_to(ROOT)}")
    print(f"  {len(fixtures)} cases, {total} tokens total")
    print(f"  {args.out.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
