#!/usr/bin/env python3
"""Flatten site/resume.json into the grep-mode retrieval corpus.

Grep-mode answers questions by returning the most relevant piece of the resume
verbatim, and it needs the resume cut into retrievable units with their context
attached. A bullet on its own reads as a fragment; the same bullet labelled
"Software Engineer, ALICE at CERN (2018-2022)" reads as an answer.

Generated rather than hand-written because resume.json is the single source of
truth -- and because the `keywords` arrays already in the data are a curated
relevance signal that would rot if it were copied by hand.

Usage:
    python3 tools/build_cards.py            # writes site/js/llm/cards.js
    python3 tools/build_cards.py --check    # verifies the committed file is current
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESUME = ROOT / "site" / "resume.json"
OUT = ROOT / "site" / "js" / "llm" / "cards.js"

HEADER = """// @ts-check
/**
 * The grep-mode retrieval corpus. GENERATED -- do not edit.
 *
 * Regenerate with `python3 tools/build_cards.py` after changing resume.json; CI
 * runs `--check` and fails if this file is stale.
 *
 * One card per retrievable unit: each job bullet, each education bullet, each
 * summary, each hobby, plus one card for the skills list and one per job as a
 * whole. `title` is the context a bullet needs to read as an answer rather than a
 * fragment; `keywords` is the curated relevance signal from resume.json, which
 * fallback.js boosts 3x.
 *
 * @typedef {object} Card
 * @property {string} id
 * @property {'summary'|'job'|'bullet'|'education'|'skills'|'hobby'} kind
 * @property {string} title    Context line, e.g. "Software Engineer, ALICE at CERN".
 * @property {string} [meta]   Dates, location -- shown after the title.
 * @property {string} text     The verbatim resume content.
 * @property {string[]} keywords   Curated in resume.json. Boosted 3x.
 * @property {string[]} [aliases]  Generated search aliases; see EXTRA_KEYWORDS.
 * @property {string} [see]    A command that shows more, e.g. "experience".
 */

/** @type {Card[]} */
export const CARDS = """

FOOTER = ";\n"


# Retrieval aliases: words a visitor uses that appear nowhere in the resume.
#
# "What languages does he know" cannot match the skills card by any amount of
# scoring, because the resume says "Python" and "C++" and never "languages". The
# alternative was a query-side synonym map pointing `languages -> python`, which
# also drags in every bullet mentioning Python and outranks the skills card itself.
#
# Attaching them per card kind keeps the fix where the knowledge is, and separate
# from `keywords` so it stays obvious which came from resume.json and which are
# generated for search.
EXTRA_KEYWORDS: dict[str, list[str]] = {
    "summary": ["summary", "about", "overview", "bio", "background"],
    "job": ["work", "job", "role", "position", "employer", "career", "experience"],
    "education": ["school", "university", "college", "education", "degree", "studied", "study"],
    "skills": ["skills", "languages", "language", "programming", "technologies", "tech", "stack", "tools"],
    "hobby": ["hobby", "hobbies", "interests"],
}


def year(date: str) -> str:
    """2018-01-01 -> 2018. Present/empty stays empty."""
    return date[:4] if date and date[0].isdigit() else ""


def span(start: str, end: str) -> str:
    """A human date span, matching how `experience` renders it."""
    a, b = year(start), year(end)
    if not a and not b:
        return ""
    if not b:
        return f"{a}-present"
    return a if a == b else f"{a}-{b}"


def build(resume: dict) -> list[dict]:
    cards: list[dict] = []

    for i, s in enumerate(resume.get("summaries", [])):
        cards.append(
            {
                "id": f"summary-{i}",
                "kind": "summary",
                "title": "Summary",
                "text": s["text"],
                "keywords": list(s.get("keywords", [])),
                "see": "summary",
            }
        )

    for j, job in enumerate(resume.get("jobs", [])):
        # Comma, not " at ": company is already "ALICE at CERN" for one of these,
        # and "Software Engineer at ALICE at CERN" reads badly.
        title = f"{job['title']}, {job['company']}"
        meta_bits = [b for b in (job.get("location", ""), span(job.get("startDate", ""), job.get("endDate", ""))) if b]
        meta = ", ".join(meta_bits)

        # The job as a whole, so "where does he work?" matches a company and title
        # rather than whichever bullet happens to share the most words.
        cards.append(
            {
                "id": f"job-{j}",
                "kind": "job",
                "title": title,
                "meta": meta,
                "text": title + (f" ({meta})" if meta else ""),
                # The title words are the signal here; a job card has no curated
                # keywords of its own, so seed them from its own fields.
                "keywords": [job["title"], job["company"]] + ([job["location"]] if job.get("location") else []),
                "see": "experience",
            }
        )

        for b, bullet in enumerate(job.get("bullets", [])):
            cards.append(
                {
                    "id": f"job-{j}-bullet-{b}",
                    "kind": "bullet",
                    "title": title,
                    "meta": meta,
                    "text": bullet["text"],
                    "keywords": list(bullet.get("keywords", [])),
                    "see": "experience",
                }
            )

    for e, edu in enumerate(resume.get("educations", [])):
        title = f"{edu['degree']} in {edu['fieldOfStudy']}" if edu.get("fieldOfStudy") else edu["degree"]
        meta_bits = [b for b in (edu.get("location", ""), span(edu.get("startDate", ""), edu.get("endDate", ""))) if b]
        meta = ", ".join(meta_bits)
        cards.append(
            {
                "id": f"education-{e}",
                "kind": "education",
                "title": f"{title}, {edu['institution']}",
                "meta": meta,
                # Same shape as the job cards -- title plus parenthesised meta -- so
                # formatGrepAnswer's duplicate check recognises it and prints the
                # header alone instead of saying the same thing twice. The wording
                # does not affect retrieval: "from" and "," are both dropped.
                "text": f"{title}, {edu['institution']}" + (f" ({meta})" if meta else ""),
                "keywords": [
                    k
                    for k in (edu.get("degree"), edu.get("fieldOfStudy"), edu.get("institution"))
                    if k
                ],
                "see": "education",
            }
        )
        for b, bullet in enumerate(edu.get("bullets", [])):
            cards.append(
                {
                    "id": f"education-{e}-bullet-{b}",
                    "kind": "bullet",
                    "title": f"{title}, {edu['institution']}",
                    "meta": meta,
                    "text": bullet["text"],
                    "keywords": list(bullet.get("keywords", [])),
                    "see": "education",
                }
            )

    skills = resume.get("skills", [])
    if skills:
        # One card, not one per skill: "what languages does he know" wants the list,
        # and 11 nearly-identical cards would crowd out everything else.
        by_level: dict[str, list[str]] = {}
        for s in skills:
            by_level.setdefault(s.get("experience", "familiar"), []).append(s["name"])
        parts = [f"{lvl}: {', '.join(names)}" for lvl, names in by_level.items()]
        cards.append(
            {
                "id": "skills",
                "kind": "skills",
                "title": "Skills",
                "text": "; ".join(parts),
                "keywords": [s["name"] for s in skills],
                "see": "skills",
            }
        )

    for h, hobby in enumerate(resume.get("hobbies", [])):
        # TODO placeholders are excluded: returning one as a search result would be
        # worse than returning nothing.
        if hobby.get("name", "").strip().upper().startswith("TODO"):
            continue
        cards.append(
            {
                "id": f"hobby-{h}",
                "kind": "hobby",
                "title": hobby["name"],
                "text": hobby["text"],
                "keywords": list(hobby.get("keywords", [])) + [hobby["name"]],
                "see": "hobbies",
            }
        )

    return cards


def add_aliases(cards: list[dict]) -> None:
    """Attach the per-kind retrieval aliases, omitting the key when there are none."""
    for card in cards:
        extra = EXTRA_KEYWORDS.get(card["kind"])
        if extra:
            card["aliases"] = list(extra)


def render(cards: list[dict]) -> str:
    body = json.dumps(cards, indent=2, ensure_ascii=False)
    return HEADER + body + FOOTER


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed file is stale")
    args = parser.parse_args()

    resume = json.loads(RESUME.read_text())
    cards = build(resume)
    add_aliases(cards)
    text = render(cards)

    if args.check:
        if not OUT.exists():
            print(f"{OUT.relative_to(ROOT)} is missing -- run tools/build_cards.py", file=sys.stderr)
            return 1
        if OUT.read_text() != text:
            print(
                f"{OUT.relative_to(ROOT)} is stale -- run tools/build_cards.py",
                file=sys.stderr,
            )
            return 1
        print(f"{OUT.relative_to(ROOT)} is up to date ({len(cards)} cards)")
        return 0

    OUT.write_text(text)
    kinds: dict[str, int] = {}
    for c in cards:
        kinds[c["kind"]] = kinds.get(c["kind"], 0) + 1
    summary = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items()))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(cards)} cards ({summary})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
