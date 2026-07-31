// @ts-check
/**
 * `ask` -- put a question to a very small language model running in the browser.
 *
 * Built entirely against the mock engine, which is what lets this exist before any
 * C is written. Swapping in the real engine is a change inside resolveEngine(),
 * not here.
 */

import { c, sp, blank } from "../render/chunk.js";
import { wrapChunks, indent } from "../render/layout.js";
import { streamWrapper } from "../render/stream-wrap.js";
import { RunningMode } from "../terminal/running-mode.js";
import { ReplMode } from "../terminal/repl-mode.js";
import { confirm } from "../terminal/confirm-mode.js";
import { History } from "../terminal/history.js";
import { askPrompt } from "../terminal/prompt.js";
import { parseFlags, invalidOptionMessage } from "../shell/flags.js";
import { resolveEngine, hasSimd } from "../llm/engine.js";
import { isContactQuestion, redactWord } from "../llm/guard.js";
import { formatContact, formatGrepAnswer } from "../render/format.js";
import { grepAnswer } from "../llm/fallback.js";
import { plan, markLoadStarted, markLoadFinished } from "../llm/capabilities.js";
import { EXIT } from "../shell/env.js";

/** @typedef {import('../shell/registry.js').Command} Command */
/** @typedef {import('../shell/registry.js').CommandContext} CommandContext */
/** @typedef {import('../llm/types.js').AskEngine} AskEngine */
/** @typedef {import('../llm/types.js').LoadProgress} LoadProgress */
/** @typedef {import('../render/chunk.js').Line} Line */

/** Guaranteed single-cell in every monospace font, unlike braille spinners. */
const SPINNER = ["|", "/", "-", "\\"];
const SPINNER_MS = 120;
const MAX_ANSWER_WIDTH = 76;

/** One string, so the three places that print it cannot drift apart. */
const USAGE = 'ask [-i|--interactive] [--offline] [--force-llm] "question"';

/** @param {number} bytes */
function mb(bytes) {
  return (bytes / 1_048_576).toFixed(1);
}

/**
 * A wget-style progress bar. The one bar in this project, and the only reason it
 * is allowed is that the download is real -- so the bar is honest.
 *
 * @param {string} label
 * @param {number} received
 * @param {number | null} total
 * @param {number | undefined} rate
 * @param {number} cols
 * @returns {Line}
 */
function progressBar(label, received, total, rate, cols) {
  if (total === null || total <= 0) {
    // No Content-Length: report what we have rather than faking a percentage.
    return [c(label, "dim"), sp(1), c(`${mb(received)} MB`)];
  }
  const pct = Math.min(100, Math.round((received / total) * 100));
  const suffix = ` ${String(pct).padStart(3)}%  ${mb(received)}/${mb(total)} MB` +
    (rate !== undefined && rate > 0 ? `  ${mb(rate)} MB/s` : "");

  // Whatever is left after the label, brackets and suffix.
  const barWidth = Math.max(4, cols - label.length - 3 - suffix.length);
  const filled = Math.round((barWidth * pct) / 100);
  return [
    c(label, "dim"),
    sp(1),
    c("[", "dim"),
    c("#".repeat(filled), "success"),
    c("·".repeat(barWidth - filled), "dim"),
    c("]", "dim"),
    c(suffix, "dim"),
  ];
}

/**
 * Load the engine, showing progress, after getting consent for the download.
 *
 * @param {CommandContext} ctx
 * @param {AskEngine} engine
 * @param {number} [nCtx] Context override; 0 uses the configured default.
 * @returns {Promise<'ready'|'declined'|'aborted'|'oom'>}
 */
async function ensureLoaded(ctx, engine, nCtx = 0) {
  if (engine.state === "ready") return "ready";

  const cached = await engine.isCached();
  if (!cached) {
    // Consent before spending 72 MB of someone's bandwidth. The cost is not
    // obvious from the command's name, which is exactly why this is here.
    const saveData =
      /** @type {{connection?: {saveData?: boolean, effectiveType?: string}}} */ (navigator)
        .connection;
    const frugal =
      saveData?.saveData === true || /^(slow-)?2g$/.test(saveData?.effectiveType ?? "");

    ctx.out([
      c("ask: ", "dim"),
      c(engine.info.label),
      c(` — ${mb(engine.info.bytes)} MB, not cached`, "dim"),
    ]);
    if (frugal) {
      ctx.out([
        sp(5),
        c("your connection reports data saving, so this defaults to no", "warn"),
      ]);
    }

    const yes = await confirm(
      ctx.term,
      [c("     download? ", "dim"), c(frugal ? "[y/N] " : "[Y/n] ", "bright")],
      { defaultYes: !frugal },
    );
    if (!yes) {
      ctx.out([c("ask: declined — nothing downloaded", "dim")]);
      return "declined";
    }
  }

  const bar = ctx.term.transientRow();
  let lastPaint = 0;

  // Written before the allocation and cleared after it. If iOS Safari kills the tab
  // for memory, nothing else runs -- no exception, no unload handler -- so a mark
  // still present on the next load is the only evidence the crash happened.
  markLoadStarted();

  try {
    await engine.load({
      signal: ctx.signal,
      nCtx,
      onProgress: (p) => {
        // Throttled to ~10Hz: repainting per chunk is pure layout thrash.
        const now = Date.now();
        if (p.phase === "fetching" && now - lastPaint < 90) return;
        lastPaint = now;

        if (p.phase === "fetching") {
          bar.set(progressBar("  model", p.received, p.total, p.bytesPerSecond, ctx.cols));
        } else if (p.phase === "prefill") {
          // The prompt read is the slow part on the real engine, and showing it
          // as its own phase is what stops a 15s pause looking like a hang.
          bar.set(progressBar("  reading resume", p.received, p.total, undefined, ctx.cols));
        } else if (p.phase === "initializing") {
          bar.set([c("  initializing", "dim")]);
        }
      },
    });
  } catch (err) {
    bar.discard();
    if (isAbortError(err)) {
      // An abort is not a crash: leaving the mark would make the next `ask` in this
      // tab default to grep-mode after a deliberate Ctrl+C.
      markLoadFinished();
      return "aborted";
    }
    if (isOomError(err)) {
      markLoadFinished();
      return "oom";
    }
    markLoadFinished();
    throw err;
  }

  markLoadFinished();
  bar.discard();
  return "ready";
}

/**
 * Did this fail for want of memory?
 *
 * Three shapes, because the failure can surface from three layers: the engine's own
 * ML_ERR_OOM, a failed `memory.grow` (which the browser reports as a RangeError), and
 * a rejected allocation inside `ml_alloc`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isOomError(err) {
  if (typeof err !== "object" || err === null) return false;
  const e = /** @type {{name?: string, code?: string, message?: string}} */ (err);
  if (e.code === "oom") return true;
  if (e.name === "RangeError") return true;
  return /out of memory|memory allocation|cannot allocate|ML_ERR_OOM/i.test(
    e.message ?? "",
  );
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  return (
    typeof err === "object" &&
    err !== null &&
    /** @type {{name?: string}} */ (err).name === "AbortError"
  );
}

/**
 * Stream one answer. Returns the exit status.
 *
 * @param {CommandContext} ctx
 * @param {AskEngine} engine
 * @param {string} question
 * @returns {Promise<number>}
 */
async function streamAnswer(ctx, engine, question) {
  // Spinner until the first token, so the gap does not read as a hang.
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spin = ctx.term.transientRow();
  let frame = 0;
  spin.set([c("  ", "dim"), c(reduced ? "..." : SPINNER[0] ?? "|", "dim")]);
  const ticker = reduced
    ? 0
    : window.setInterval(() => {
        frame = (frame + 1) % SPINNER.length;
        spin.set([c("  "), c(SPINNER[frame] ?? "|", "dim")]);
      }, SPINNER_MS);

  const stop = () => {
    if (ticker !== 0) clearInterval(ticker);
  };

  // Breaks are decided once, as each word completes, and never revisited --
  // re-wrapping the whole buffer per token would make already-visible text reflow
  // as the answer grows.
  const width = Math.min(MAX_ANSWER_WIDTH, Math.max(20, ctx.cols));
  // redactWord runs on each word as whitespace confirms it, so a fabricated
  // phone number never reaches the screen at all. Measured behaviour, not a
  // precaution: asked for a phone number the model answered "1-800-234-9675".
  const wrap = streamWrapper((s) => ctx.term.write(s), {
    width,
    indent: 2,
    transform: redactWord,
  });
  let first = true;

  try {
    for await (const delta of engine.generate({ prompt: question, signal: ctx.signal })) {
      if (first) {
        stop();
        spin.discard();
        first = false;
      }
      wrap.push(delta);
    }
  } catch (err) {
    stop();
    spin.discard();
    if (isAbortError(err)) {
      // Leave the partial answer on screen, as a real shell leaves partial output.
      wrap.end();
      ctx.out([c("^C", "dim")]);
      return EXIT.INTERRUPTED;
    }
    throw err;
  }

  stop();
  spin.discard();
  wrap.end();

  if (engine.info.mock) {
    ctx.out(blank);
    ctx.out([
      sp(2),
      c("(mock engine — synthetic text, not model output)", "warn"),
    ]);
  }
  ctx.out(blank);
  return EXIT.OK;
}

/**
 * @param {CommandContext} ctx
 * @returns {Line[]}
 */
function unavailableMessage(ctx, reason) {
  /** @type {Line[]} */
  const out = [];
  out.push([c(`ask: ${reason}`, "error")]);
  if (!hasSimd()) {
    out.push(
      ...indent(
        wrapChunks(
          [
            c(
              "this browser also lacks WebAssembly SIMD, which the engine needs to " +
                "run at a usable speed",
              "dim",
            ),
          ],
          ctx.cols - 2,
        ),
        2,
      ),
    );
  }
  out.push(
    ...indent(
      wrapChunks(
        [c("everything else works — try "), c("summary", "bright"), c(" or "), c("experience", "bright")],
        ctx.cols - 2,
      ),
      2,
    ),
  );
  return out;
}

/**
 * Answer from the resume instead of from the model.
 *
 * Not an error path. The banner states the reason because a silent change of
 * behaviour is worse than a slightly longer answer, but the answer that follows is
 * the resume itself -- which for most questions someone actually types is the better
 * of the two answers anyway.
 *
 * @param {CommandContext} ctx
 * @param {string} question
 * @param {string} [reason]
 * @returns {number} exit status
 */
function answerFromResume(ctx, question, reason) {
  if (reason !== undefined) {
    ctx.rows(
      indent(
        wrapChunks(
          [
            c("ask: ", "dim"),
            c(`${reason} — answering from the resume instead`, "dim"),
          ],
          ctx.cols,
        ),
        0,
      ),
    );
    ctx.out(blank);
  }
  const answer = grepAnswer(question);
  ctx.rows(formatGrepAnswer(answer, Math.min(ctx.cols, MAX_ANSWER_WIDTH)));
  // Found nothing is still a successful search, not a failure of the command --
  // matching grep, which exits 1 on no match. Worth the distinction: `ask ... ||
  // echo nope` should be able to tell.
  return answer.shown.length === 0 ? EXIT.ERROR : EXIT.OK;
}

/** @type {Command} */
export const askCmd = {
  name: "ask",
  group: "ai",
  summary: "ask a 135M-parameter model about me, in your browser",
  usage: USAGE,
  synopsis: [
    "Runs a small language model entirely in your browser. There is no backend.",
    "",
    "  -i, --interactive   start a session instead of asking one question",
    "      --offline       search the resume directly; never load the model",
    "      --force-llm     load the model even when this browser looks unable",
    "",
    "The first question downloads about 83 MB of quantized weights and asks",
    "before doing it. They are cached afterwards, and only the first question",
    "in a session pays the cost of reading the resume.",
    "",
    "The model has 135 million parameters. It will get things wrong. For",
    "anything that matters, read `experience` instead.",
    "",
    "Where the model cannot run -- no WebAssembly, not enough memory, or a",
    "previous attempt killed the tab -- `ask` searches the resume instead and",
    "says so. `--offline` selects that directly, and it is often the better",
    "answer: it is instant and it cannot make things up.",
    "",
    "Ctrl+C aborts at any stage, including mid-download and mid-answer.",
  ],
  run: async (ctx) => {
    const parsed = parseFlags(ctx.argv, {
      bools: {
        interactive: ["i", "interactive"],
        offline: ["offline"],
        "force-llm": ["force-llm"],
      },
    });
    if (!parsed.ok) {
      ctx.err(invalidOptionMessage("ask", parsed.badFlag));
      ctx.out([c(`usage: ${USAGE}`, "dim")]);
      return EXIT.USAGE;
    }

    const question = parsed.operands.join(" ").trim();
    const interactive = parsed.flags["interactive"] === true;
    if (!interactive && question === "") {
      ctx.err("ask: no question given");
      ctx.out([c(`usage: ${USAGE}`, "dim")]);
      ctx.out([c('   eg: ask "where did you go to school?"', "dim")]);
      return EXIT.USAGE;
    }

    // Before the mode decision, not after: this has to hold on every path. It sat
    // below the gate at first, which meant `ask --offline "what is his phone
    // number?"` ran a keyword search over the resume and found nothing -- turning a
    // question with a correct, deterministic answer into an exit-1 no-match.
    if (!interactive && answerContactDeterministically(ctx, question)) return EXIT.OK;

    // Decided before anything is fetched, so a browser that cannot run the model
    // never starts an 83 MB download to find out.
    const chosen = plan({
      offline: parsed.flags["offline"] === true,
      forceLlm: parsed.flags["force-llm"] === true,
    });

    if (chosen.mode === "grep") {
      if (interactive) return startGrepRepl(ctx, chosen.reason);
      return answerFromResume(ctx, question, chosen.reason);
    }

    const resolved = await resolveEngine({ resume: ctx.resume });
    if (!resolved.ok) {
      // Not deployed is the normal state of a fresh checkout, and no-wasm is a real
      // browser. Neither is a reason to refuse to answer when the resume is right
      // here, so this degrades rather than exiting 69.
      if (interactive) return startGrepRepl(ctx, resolved.reason);
      return answerFromResume(ctx, question, resolved.reason);
    }
    const engine = resolved.engine;

    if (chosen.warn !== undefined) {
      ctx.rows(indent(wrapChunks([c(`ask: ${chosen.warn}`, "warn")], ctx.cols), 0));
    }

    if (interactive) return startRepl(ctx, engine, chosen.nCtx);

    const loaded = await ensureLoaded(ctx, engine, chosen.nCtx);
    if (loaded === "declined") return EXIT.OK;
    if (loaded === "aborted") {
      ctx.out([c("^C", "dim")]);
      return EXIT.INTERRUPTED;
    }
    if (loaded === "oom") {
      // The tab survived, which means this is the catchable kind of failure. The
      // uncatchable kind is what the breadcrumb in capabilities.js is for.
      return answerFromResume(ctx, question, "not enough memory for the model");
    }

    return streamAnswer(ctx, engine, question);
  },
};

/**
 * Answer a contact question without involving the model.
 *
 * The phone number and email are deliberately absent from the system prompt, and
 * that turns out not to be enough: asked for a phone number, the quantized model
 * answered `1-800-234-9675` -- fabricated, confident, and quite possibly somebody
 * else's line. A wrong number sent to a recruiter is worse than no number.
 *
 * So contact questions never reach the model. This is also simply better: it is
 * instant, and it is right.
 *
 * @param {CommandContext} ctx
 * @param {string} question
 * @returns {boolean} whether it was handled here
 */
function answerContactDeterministically(ctx, question) {
  if (!isContactQuestion(question)) return false;
  ctx.out([
    c("ask: ", "dim"),
    c("contact details come from the resume, not the model", "dim"),
  ]);
  ctx.out(blank);
  ctx.rows(formatContact(ctx.resume, ctx.cols));
  return true;
}

/**
 * Push the `ask -i` sub-REPL.
 *
 * Returns immediately: the repl outlives this command, which is why the mode stack
 * removes the running mode by reference rather than popping the top.
 *
 * @param {CommandContext} ctx
 * @param {AskEngine} engine
 * @param {number} [nCtx]
 * @returns {number}
 */
function startRepl(ctx, engine, nCtx = 0) {
  ctx.out([c("ask: interactive session. ", "dim"), c(engine.info.label, "dim")]);
  ctx.rows(
    indent(
      wrapChunks(
        [
          c("Ctrl+D or "),
          c("exit", "bright"),
          c(" to leave, "),
          c(".reset", "bright"),
          c(" to clear context, Ctrl+C to abort an answer."),
        ],
        ctx.cols - 2,
      ),
      2,
    ),
  );
  ctx.out(blank);

  const repl = new ReplMode({
    id: "ask-repl",
    label: "ask — hannigan.sh",
    promptChunks: askPrompt,
    // Its own namespace, so shell history and question history do not interleave.
    history: new History("ask"),
    onDirective: (cmd, mctx) => {
      if (cmd === ".reset") {
        engine.reset();
        mctx.out.row([c("  context cleared", "dim")]);
        return true;
      }
      if (cmd === ".help") {
        mctx.out.row([c("  .reset  clear the conversation", "dim")]);
        mctx.out.row([c("  exit    leave the session (or Ctrl+D)", "dim")]);
        return true;
      }
      return false;
    },
    onEof: (mctx) => {
      mctx.out.row([c("  leaving ask", "dim")]);
      mctx.term.removeMode(repl);
    },
    onSubmit: (line, mctx) => {
      // Each question pushes its own running mode ON TOP of the repl, which is
      // what makes Ctrl+C during generation return to `ask>` rather than to `$`.
      const abort = new AbortController();
      const running = new RunningMode({ abort, label: "ask" });
      mctx.term.pushMode(running);

      /** @type {CommandContext} */
      const sub = {
        ...ctx,
        argv: ["ask", line],
        signal: abort.signal,
        cols: mctx.term.cols(),
        out: (l) => mctx.out.row(l),
        rows: (ls) => mctx.out.rows(ls),
        err: (t) => mctx.out.row([c(t, "error")]),
        term: mctx.term,
      };

      void (async () => {
        try {
          // Same guard as the one-shot path. Without this, `ask -i` would be a
          // way around it.
          if (answerContactDeterministically(sub, line)) return;
          const loaded = await ensureLoaded(sub, engine, nCtx);
          if (loaded === "ready") await streamAnswer(sub, engine, line);
          else if (loaded === "aborted") sub.out([c("^C", "dim")]);
          else if (loaded === "oom") {
            // The session stays open in grep-mode rather than dropping the visitor
            // back to `$`: they asked for a session, and the resume can still answer.
            answerFromResume(sub, line, "not enough memory for the model");
          }
        } catch (err) {
          console.error("[ask]", err);
          sub.err("ask: internal error");
        } finally {
          mctx.term.removeMode(running);
        }
      })();
    },
  });

  ctx.term.pushMode(repl);
  return EXIT.OK;
}

/**
 * Push the `ask -i` sub-REPL in grep-mode.
 *
 * Deliberately the same shape as the model REPL -- same prompt, same directives,
 * same history namespace -- because from the visitor's side it is the same feature
 * answering the same questions from the same document. The only differences are that
 * it starts instantly and that `.reset` has nothing to reset.
 *
 * @param {CommandContext} ctx
 * @param {string} [reason]
 * @returns {number}
 */
function startGrepRepl(ctx, reason) {
  ctx.out([
    c("ask: interactive session, ", "dim"),
    c("resume search", "bright"),
    c(reason === undefined ? "" : ` (${reason})`, "dim"),
  ]);
  ctx.rows(
    indent(
      wrapChunks(
        [
          c("Ctrl+D or "),
          c("exit", "bright"),
          c(" to leave. Answers are quoted from the resume, so nothing here is made up."),
        ],
        ctx.cols - 2,
      ),
      2,
    ),
  );
  ctx.out(blank);

  const repl = new ReplMode({
    id: "ask-repl-grep",
    label: "ask — hannigan.sh",
    promptChunks: askPrompt,
    history: new History("ask"),
    onDirective: (cmd, mctx) => {
      if (cmd === ".reset") {
        // Honest rather than silent: there is no conversation state to clear, and
        // pretending otherwise would imply the model is running.
        mctx.out.row([c("  nothing to clear — each search is independent", "dim")]);
        return true;
      }
      if (cmd === ".help") {
        mctx.out.row([c("  exit    leave the session (or Ctrl+D)", "dim")]);
        return true;
      }
      return false;
    },
    onEof: (mctx) => {
      mctx.out.row([c("  leaving ask", "dim")]);
      mctx.term.removeMode(repl);
    },
    onSubmit: (line, mctx) => {
      /** @type {CommandContext} */
      const sub = {
        ...ctx,
        argv: ["ask", line],
        cols: mctx.term.cols(),
        out: (l) => mctx.out.row(l),
        rows: (ls) => mctx.out.rows(ls),
        err: (t) => mctx.out.row([c(t, "error")]),
        term: mctx.term,
      };
      // Synchronous, so no RunningMode and no abort plumbing: retrieval over 24
      // cards finishes well inside a frame. Ctrl+C has nothing to interrupt.
      if (answerContactDeterministically(sub, line)) return;
      answerFromResume(sub, line);
    },
  });

  ctx.term.pushMode(repl);
  return EXIT.OK;
}
