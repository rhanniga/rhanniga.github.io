#!/usr/bin/env python3
"""resume.json -> the system prompt, and its token ids.

Built here rather than at runtime so the token count can be asserted in CI, the
prompt can be diffed in review, and the shipped KV-cache blob (a later
optimization) has something fixed to be a cache of.

Every prompt token costs about 54 ms of prefill on a desktop, so the budget is
real: 350 tokens is ~19 s before the first word, and the verbatim resume comes to
640 tokens, which is ~35 s. That constraint drives most of the rules below.

Emits:
    site/js/llm/prompt.js               the text and the pre-tokenized ids
    engine/tests/fixtures/prompt.txt    the rendered text, for eyeballing
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = "HuggingFaceTB/SmolLM2-135M-Instruct"

# The target, and a hard ceiling.
#
# Prefill runs at roughly 54 ms/token single-threaded on a desktop, so 350 tokens
# is ~19 s before the first word and 400 is ~22 s. The difference between 350 and
# 351 is noise; the difference between 350 and 640 (which the verbatim resume comes
# to) is whether anyone waits. So overshooting the target warns, and only the
# ceiling fails -- a build that breaks on one token would just get the threshold
# raised, which is worse than a warning that gets read.
TOKEN_TARGET = 350
TOKEN_CEILING = 400

ROOT = Path(__file__).resolve().parent.parent


def year(date: str) -> str:
    """Dates become years: month precision buys nothing and costs tokens."""
    if date == "Present":
        return "present"
    return date.split("-")[0]


def first_sentence(text: str) -> str:
    """The leading sentence, which in this resume carries most of the meaning."""
    for end in (". ", "; "):
        i = text.find(end)
        if i > 0:
            return text[: i + 1].strip()
    return text.strip()


def clip(text: str, limit: int) -> str:
    """Truncate at the last clause boundary that fits.

    Cutting at a word boundary leaves sentences trailing off -- "focusing on." and
    "performing multi-dimensional angular." both came out of the first version.
    A fragment like that is worse than no clause at all: it spends tokens and
    invites the model to complete the dangling thought.

    So prefer the last comma or semicolon before the limit, and fall back to a word
    boundary only when the clause itself is too long.
    """
    text = text.strip().rstrip(".")
    if len(text) <= limit:
        return text + "."
    window = text[:limit]
    for sep in (", ", "; ", " - ", " -- "):
        i = window.rfind(sep)
        # Require the clause to carry real content, not just a few words.
        if i > limit // 3:
            return window[:i].rstrip(",;- ") + "."
    return window.rsplit(" ", 1)[0] + "."


def build_system(resume: dict, *, bullets_per_job: int = 2,
                 bullet_chars: int = 130) -> str:
    """Flatten the resume into dense prose.

    Rules, in the order they matter:

    1. **Never show it JSON.** A 135M model that sees `{"jobs": [...]}` will
       cheerfully continue emitting JSON instead of answering.
    2. **No phone number or email address.** A stochastic model reciting a phone
       number is PII amplification and scraper bait, and it will get digits wrong.
       The deterministic `contact` command exists for exactly this.
    3. **Stay inside the token budget.** The verbatim resume comes to 640 tokens,
       which is 35 s of prefill on a desktop and 85 s on a phone -- long enough that
       nobody waits. So bullets are clipped and education details dropped.
    4. **Still derived from resume.json**, rather than hand-written prose that
       would silently drift from it. Clipping loses fidelity the model could not
       have exploited anyway: what it needs is dense facts, not paragraphs.
    5. Drop the keywords arrays -- a relevance signal for the offline fallback, not
       content.
    """
    ci = resume["contactInfo"]
    name = ci["name"]

    lines: list[str] = []
    lines.append(
        f"Answer questions about {name} using only the facts below, in one or two "
        f"short sentences. If the facts do not cover the question, say so. For "
        f"contact details, say to run `contact`."
    )
    lines.append("")
    lines.append("FACTS:")

    for s in resume.get("summaries", []):
        # Clipped as well as reduced to one sentence. The tail of this summary is
        # generic ("specializing in innovative software development and
        # leadership") and duplicates, less concretely, what the job entries below
        # state as fact -- so it is the weakest value-per-token line in the prompt.
        lines.append(clip(first_sentence(s["text"]), 140))

    # Skills are compact and answer a very common question, so they earn their
    # tokens more than any single bullet does.
    tiers: dict[str, list[str]] = {}
    for skill in resume.get("skills", []):
        tiers.setdefault(skill["experience"], []).append(skill["name"])
    parts = [f"{t} in {', '.join(tiers[t])}" for t in
             ("expert", "experienced", "skilled") if t in tiers]
    if parts:
        lines.append("Skills: " + "; ".join(parts) + ".")

    for job in resume.get("jobs", []):
        span = f"{year(job['startDate'])}-{year(job['endDate'])}"
        head = f"{span} {job['title']}, {job['company']} ({job['location']})."
        body = " ".join(clip(b["text"], bullet_chars)
                        for b in job["bullets"][:bullets_per_job])
        lines.append(f"{head} {body}".strip())

    for ed in resume.get("educations", []):
        # Degree, field and institution only. GPA and fellowships are what the
        # `education` command is for, and they are not what people ask a chatbot.
        lines.append(
            f"{year(ed['endDate'])} {ed['degree']} in {ed['fieldOfStudy']}, "
            f"{ed['institution']}."
        )

    hobbies = [h for h in resume.get("hobbies", []) if not h["text"].startswith("TODO")]
    if hobbies:
        parts = [f"{h['name']}: {clip(h['text'], 90)}" if h.get("name")
                 else clip(h["text"], 90) for h in hobbies]
        lines.append("Outside work: " + " ".join(parts))

    lines.append(f"Website {ci['website']}, GitHub {ci['github']}.")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", type=Path, default=ROOT / "site" / "resume.json")
    ap.add_argument("--out", type=Path, default=ROOT / "site" / "js" / "llm" / "prompt.js")
    ap.add_argument("--text-out", type=Path,
                    default=ROOT / "engine" / "tests" / "fixtures" / "prompt.txt")
    ap.add_argument("--no-tokenize", action="store_true",
                    help="skip tokenization (does not need transformers)")
    args = ap.parse_args()

    resume = json.loads(args.resume.read_text())
    system = build_system(resume)

    ids: list[int] | None = None
    rendered: str | None = None
    if not args.no_tokenize:
        from transformers import AutoTokenizer

        tok = AutoTokenizer.from_pretrained(REPO)
        # Let HuggingFace render the chat template. Hand-encoding ChatML is a
        # reliable way to get a subtly wrong prompt, and this output is also the
        # fixture the JS tokenizer is tested against.
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": "PLACEHOLDER"},
        ]
        rendered = tok.apply_chat_template(messages, tokenize=False,
                                           add_generation_prompt=True)
        enc = tok.apply_chat_template([messages[0]], tokenize=True,
                                      add_generation_prompt=False)
        # transformers 5.x returns a BatchEncoding here, not a bare list, so
        # len() on it silently yields the number of *keys* -- which reads as a
        # 2-token prompt and looks like the budget is fine.
        #
        # Tested with hasattr rather than isinstance(dict): BatchEncoding is a
        # UserDict, which is NOT a dict subclass, so the isinstance check silently
        # never fires.
        if hasattr(enc, "keys"):
            enc = enc["input_ids"]
        if enc and isinstance(enc[0], list):
            enc = enc[0]
        ids = list(enc)

    n = len(ids) if ids is not None else -1
    print(f"system prompt: {len(system)} chars, {n} tokens "
          f"(target {TOKEN_TARGET}, ceiling {TOKEN_CEILING})")
    if ids is not None:
        print(f"  ~{n * 0.054:.1f}s of prefill on a desktop at ~5 GFLOP/s")
        if n > TOKEN_CEILING:
            print(f"  OVER CEILING by {n - TOKEN_CEILING} tokens -- failing")
        elif n > TOKEN_TARGET:
            print(f"  {n - TOKEN_TARGET} over the {TOKEN_TARGET}-token target "
                  f"(within the {TOKEN_CEILING} ceiling)")

    args.text_out.parent.mkdir(parents=True, exist_ok=True)
    args.text_out.write_text(system + "\n")

    body = [
        "// @ts-check",
        "/* GENERATED by tools/build_prompt.py -- do not edit.",
        " *",
        " * The system prompt, built from resume.json at author time so its token",
        " * count is reviewable and assertable. Phone and email are deliberately",
        " * absent: a stochastic model reciting a phone number is PII amplification",
        " * and it would get the digits wrong. `contact` serves those instead.",
        " */",
        "",
        f"/** {n} tokens. Target {TOKEN_TARGET}, hard ceiling {TOKEN_CEILING} --",
        f" *  at ~54ms/token that is ~{n * 0.054:.0f}s of prefill before the first word,",
        " *  paid once per session thanks to the KV snapshot. */",
        f"export const SYSTEM_PROMPT_TOKENS = {n};",
        "",
        "export const SYSTEM_PROMPT = " + json.dumps(system) + ";",
        "",
    ]
    if ids is not None:
        body += [
            "/* Pre-tokenized by HuggingFace's own tokenizer, so the browser does not",
            " * have to reproduce the chat template -- and so the JS tokenizer has a",
            " * fixture to be checked against. */",
            "export const SYSTEM_PROMPT_IDS = new Int32Array(["
            + ", ".join(str(i) for i in ids)
            + "]);",
            "",
        ]
    if rendered is not None:
        body += [
            "/** The full ChatML rendering, with the question slot marked. */",
            "export const CHAT_TEMPLATE = " + json.dumps(rendered) + ";",
            "",
        ]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text("\n".join(body))
    print(f"  wrote {args.out.relative_to(ROOT)} and {args.text_out.relative_to(ROOT)}")

    # Written first, so an over-budget prompt can still be inspected -- then fail,
    # because silently shipping a 640-token prompt means 35 s before the first word
    # and nobody waits that long.
    if ids is not None and n > TOKEN_CEILING:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
