// @ts-check
/**
 * Weight streaming.
 *
 * The invariant worth protecting: the weights are never held twice. `write` is called
 * with small chunks and nothing accumulates them, so a regression that reintroduces
 * `await res.arrayBuffer()` would show up as a peak-memory bug on a phone -- somewhere
 * far from here and hard to attribute. These tests pin the observable consequences:
 * chunks arrive incrementally, offsets are contiguous, and the byte count is checked.
 *
 * The real 87 MB model is not needed for any of this, so these run on a bare checkout.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fetchManifest, isCached, streamWeights } from "../site/js/llm/weights.js";
import { shardUrl, CACHE_NAME } from "../site/js/llm/config.js";

const CHUNK = 64;

/**
 * A Response whose body arrives in `CHUNK`-sized pieces, like a real network or Cache
 * API body. A fake that hands back one whole buffer would hide exactly the bug these
 * tests exist to catch.
 * @param {Uint8Array} buf
 * @param {{signal?: AbortSignal}} [init]
 */
function chunkedResponse(buf, init = {}) {
  let at = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (init.signal?.aborted === true) {
          c.error(new DOMException("Aborted", "AbortError"));
          return;
        }
        if (at >= buf.length) {
          c.close();
          return;
        }
        c.enqueue(new Uint8Array(buf.subarray(at, at + CHUNK)));
        at += CHUNK;
      },
    }),
    { status: 200, headers: { "content-length": String(buf.length) } },
  );
}

/**
 * Build a manifest plus the shard bytes it describes.
 * @param {number[]} sizes
 */
function fixture(sizes) {
  const shards = sizes.map((bytes, i) => ({
    name: `shard-${String(i).padStart(3, "0")}.bin`,
    bytes,
    sha256: "0".repeat(64),
  }));
  /** @type {Map<string, Uint8Array>} */
  const bodies = new Map();
  let seed = 1;
  for (const shard of shards) {
    const buf = new Uint8Array(shard.bytes);
    for (let i = 0; i < buf.length; i++) buf[i] = (seed = (seed * 31 + 7) & 0xff);
    bodies.set(shard.name, buf);
  }
  const manifest = {
    model: "test",
    bytes: sizes.reduce((a, b) => a + b, 0),
    sha256: "0".repeat(64),
    shards,
  };
  return { manifest, bodies };
}

/**
 * A fetch that serves the fixture in small chunks, so the reader loop really loops.
 * @param {Map<string, Uint8Array>} bodies
 */
function makeFetch(bodies, log = /** @type {string[]} */ ([])) {
  /** @type {any} */
  const f = async (url, init = {}) => {
    const name = String(url).split("/").pop() ?? "";
    log.push(name);
    if (name === "manifest.json") {
      throw new Error("manifest is served separately in these tests");
    }
    const buf = bodies.get(name);
    if (buf === undefined) return new Response(null, { status: 404 });
    return chunkedResponse(buf, init);
  };
  f.log = log;
  return f;
}

/**
 * A CacheStorage that stores bytes, like the real one -- not Response objects, whose
 * bodies are single-use.
 * @param {{failPut?: boolean}} [opts]
 */
function makeCaches(opts = {}) {
  /** @type {Map<string, Map<string, Uint8Array>>} */
  const store = new Map();
  const cacheFor = (name) => {
    let m = store.get(name);
    if (m === undefined) store.set(name, (m = new Map()));
    return m;
  };
  /** @type {any} */
  const storage = {
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    open: async (name) => {
      const m = cacheFor(name);
      return {
        match: async (url) => {
          const bytes = m.get(String(url));
          if (bytes === undefined) return undefined;
          return chunkedResponse(bytes);
        },
        put: async (url, res) => {
          if (opts.failPut === true) throw new Error("QuotaExceededError");
          m.set(String(url), new Uint8Array(await res.arrayBuffer()));
        },
      };
    },
  };
  storage.store = store;
  return storage;
}

/** Collect writes into one buffer, asserting offsets are contiguous. */
function collector(total) {
  const out = new Uint8Array(total);
  let expected = 0;
  let calls = 0;
  let maxChunk = 0;
  return {
    out,
    get calls() {
      return calls;
    },
    get maxChunk() {
      return maxChunk;
    },
    write: (chunk, offset) => {
      assert.equal(offset, expected, `write offset ${offset}, expected ${expected}`);
      out.set(chunk, offset);
      expected += chunk.length;
      calls++;
      maxChunk = Math.max(maxChunk, chunk.length);
    },
  };
}

test("shards are reassembled in order into one contiguous buffer", async () => {
  const { manifest, bodies } = fixture([200, 200, 137]);
  const sink = collector(manifest.bytes);
  const result = await streamWeights({
    manifest,
    write: sink.write,
    deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
  });

  assert.equal(result.bytes, manifest.bytes);
  assert.equal(result.fromCache, false);

  const expected = new Uint8Array(manifest.bytes);
  let at = 0;
  for (const shard of manifest.shards) {
    expected.set(/** @type {Uint8Array} */ (bodies.get(shard.name)), at);
    at += shard.bytes;
  }
  assert.deepEqual(sink.out, expected);
});

test("weights arrive incrementally, never as one buffer", async () => {
  // The load-bearing assertion. If someone replaces the reader loop with
  // `arrayBuffer()`, this test is what fails -- not a phone, weeks later.
  const { manifest, bodies } = fixture([512, 512]);
  const sink = collector(manifest.bytes);
  await streamWeights({
    manifest,
    write: sink.write,
    deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
  });
  assert.ok(sink.calls >= 16, `${sink.calls} write calls; expected many small ones`);
  assert.ok(
    sink.maxChunk <= CHUNK,
    `largest chunk was ${sink.maxChunk}, expected <= ${CHUNK}`,
  );
});

test("a short download is rejected rather than silently initializing garbage", async () => {
  // ml_init on a truncated buffer reads past the weights and produces plausible-looking
  // nonsense, so the byte count has to be enforced here.
  const { manifest, bodies } = fixture([100, 100]);
  manifest.bytes += 1; // manifest claims one more byte than the shards hold
  await assert.rejects(
    streamWeights({
      manifest,
      write: () => {},
      deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
    }),
    /expected 201 bytes, received 200/,
  );
});

test("an HTTP error names the shard that failed", async () => {
  const { manifest, bodies } = fixture([100, 100]);
  bodies.delete(manifest.shards[1].name);
  await assert.rejects(
    streamWeights({
      manifest,
      write: () => {},
      deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
    }),
    /shard-001\.bin: HTTP 404/,
  );
});

test("the second load comes from cache and refetches nothing", async () => {
  const { manifest, bodies } = fixture([300, 300]);
  const caches = makeCaches();
  const log = [];
  const fetchImpl = makeFetch(bodies, log);

  const first = collector(manifest.bytes);
  const cold = await streamWeights({
    manifest,
    write: first.write,
    deps: { fetchImpl, caches },
  });
  assert.equal(cold.fromCache, false);
  assert.equal(log.length, 2, "cold load should fetch both shards");

  log.length = 0;
  const second = collector(manifest.bytes);
  const warm = await streamWeights({
    manifest,
    write: second.write,
    deps: { fetchImpl, caches },
  });
  assert.equal(warm.fromCache, true);
  assert.equal(log.length, 0, "warm load must not touch the network");
  assert.deepEqual(second.out, first.out, "cached bytes must match downloaded bytes");
});

test("a cache write failure degrades to a working download", async () => {
  // Private browsing and quota exhaustion both land here. Re-downloading next time is
  // acceptable; failing the load is not.
  const { manifest, bodies } = fixture([300, 300]);
  const sink = collector(manifest.bytes);
  const result = await streamWeights({
    manifest,
    write: sink.write,
    deps: { fetchImpl: makeFetch(bodies), caches: makeCaches({ failPut: true }) },
  });
  assert.equal(result.bytes, manifest.bytes);

  const expected = new Uint8Array(manifest.bytes);
  let at = 0;
  for (const shard of manifest.shards) {
    expected.set(/** @type {Uint8Array} */ (bodies.get(shard.name)), at);
    at += shard.bytes;
  }
  assert.deepEqual(sink.out, expected, "the response itself must still be consumed");
});

test("no Cache API at all still loads", async () => {
  const { manifest, bodies } = fixture([128, 128]);
  const sink = collector(manifest.bytes);
  const result = await streamWeights({
    manifest,
    write: sink.write,
    deps: { fetchImpl: makeFetch(bodies), caches: undefined },
  });
  assert.equal(result.bytes, manifest.bytes);
  assert.equal(result.fromCache, false);
});

test("aborting mid-download rejects with AbortError", async () => {
  const { manifest, bodies } = fixture([4096, 4096, 4096]);
  const controller = new AbortController();
  let written = 0;
  await assert.rejects(
    streamWeights({
      manifest,
      write: (chunk) => {
        written += chunk.length;
        if (written > 512) controller.abort();
      },
      signal: controller.signal,
      deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
    }),
    (err) => /** @type {any} */ (err).name === "AbortError",
  );
  assert.ok(written < manifest.bytes, "abort must stop short of the full download");
});

test("an already-aborted signal never fetches", async () => {
  const { manifest, bodies } = fixture([128]);
  const log = [];
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    streamWeights({
      manifest,
      write: () => {},
      signal: controller.signal,
      deps: { fetchImpl: makeFetch(bodies, log), caches: makeCaches() },
    }),
    (err) => /** @type {any} */ (err).name === "AbortError",
  );
  assert.equal(log.length, 0);
});

test("progress is monotonic and ends at the manifest total", async () => {
  const { manifest, bodies } = fixture([2048, 2048]);
  const seen = [];
  await streamWeights({
    manifest,
    write: () => {},
    onProgress: (received, total) => {
      seen.push(received);
      assert.equal(total, manifest.bytes, "total must not drift between reports");
    },
    deps: { fetchImpl: makeFetch(bodies), caches: makeCaches() },
  });
  assert.ok(seen.length >= 1);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] >= seen[i - 1], `progress went backwards: ${seen}`);
  }
  assert.equal(
    seen[seen.length - 1],
    manifest.bytes,
    "the final report must read 100%, or the bar sticks below full",
  );
});

test("isCached is all-or-nothing", async () => {
  const { manifest, bodies } = fixture([100, 100, 100]);
  const caches = makeCaches();
  assert.equal(await isCached(manifest, { caches }), false);

  // Prime only two of the three shards: a partial cache must not read as cached, or
  // `ask` would skip the download notice and then stall on a silent fetch.
  const cache = await caches.open(CACHE_NAME);
  for (const shard of manifest.shards.slice(0, 2)) {
    await cache.put(
      shardUrl(shard.name),
      new Response(/** @type {Uint8Array} */ (bodies.get(shard.name))),
    );
  }
  assert.equal(await isCached(manifest, { caches }), false);

  const last = manifest.shards[2];
  await cache.put(
    shardUrl(last.name),
    new Response(/** @type {Uint8Array} */ (bodies.get(last.name))),
  );
  assert.equal(await isCached(manifest, { caches }), true);
});

test("stale cache versions are evicted on open", async () => {
  // Otherwise a visitor who loaded an older model keeps ~87 MB of dead weights on disk
  // forever, and may hit quota fetching the new one.
  const { manifest, bodies } = fixture([64]);
  const caches = makeCaches();
  const old = await caches.open("hannigan-sh-llm-v0");
  await old.put(shardUrl("whatever.bin"), new Response(new Uint8Array(8)));
  assert.ok(caches.store.has("hannigan-sh-llm-v0"));

  await streamWeights({
    manifest,
    write: () => {},
    deps: { fetchImpl: makeFetch(bodies), caches },
  });
  assert.equal(caches.store.has("hannigan-sh-llm-v0"), false);
  assert.ok(caches.store.has(CACHE_NAME));
});

test("unrelated caches are left alone", async () => {
  const { manifest, bodies } = fixture([64]);
  const caches = makeCaches();
  const other = await caches.open("some-other-app");
  await other.put("https://example.test/x", new Response(new Uint8Array(4)));

  await streamWeights({
    manifest,
    write: () => {},
    deps: { fetchImpl: makeFetch(bodies), caches },
  });
  assert.ok(caches.store.has("some-other-app"), "eviction must be scoped by prefix");
});

test("fetchManifest surfaces a missing manifest as an error", async () => {
  /** @type {any} */
  const f = async () => new Response(null, { status: 404 });
  await assert.rejects(fetchManifest({ fetchImpl: f }), /manifest: HTTP 404/);
});

test("fetchManifest parses a manifest", async () => {
  const { manifest } = fixture([1, 2, 3]);
  /** @type {any} */
  const f = async () => new Response(JSON.stringify(manifest), { status: 200 });
  const parsed = await fetchManifest({ fetchImpl: f });
  assert.equal(parsed.bytes, 6);
  assert.equal(parsed.shards.length, 3);
});
