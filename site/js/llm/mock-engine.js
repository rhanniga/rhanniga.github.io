// @ts-check
/**
 * A synthetic AskEngine.
 *
 * This is the key sequencing decision of the whole project: the entire terminal
 * side of `ask` -- progress bar, streaming, the sub-REPL, cancellation at every
 * stage -- is built and exercised against this, so the browser work neither blocks
 * nor is blocked by the C work. It stays in the tree permanently for offline
 * development and for testing the UI without a 72 MB download.
 *
 * It deliberately mimics the *timings* the real engine will have (a slow download,
 * a long prompt read, then tokens at a readable rate), because those timings are
 * what the UI has to be designed around.
 *
 * `info.mock` is true so `ask` can label its output. Passing synthetic text off as
 * model output would make the mock actively harmful.
 */

/** @typedef {import('./types.js').AskEngine} AskEngine */
/** @typedef {import('./types.js').LoadProgress} LoadProgress */
/** @typedef {import('./types.js').GenerateOptions} GenerateOptions */

/** Matches the real plan: SmolLM2-135M-Instruct at int4, group size 64. */
const BYTES = 71_500_000;

/**
 * Default timings, chosen to mimic what the real engine will feel like -- because
 * those timings are what the UI has to be designed around. Overridable so tests
 * do not have to spend four seconds per case.
 */
const DEFAULT_TIMINGS = {
  downloadMs: 2200,
  prefillMs: 1800,
  /** ~18 tok/s, the desktop estimate for the real engine. */
  tokenMs: 55,
};

/** Survives within a tab, so the second `ask` skips the download as the real one will. */
const CACHE_FLAG = "hannigan.sh:mock-model-cached";

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pick a plausible answer from the resume, so the streamed text has realistic
 * length and shape. It is keyword matching, not a model -- which is exactly what
 * grep-mode will be in M13, and a fine stand-in here.
 *
 * @param {string} question
 * @param {import('../data/types.js').Resume | null} resume
 * @returns {string}
 */
function fakeAnswer(question, resume) {
  const q = question.toLowerCase();

  if (resume !== null) {
    if (/phd|doctor|school|degree|educat|univers|studi/.test(q)) {
      const phd = resume.educations.find((e) => /doctor/i.test(e.degree));
      if (phd !== undefined) {
        return `Ryan earned a ${phd.degree.toLowerCase()} in ${phd.fieldOfStudy} from the ${phd.institution}, finishing in ${phd.endDate.slice(0, 4)}. He also holds a bachelor's in Physics and Mathematics from the University of Houston.`;
      }
    }
    if (/cern|alice|physic|detector|lhc/.test(q)) {
      return "At CERN he worked on the ALICE experiment, building a C++ suite to test and characterise hardware for the detector upgrade, with a focus on picosecond timing resolution and high-throughput data transfers. He later published first-author papers on strange and heavy-flavour quark production at the LHC.";
    }
    if (/venhub|robot|startup|principal/.test(q)) {
      return "At VenHub he was Principal Software Engineer, building the early software infrastructure: microcontroller firmware in C++, backends in Python and FastAPI, a computer vision server, and the customer-facing React Native app. He also architected a multi-threaded robotic control system that cut order processing time by more than half.";
    }
    if (/teach|lectur|student|course/.test(q)) {
      return "He taught a full semester of PHY302K, an introductory physics course for STEM majors, to more than a hundred students, and mentored several graduate and undergraduate researchers alongside his postdoctoral work at UT Austin.";
    }
    if (/language|skill|python|rust|c\+\+|know/.test(q)) {
      const expert = resume.skills.filter((s) => s.experience === "expert").map((s) => s.name);
      return `His strongest areas are ${expert.join(", ")}. He is also experienced with C++, data science, Bash and teaching, and has working knowledge of Rust, C, TypeScript and machine learning.`;
    }
  }

  return "Ryan is a software engineer and physicist. He spent several years at CERN on the ALICE experiment, completed a doctorate in particle physics at UT Austin where he now lectures, and most recently built early infrastructure as Principal Software Engineer at VenHub. Ask about a specific role, or run `experience` for the full list.";
}

/**
 * @param {{ resume?: import('../data/types.js').Resume | null,
 *           timings?: Partial<typeof DEFAULT_TIMINGS> }} [deps]
 * @returns {AskEngine}
 */
export function createMockEngine(deps = {}) {
  const resume = deps.resume ?? null;
  const { downloadMs, prefillMs, tokenMs } = { ...DEFAULT_TIMINGS, ...deps.timings };

  /** @type {AskEngine} */
  const engine = {
    info: {
      id: "mock",
      label: "mock engine (synthetic, no model)",
      bytes: BYTES,
      params: "135M",
      ctx: 1024,
      mock: true,
    },
    state: "unloaded",

    isCached: async () => {
      try {
        return sessionStorage.getItem(CACHE_FLAG) === "1";
      } catch {
        return false;
      }
    },

    load: async (opts = {}) => {
      const { signal, onProgress } = opts;
      engine.state = "loading";
      try {
        const cached = await engine.isCached();

        if (!cached) {
          // ~10Hz progress, matching the throttle the real weights loader uses.
          const ticks = Math.max(1, Math.round(downloadMs / 100));
          const started = Date.now();
          for (let i = 1; i <= ticks; i++) {
            await sleep(downloadMs / ticks, signal);
            const received = Math.round((BYTES * i) / ticks);
            const elapsed = Math.max(1, Date.now() - started) / 1000;
            onProgress?.({
              phase: "fetching",
              received,
              total: BYTES,
              bytesPerSecond: received / elapsed,
            });
          }
          try {
            sessionStorage.setItem(CACHE_FLAG, "1");
          } catch {
            /* private mode: the next ask will "download" again, as it would for real */
          }
        }

        onProgress?.({ phase: "initializing", received: BYTES, total: BYTES });
        await sleep(200, signal);

        // The system prompt read. On the real engine this is the expensive part --
        // ~15s on a desktop -- and only the first question in a session pays it,
        // which is why it is reported separately from the download.
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          await sleep(prefillMs / steps, signal);
          onProgress?.({
            phase: "prefill",
            received: Math.round((350 * i) / steps),
            total: 350,
          });
        }

        onProgress?.({ phase: "ready", received: BYTES, total: BYTES });
        engine.state = "ready";
      } catch (err) {
        engine.state = "error";
        throw err;
      }
    },

    generate: (opts) => {
      const text = fakeAnswer(opts.prompt, resume);
      const signal = opts.signal;
      return {
        async *[Symbol.asyncIterator]() {
          // Split so whitespace rides along with its word, the way a real
          // tokenizer's output does.
          const pieces = text.match(/\S+\s*/g) ?? [];
          let emitted = 0;
          for (const piece of pieces) {
            await sleep(tokenMs, signal);
            emitted++;
            yield piece;
          }
          engine.stats = {
            tokensPerSecond: 1000 / Math.max(1, tokenMs),
            promptTokens: 350,
            completionTokens: emitted,
          };
        },
      };
    },

    reset: () => {
      /* No conversation state to clear in the mock. */
    },

    dispose: async () => {
      engine.state = "unloaded";
    },
  };

  return engine;
}
