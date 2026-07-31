# hannigan.sh

My resume, served through a terminal emulator. Type `experience`, get
experience. Type something else, get `bash: something: command not found`.

The party trick is `ask "..."`: a 135M-parameter language model written in C,
compiled to WebAssembly, downloaded on first use and run entirely in your
browser. There is no backend — this is a static site on GitHub Pages.

## Running it locally

```sh
python3 -m http.server -d site 8000
```

Then open <http://localhost:8000>.

`file://` will not work: both ES modules and `fetch()` require http(s). There is
no watch process, no dev server, and no HMR — edit a file and hit reload. That
immediacy is the whole point of the stack.

`ask` needs two build outputs that are not in git: the wasm module and the
weights.

```sh
make -C engine wasm wasm-scalar                                  # -> site/ask/
tools/.venv/bin/python tools/convert.py --quant hybrid -o m.hslm  # the shipped model
python3 tools/shard.py m.hslm --out site/model/
```

With those present, `ask` runs the real model locally. Without them it falls back
to a synthetic mock engine so the rest of the site can be developed on a bare
checkout — and it says so under every answer. The choice is made by probing for
`site/model/manifest.json`, so it follows what is actually on disk; `?ask=mock`
and `?ask=real` force either one.

Two useful query parameters while developing: `?model=<url>` points the shard
fetch somewhere else (`?model=hf:` for the HuggingFace copy), and `?plain=1`
renders the semantic HTML resume.

## Editing the resume

Everything lives in [`site/resume.json`](site/resume.json), which is fetched at
runtime and is the single source of truth. It is also served as a real URL, so
<https://www.hannigan.sh/resume.json> works and `cat resume.json` in the
terminal is telling the truth.

Schema: `contactInfo`, `summaries[]`, `educations[]`, `jobs[]`, `projects[]`,
`skills[]`, `hobbies[]`. Bullets and summaries are `{text, keywords[]}`; the
`keywords` arrays drive inline highlighting and double as the relevance signal
for `ask`'s offline fallback, so they are worth filling in.

Dates are `YYYY-MM-DD` strings, with the literal `"Present"` as the sentinel for
an ongoing role. They are formatted by string-splitting, never by `new Date()` —
parsing `"2023-01-01"` yields UTC midnight, which renders as December 2022 in
any negative-offset timezone.

## Layout

```
site/            the deploy artifact — if it is in here, it is public
  index.html
  resume.json
  styles/        nord.css (palette) theme.css (roles) terminal.css (layout)
  js/
    terminal/    DOM, mode stack, line editing, writer, metrics
    shell/       tokenizer, flag parsing, command registry, dispatch
    commands/    one module per group of commands
    render/      pure (data, cols) => Line[] formatters — no DOM
    llm/         AskEngine contract, worker, tokenizer, weight caching
  ask/           WASM build output (gitignored; built by CI)
  dev/tests.html browser test runner
engine/          the C inference engine + its native build
tools/           Python: model conversion, tokenizer export, prompt building
tests/           node --test
```

## Tests

```sh
node --test          # unit tests (zero dependencies)
```

Note the bare-directory form (`node --test tests/`) is broken on Node 26; no
arguments auto-discovers correctly.

`site/dev/tests.html` runs the same pure modules in a browser, which is the
honest match for a no-build-step project. The root `package.json` contains only
`{"private": true, "type": "module"}` and exists solely so `node --test` treats
`.js` files as ES modules — there are no dependencies and nothing to install.

Types come from JSDoc plus `jsconfig.json`, so an editor type-checks the whole
codebase with no toolchain. Nothing enforces this in CI; the compensating
controls are the runtime shape guard in `site/js/data/resume.js`, `jq empty` on
the JSON, and the tests above.

## Network requests

The site is static and has no backend. It makes exactly two kinds of outbound
request, both worth knowing about:

1. **The visitor's IP address**, resolved once per page load from
   `api.ipify.org` (falling back to `icanhazip.com`) so the prompt can read
   `203.0.113.7@hannigan.sh:~$` instead of `visitor@hannigan.sh:~$`. This is the
   only third-party request made on load. It is lazy, never on the critical path,
   sent with no credentials and no referrer, and bounded by a 2.5s timeout. Ad
   blockers commonly block these endpoints, in which case it fails silently and
   the prompt keeps `visitor@`. The response is validated as a syntactic IP
   before being rendered — a rate-limit notice or error page must never reach the
   prompt.
2. **The model weights**, ~83 MB, fetched on the first `ask` only, and never
   without confirming first. Served from this origin by default, so this is not a
   third-party request; `site/js/llm/config.js` can point it at the HuggingFace
   copy instead with a one-constant change. See below.

Nothing else phones home: no analytics, no fonts, no CDN, no service worker.

## The `ask` command

First invocation downloads ~83 MB of quantized weights (SmolLM2-135M-Instruct,
int8 embedding + int4 blocks, group size 64), caches them in the Cache API, and
asks before doing it. Subsequent questions in the same session are much faster,
because the KV cache for the system prompt is snapshotted once and restored.

Measured on a desktop with WebAssembly SIMD:

| | |
|---|---|
| reading the resume (351 tokens) | ~4.0 s, first question only |
| generation | ~77 tokens/second |
| second and later questions | first token in ~0.5 s |
| peak wasm heap | 151 MB (83 weights + 47 KV cache + 16 snapshot) |

Without SIMD the engine is about 3.7× slower — roughly 20 s to read the resume
and ~21 tokens/second. That is a wait, not a hang, so it still runs; `ask` warns
first.

### When it falls back to searching the resume instead

`ask` decides before downloading anything, and says which it chose and why:

| condition | behaviour |
|---|---|
| no WebAssembly | resume search; nothing to override |
| ~160 MB cannot be reserved | resume search, overridable |
| a previous `ask` killed this tab | resume search, overridable |
| no SIMD **and** a constrained device | resume search, overridable |
| no SIMD on a desktop | model, with a warning |
| `navigator.deviceMemory ≤ 4`, or iOS | model at `nCtx=512`, halving the KV cache |

`--offline` selects resume search directly and `--force-llm` overrides any
overridable gate. Resume search is BM25 over ~24 cards generated from
`resume.json`, and for most questions someone actually types it is the *better*
answer: instant, quotes the resume verbatim, and cannot make anything up.

Regenerate the corpus after editing the resume — CI fails if it is stale:

```
python3 tools/build_cards.py
```

Other caveats worth knowing:

- **Safari evicts all origin storage after 7 days without interaction**, so
  returning Safari users re-download. Chrome and Firefox persist.
- **iOS Safari can kill the tab for memory with no catchable error.** `ask`
  writes a `sessionStorage` breadcrumb before allocating and clears it after, so
  a reload can tell you it happened rather than silently trying again.
- The model is 135M parameters. It hallucinates. That is expected and fine —
  except for contact details, which are intercepted before reaching the model and
  redacted out of its output, because a confidently invented phone number is
  worse than none.

## Accessibility

A terminal emulator is a deliberately unusual interface, and no amount of
`aria-label` makes it a good one for someone using a screen reader. So there are
two real answers rather than one grudging one:

- **`?plain=1`** renders a semantic HTML resume — one `h1`, a real heading
  outline, `<ul>` for bullets, actual links — from the same `resume.json`. It is
  the first focusable element on the page (a skip link), and it is what
  `robots.txt` points crawlers at, since `index.html` deliberately contains no
  resume text to go stale.
- **A separate announcement path.** `#output` is `aria-hidden`: it is
  hard-wrapped to the column count, and a 42-column wrap read by a screen reader
  becomes a stack of fragments rather than a sentence. `#announcer` is a
  visually-hidden `role="log"` that receives the same content **unwrapped**, one
  block per command. `ask` announces once when generation finishes, because a
  live region fed a token stream interrupts itself continuously.

On mobile, the soft-key toolbar (`Tab ↑ ↓ ^C ^L`, coarse pointers only) is not a
convenience: on-screen keyboards have no Ctrl and no arrow keys, so without it
history, completion, and aborting a running `ask` are unreachable. Terminal
height tracks `visualViewport` rather than `100dvh` alone, because only
`visualViewport` reports the on-screen keyboard — that is what keeps the prompt
visible while typing.

Pinch zoom is not blocked (no `maximum-scale`, no `user-scalable=no`), and
Escape is not trapped.

**Not yet verified on real hardware:** VoiceOver and NVDA reading order, and iOS
Safari's memory ceiling and keyboard behaviour. The iOS simulator does not
reproduce either.

## Credits

The inference engine derives from [llama2.c](https://github.com/karpathy/llama2.c)
(MIT, Andrej Karpathy). The model is a quantized derivative of
[SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct)
(Apache-2.0). Colours are [Nord](https://www.nordtheme.com/).
