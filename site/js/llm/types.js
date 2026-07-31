// @ts-check
/**
 * The AskEngine contract.
 *
 * This file is the interface document between the terminal and the C/WASM engine,
 * and both sides are written against it independently. Types only -- no runtime
 * values.
 *
 * The requirements below are not stylistic. Each one exists because getting it
 * wrong produces a specific, already-anticipated bug:
 *
 * 1. `generate` yields decoded **text**, never token ids. The worker owns the
 *    streaming TextDecoder, so a multi-byte codepoint split across two tokens is
 *    reassembled in exactly one place.
 * 2. Deltas never split a UTF-8 sequence. Partial bytes are buffered in the
 *    worker.
 * 3. Plain text only: no ANSI escapes, no markdown fences. Nothing in this project
 *    parses escape sequences, by design.
 * 4. Aborting **throws** `DOMException(..., 'AbortError')` rather than returning
 *    quietly, so `ask` can tell cancellation from completion and exit 130 rather
 *    than 0.
 * 5. `createAskEngine()` instantiates no wasm and fetches nothing. First paint and
 *    the boot sequence must be unaffected, which is why `load()` is separate.
 * 6. `isCached()` exists so a repeat visit does not re-ask for consent to a
 *    download that will not happen.
 * 7. The engine never touches the DOM.
 * 8. `info.bytes` is accurate, because the progress bar renders against it.
 */

/**
 * @typedef {object} AskEngineInfo
 * @property {string} id
 * @property {string} label
 * @property {number} bytes    download size; the progress bar depends on this
 * @property {string} params
 * @property {number} ctx      context window, in tokens
 * @property {boolean} mock    true for the synthetic engine, so `ask` can say so
 */

/**
 * @typedef {object} LoadProgress
 * @property {'fetching'|'decompressing'|'initializing'|'prefill'|'ready'} phase
 * @property {number} received
 * @property {number|null} total   null when Content-Length is absent
 * @property {number} [bytesPerSecond}
 * @property {string} [message]
 */

/**
 * @typedef {object} GenerateOptions
 * @property {string} prompt
 * @property {ReadonlyArray<{role: 'user'|'assistant', content: string}>} [history]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} GenerateStats
 * @property {number} tokensPerSecond
 * @property {number} promptTokens
 * @property {number} completionTokens
 */

/**
 * @typedef {object} AskEngine
 * @property {AskEngineInfo} info
 * @property {'unloaded'|'loading'|'ready'|'error'} state
 * @property {() => Promise<boolean>} isCached
 * @property {(opts?: {signal?: AbortSignal, onProgress?: (p: LoadProgress) => void}) => Promise<void>} load
 * @property {(opts: GenerateOptions) => AsyncIterable<string>} generate
 * @property {() => void} reset
 * @property {() => Promise<void>} dispose
 * @property {GenerateStats} [stats]
 */

export {};
