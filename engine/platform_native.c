/* platform_native.c -- the host layer for native builds.
 *
 * Forwards to libc. Its whole reason for existing is that the wasm build cannot,
 * so keeping the boundary explicit means engine.c never reaches for something the
 * freestanding target does not have.
 *
 * The arena here uses malloc rather than a fixed slab so ASan and valgrind can
 * see individual allocations -- catching a bug the wasm bump allocator would
 * silently absorb into its own slab.
 */
#include "platform.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "engine.h"
#include "expf_poly.h"

#define MAX_BLOCKS 64

static void *g_blocks[MAX_BLOCKS];
static int g_n_blocks;

/* The SAME polynomial the wasm build uses, not libm's expf.
 *
 * This matters more than it looks. The quantized SIMD kernels are bit-identical to
 * the scalar ones by construction -- all their work is integer -- so the wasm and
 * native builds ought to agree token-for-token, which is what makes a SIMD bug
 * findable. They did not: they agreed for 14 tokens and then diverged, because
 * libm's expf and this polynomial differ in the last couple of bits, and softmax
 * runs 30 times per token. A near-tie eventually flips.
 *
 * So both targets share one expf, and the divergence is gone. It also means the
 * polynomial is exercised by every native test rather than only in the browser --
 * an expf wrong only under wasm would have presented as "the model is worse online".
 *
 * Build with -DML_LIBM_EXPF to get libm's instead, which is how the polynomial's
 * accuracy is measured against it.
 */
#ifdef ML_LIBM_EXPF
float ml_expf(float x) { return expf(x); }
#else
float ml_expf(float x) { return hslm_expf(x); }
#endif

void *ml_alloc(uint32_t nbytes) {
  if (g_n_blocks >= MAX_BLOCKS) {
    fprintf(stderr, "ml_alloc: too many blocks (raise MAX_BLOCKS)\n");
    return NULL;
  }
  /* Match the wasm arena's alignment guarantee exactly, so an alignment
   * assumption that holds natively cannot fail only under wasm.
   *
   * aligned_alloc rather than posix_memalign: it is standard C11 and needs no
   * _POSIX_C_SOURCE feature macro, which -std=c11 would otherwise require. C11
   * also wants the size to be a multiple of the alignment, so round up. */
  size_t size = nbytes ? (size_t)nbytes : 1;
  size = (size + (HSLM_ALIGN - 1)) & ~(size_t)(HSLM_ALIGN - 1);
  void *p = aligned_alloc(HSLM_ALIGN, size);
  if (!p) return NULL;
  g_blocks[g_n_blocks++] = p;
  return p;
}

void ml_arena_reset(void) {
  for (int i = 0; i < g_n_blocks; i++) free(g_blocks[i]);
  g_n_blocks = 0;
}

void *ml_memcpy(void *dst, const void *src, size_t n) { return memcpy(dst, src, n); }
void *ml_memset(void *dst, int c, size_t n) { return memset(dst, c, n); }
