/* platform_wasm.c -- the host layer for the freestanding wasm build.
 *
 * Everything libc would have provided, in about a hundred lines. That is the whole
 * argument for plain clang over Emscripten here: Emscripten's value is JS glue and
 * a libc, and this ABI is nineteen functions taking only i32 and f32 -- there is
 * nothing to glue, and this is the entire libc requirement.
 *
 * The result has ZERO wasm imports, which is asserted by the test harness. A module
 * with no imports needs no import object, cannot accidentally depend on a JS
 * callback, and has no reentrancy hazard.
 */
#include "platform.h"

#include "engine.h"
#include "expf_poly.h"

/* ── expf ────────────────────────────────────────────────────────────────── */

float ml_expf(float x) { return hslm_expf(x); }

/* ── Bump allocator ──────────────────────────────────────────────────────
 * The engine makes about six allocations for its whole lifetime, one of which is
 * the 87 MB weight buffer. A real allocator would be pure overhead, and a bump
 * pointer cannot fragment.
 *
 * __heap_base is provided by wasm-ld: the first address after the static data.
 */
extern unsigned char __heap_base;

#define WASM_PAGE 65536u

static unsigned long g_next;

static unsigned long memory_bytes(void) {
  return (unsigned long)__builtin_wasm_memory_size(0) * WASM_PAGE;
}

void *ml_alloc(uint32_t nbytes) {
  if (g_next == 0) g_next = (unsigned long)&__heap_base;

  const unsigned long start =
      (g_next + (HSLM_ALIGN - 1)) & ~(unsigned long)(HSLM_ALIGN - 1);
  const unsigned long end = start + (nbytes ? nbytes : 1);

  const unsigned long have = memory_bytes();
  if (end > have) {
    const unsigned long pages = (end - have + WASM_PAGE - 1) / WASM_PAGE;
    /* Returns the previous page count, or (size_t)-1 if it cannot grow. That
     * failure is the ONLY reliable out-of-memory signal available -- there is no
     * errno here -- so ml_init turns it into ML_ERR_OOM and the worker reports it
     * rather than trapping. */
    if (__builtin_wasm_memory_grow(0, pages) == (__SIZE_TYPE__)-1) return 0;
  }

  g_next = end;
  return (void *)start;
}

void ml_arena_reset(void) { g_next = 0; }

/* ── memcpy / memset / memmove ───────────────────────────────────────────
 * Compiled with -mbulk-memory, so clang lowers calls to these into the
 * memory.copy and memory.fill instructions directly. The symbols are still
 * defined because LTO occasionally emits a real call anyway, and an undefined
 * memcpy at link time would appear as an unexplained import.
 */

void *ml_memcpy(void *dst, const void *src, size_t n) {
  return __builtin_memcpy(dst, src, n);
}

void *ml_memset(void *dst, int c, size_t n) {
  return __builtin_memset(dst, c, n);
}

void *memcpy(void *dst, const void *src, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  for (size_t i = 0; i < n; i++) d[i] = s[i];
  return dst;
}

void *memset(void *dst, int c, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  for (size_t i = 0; i < n; i++) d[i] = (unsigned char)c;
  return dst;
}

void *memmove(void *dst, const void *src, size_t n) {
  unsigned char *d = (unsigned char *)dst;
  const unsigned char *s = (const unsigned char *)src;
  if (d == s || n == 0) return dst;
  if (d < s) {
    for (size_t i = 0; i < n; i++) d[i] = s[i];
  } else {
    for (size_t i = n; i > 0; i--) d[i - 1] = s[i - 1];
  }
  return dst;
}
