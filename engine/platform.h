/* platform.h -- the small surface engine.c needs from its host.
 *
 * engine.c and matmul.c are toolchain-agnostic and include only this and
 * engine.h. platform_native.c forwards to libc; platform_wasm.c (M10) implements
 * the same handful of functions freestanding.
 *
 * That split is the single decision that makes this debuggable: the same engine
 * sources build natively, where gdb, ASan and valgrind all work, and for wasm,
 * where none of them do.
 */
#ifndef HSLM_PLATFORM_H
#define HSLM_PLATFORM_H

#include <stddef.h>
#include <stdint.h>

/* The only transcendental the engine needs, for softmax and for SiLU as
 * x / (1 + expf(-x)). sqrtf is a hardware instruction on both targets, and
 * powf/sinf/cosf are avoided entirely because the RoPE table is shipped in the
 * weights file rather than computed. */
float ml_expf(float x);

/* Bump allocator. HSLM_ALIGN-aligned, NULL when out of memory. The engine makes
 * about six allocations for its whole lifetime, so a real allocator would be
 * pure overhead. */
void *ml_alloc(uint32_t nbytes);
void ml_arena_reset(void);

void *ml_memcpy(void *dst, const void *src, size_t n);
void *ml_memset(void *dst, int c, size_t n);

#endif /* HSLM_PLATFORM_H */
