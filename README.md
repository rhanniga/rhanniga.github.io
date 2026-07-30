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
2. **The model weights**, ~72 MB, fetched from HuggingFace on the first `ask`
   only, and never without confirming first. See below.

Nothing else phones home: no analytics, no fonts, no CDN, no service worker.

## The `ask` command

First invocation downloads ~72 MB of quantized weights (SmolLM2-135M-Instruct,
int4, group size 64), caches them in the Cache API, and asks before doing it.
Expect roughly 15 seconds to read the resume and then ~18 tokens/second on a
desktop. Subsequent questions in the same session skip the read.

Caveats worth knowing:

- **Safari evicts all origin storage after 7 days without interaction**, so
  returning Safari users re-download. Chrome and Firefox persist.
- No WebAssembly SIMD, or a device too small to hold ~120 MB, falls back to a
  keyword-scored search over the resume — which, for most questions, is more
  useful than the model. `ask --offline` forces it.
- The model is 135M parameters. It hallucinates. That is expected and fine.

## Credits

The inference engine derives from [llama2.c](https://github.com/karpathy/llama2.c)
(MIT, Andrej Karpathy). The model is a quantized derivative of
[SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct)
(Apache-2.0). Colours are [Nord](https://www.nordtheme.com/).
