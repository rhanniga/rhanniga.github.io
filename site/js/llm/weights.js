// @ts-check
/**
 * Fetch the model weights, cache them, and stream them into wasm memory.
 *
 * The shape here exists to avoid holding 87 MB twice. The obvious implementation --
 * `await res.arrayBuffer()` then copy into the heap -- peaks at roughly 174 MB on top
 * of the 47 MB KV cache, which is where mobile Safari kills the tab. So:
 *
 *     cold:  fetch -> progress-counting stream -> cache.put   (the browser writes
 *                                                             straight to disk; the
 *                                                             JS heap stays at a few
 *                                                             MB per chunk)
 *            then fall through to the warm path
 *     warm:  cache.match -> read chunks -> copy each into linear memory
 *
 * Both paths end in the same "stream from cache into the heap" code, so there is one
 * path to debug rather than two, and the warm path is a ~200 ms disk read.
 *
 * Cache API rather than IndexedDB: this is an HTTP response, `cache.put` streams it
 * to disk, and IndexedDB would require materialising the whole thing as a Blob and
 * structured-cloning it -- which Safari has a long history of failing on at this size.
 */

import { CACHE_NAME, shardUrl } from "./config.js";

/**
 * @typedef {object} Manifest
 * @property {string} model
 * @property {number} bytes
 * @property {string} sha256
 * @property {Array<{name: string, bytes: number, sha256: string}>} shards
 */

/**
 * @typedef {object} LoadDeps
 * @property {typeof fetch} [fetchImpl]
 * @property {CacheStorage} [caches]
 */

/**
 * Open the cache, deleting any older versions.
 * @param {LoadDeps} deps
 * @returns {Promise<Cache | null>}
 */
async function openCache(deps) {
  const storage = deps.caches ?? (typeof caches !== "undefined" ? caches : undefined);
  if (storage === undefined) return null; // no Cache API: works, just re-downloads
  try {
    for (const name of await storage.keys()) {
      if (name.startsWith("hannigan-sh-llm-") && name !== CACHE_NAME) {
        await storage.delete(name);
      }
    }
    return await storage.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/**
 * @param {LoadDeps} deps
 * @returns {Promise<Manifest>}
 */
export async function fetchManifest(deps = {}) {
  const f = deps.fetchImpl ?? fetch;
  const res = await f(shardUrl("manifest.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
  return await res.json();
}

/**
 * Are all of this manifest's shards already cached?
 * @param {Manifest} manifest
 * @param {LoadDeps} deps
 * @returns {Promise<boolean>}
 */
export async function isCached(manifest, deps = {}) {
  const cache = await openCache(deps);
  if (cache === null) return false;
  for (const shard of manifest.shards) {
    if ((await cache.match(shardUrl(shard.name))) === undefined) return false;
  }
  return true;
}

/**
 * Download the weights into `write`, one chunk at a time.
 *
 * @param {object} args
 * @param {Manifest} args.manifest
 * @param {(chunk: Uint8Array, offset: number) => void} args.write
 *   Copies one chunk into linear memory. Called with a view that must not be
 *   retained -- the underlying buffer is reused.
 * @param {(received: number, total: number, bytesPerSecond: number) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {LoadDeps} [args.deps]
 * @returns {Promise<{fromCache: boolean, bytes: number}>}
 */
export async function streamWeights({ manifest, write, onProgress, signal, deps = {} }) {
  const f = deps.fetchImpl ?? fetch;
  const cache = await openCache(deps);

  let offset = 0;
  let received = 0;
  let cachedAll = true;
  const started = Date.now();

  for (const shard of manifest.shards) {
    if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");

    const url = shardUrl(shard.name);
    let response = cache === null ? undefined : await cache.match(url);

    if (response === undefined) {
      cachedAll = false;
      const fetched = await f(url, {
        signal,
        cache: "no-store",
        // An IP-echo service has no business knowing which page asked, and neither
        // does a CDN serving static weights.
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!fetched.ok) throw new Error(`${shard.name}: HTTP ${fetched.status}`);

      if (cache !== null) {
        // Constructing our own Response rather than caching the fetched one
        // sidesteps HuggingFace's 307 -> 302 -> CDN redirect chain entirely and gives
        // a stable, same-origin-shaped cache key.
        try {
          await cache.put(
            url,
            new Response(fetched.body, {
              headers: { "content-length": String(shard.bytes) },
            }),
          );
          response = await cache.match(url);
        } catch {
          // Quota exceeded, or private mode. The session still works; it will just
          // download again next time. Failing here would be worse.
          response = undefined;
        }
      }
      if (response === undefined) {
        // Not cached, so consume the original response directly. Only reachable when
        // the Cache API is unavailable or refused the write.
        response = fetched;
      }
    }

    const body = response.body;
    if (body === null) {
      const buf = new Uint8Array(await response.arrayBuffer());
      write(buf, offset);
      offset += buf.length;
      received += buf.length;
      onProgress?.(received, manifest.bytes, 0);
      continue;
    }

    const reader = body.getReader();
    let lastPaint = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted === true) {
        await reader.cancel();
        throw new DOMException("Aborted", "AbortError");
      }
      write(value, offset);
      offset += value.length;
      received += value.length;

      // Throttled to ~10 Hz. Reporting per chunk is pure layout thrash on the main
      // thread for no extra information.
      const now = Date.now();
      if (now - lastPaint >= 100) {
        lastPaint = now;
        const seconds = Math.max(1, now - started) / 1000;
        onProgress?.(received, manifest.bytes, received / seconds);
      }
    }
  }

  onProgress?.(received, manifest.bytes, 0);

  if (received !== manifest.bytes) {
    throw new Error(
      `weights: expected ${manifest.bytes} bytes, received ${received}`,
    );
  }
  return { fromCache: cachedAll, bytes: received };
}
