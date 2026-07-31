# M9 go/no-go: can a 4-bit 135M model answer questions about this resume?

Greedy decode, 60 max tokens, real 351-token system prompt.
`tools/ask_native.py --suite --model <path>`

## Verdict: GO, with the hybrid scheme

| | factual questions | decode |
|---|---|---|
| fp32 (513 MB) | correct | 22.6 tok/s |
| **hybrid (86.5 MB)** | **5/5 correct** | **103.1 tok/s** |
| q4 (71.8 MB) | 3/5 correct | 95.0 tok/s |

Quantized decode is ~4.6x FASTER than fp32, because a decode token touches
eight times less weight data.

## Why hybrid, not q4

The perplexity gate in M7 measured x1.228 vs x1.556 and chose hybrid. The
behavioural gap is much wider than that ratio suggests:

    Q: What did he do at CERN?
    hybrid: ...his work on the ALICE project led to some groundbreaking results
    q4:     ...a PhD candidate in particle physics, working under the guidance of
            Dr. John Randall at the University of Texas at Austin from 2018 to 2019

`Dr. John Randall` does not exist. q4 also called VenHub "a leading accelerator
for research" and had him "designing an early prototype of a quantum computer
architecture to be used in the LHC detector upgrade" -- fluent, confident, and
entirely invented.

    Q: What was his job at VenHub?
    hybrid: Dr. Ryan Hannigan was a software engineer at VenHub.
    q4:     Dr. Ryan Hannigan was a project manager at VenHub...

15 MB buys a model that stops inventing colleagues.

Interesting: on the PhD question the hybrid answer is BETTER than fp32's. fp32
said "in Physics and Mathematics" -- conflating the doctorate's field with the
bachelor's -- while hybrid correctly said particle physics.

## The finding that changed the design

Both quantized models fabricated a phone number:

    hybrid: Dr. Ryan Hannigan's phone number is 1-800-234-9675.
    q4:     Dr. Ryan Hannigan's phone number is 1-807-256-3943.

Omitting contact details from the system prompt was necessary and not
sufficient. A fabricated number is worse than a leaked one: it is confident,
plausible, and quite possibly somebody real's line.

Handled in site/js/llm/guard.js with two layers, neither of which trusts the
model:

1. Contact-shaped questions never reach it; `ask` answers them from resume.json.
2. Generated output is filtered per word, so a number is caught before any of it
   reaches the screen rather than being un-printed afterwards.
