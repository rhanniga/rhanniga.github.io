/* matmul.c -- scalar reference implementations.
 *
 * These are the correctness oracle. M10 adds SIMD paths behind
 * `#if defined(__wasm_simd128__)` and asserts they agree with these to within
 * 1e-6 on random input -- which is the only reliable way to find a SIMD bug,
 * since the symptom is otherwise indistinguishable from a bad model.
 *
 * Derived from Karpathy's llama2.c (MIT). See LICENSE.llama2.c.
 */
#include "matmul.h"

/* ── SIMD ────────────────────────────────────────────────────────────────
 * Present only on the wasm SIMD build. LLVM's auto-vectorizer does not produce
 * anything close to this for the nibble-unpacking inner loop, so the intrinsics
 * are written out.
 *
 * The design constraint that matters most is NOT speed: it is that the quantized
 * kernels must produce bit-identical results to the scalar ones. They do, and for
 * a specific reason -- all the SIMD work is INTEGER, and integer addition is exact
 * and associative, so reassociating it across lanes changes nothing. The float
 * operations (scaling each group's dot product and summing across groups) stay in
 * exactly the scalar order.
 *
 * That is what lets the wasm build be checked against the native build
 * token-for-token rather than merely "close enough", which in turn is what makes a
 * SIMD bug findable at all: a wrong SIMD kernel is otherwise indistinguishable
 * from a slightly worse model.
 */
#if defined(__wasm_simd128__)
#include <wasm_simd128.h>

/**
 * Sum of 16 signed byte products, widened to four i32 lanes.
 *
 * extmul + extadd_pairwise rather than i32x4.dot_i16x8_s: MVP SIMD has no
 * i32x4.dot_i8x16, and widening to i16 first would cost an extra pair of
 * instructions. Each pairwise add happens in i32, so there is no i16 overflow
 * even at the q8 worst case of 127*127 per product.
 */
static inline v128_t dot16(v128_t a, v128_t b) {
  const v128_t lo = wasm_i16x8_extmul_low_i8x16(a, b);
  const v128_t hi = wasm_i16x8_extmul_high_i8x16(a, b);
  return wasm_i32x4_add(wasm_i32x4_extadd_pairwise_i16x8(lo),
                        wasm_i32x4_extadd_pairwise_i16x8(hi));
}

static inline int32_t hsum_i32x4(v128_t v) {
  return wasm_i32x4_extract_lane(v, 0) + wasm_i32x4_extract_lane(v, 1) +
         wasm_i32x4_extract_lane(v, 2) + wasm_i32x4_extract_lane(v, 3);
}

/**
 * One group's int8 x int4 dot product.
 *
 * Byte j holds element j in its low nibble and element j+half in its high nibble,
 * so masking and shifting a single 16-byte load yields two CONTIGUOUS 16-element
 * runs -- which is why convert.py packs it that way. Interleaved (2i, 2i+1) packing
 * would need a shuffle here, in the hottest loop in the project.
 */
static inline int32_t group_dot_q4(const uint8_t *packed, const int8_t *xlo,
                                   const int8_t *xhi, int half) {
  const v128_t mask = wasm_i8x16_splat(0x0f);
  const v128_t bias = wasm_i8x16_splat(8);
  v128_t acc = wasm_i32x4_splat(0);
  for (int j = 0; j < half; j += 16) {
    const v128_t p = wasm_v128_load(packed + j);
    const v128_t lo = wasm_i8x16_sub(wasm_v128_and(p, mask), bias);
    const v128_t hi = wasm_i8x16_sub(wasm_u8x16_shr(p, 4), bias);
    acc = wasm_i32x4_add(acc, dot16(lo, wasm_v128_load(xlo + j)));
    acc = wasm_i32x4_add(acc, dot16(hi, wasm_v128_load(xhi + j)));
  }
  return hsum_i32x4(acc);
}

static inline int32_t group_dot_q8(const int8_t *w, const int8_t *x, int group) {
  v128_t acc = wasm_i32x4_splat(0);
  for (int j = 0; j < group; j += 16) {
    acc = wasm_i32x4_add(acc, dot16(wasm_v128_load(w + j), wasm_v128_load(x + j)));
  }
  return hsum_i32x4(acc);
}
#endif /* __wasm_simd128__ */

float ml_half_to_float(uint16_t h) {
  /* Bit-twiddling rather than _Float16: the freestanding wasm build has no half
   * type, and doing it identically on both targets means the scales cannot decode
   * differently under wasm than they do natively. */
  const uint32_t sign = (uint32_t)(h & 0x8000u) << 16;
  const uint32_t exp = (h >> 10) & 0x1fu;
  const uint32_t mant = h & 0x3ffu;
  union {
    uint32_t u;
    float f;
  } out;

  if (exp == 0) {
    if (mant == 0) {
      out.u = sign; /* +/-0 */
    } else {
      /* Subnormal: value is mant * 2^-24. Normalize by shifting the mantissa up
       * until bit 10 is set, then bias the exponent.
       *
       * The bias is 113 - e, not 112 - e. A half subnormal with mant == 1 is
       * exactly 2^-24, whose fp32 exponent field is 127 - 24 = 103; shifting
       * mant == 1 up to bit 10 takes e == 10, so 113 - 10 = 103. Getting this
       * off by one halves every subnormal scale -- which q4 group scales do reach
       * when a whole group of weights is tiny. */
      uint32_t e = 0;
      uint32_t m = mant;
      while ((m & 0x400u) == 0) {
        m <<= 1;
        e++;
      }
      m &= 0x3ffu;
      out.u = sign | ((113 - e) << 23) | (m << 13);
    }
  } else if (exp == 0x1fu) {
    out.u = sign | 0x7f800000u | (mant << 13); /* inf / NaN */
  } else {
    out.u = sign | ((exp + 127 - 15) << 23) | (mant << 13);
  }
  return out.f;
}

void matmul_f32(float *out, const float *x, const float *w, int n, int d) {
  for (int i = 0; i < d; i++) {
    const float *row = w + (long)i * n;
    float sum = 0.0f;
    for (int j = 0; j < n; j++) sum += row[j] * x[j];
    out[i] = sum;
  }
}

void quantize_row(int8_t *xq, float *xs, const float *x, int n, int group) {
  const int n_groups = n / group;
  for (int g = 0; g < n_groups; g++) {
    const float *src = x + g * group;
    float amax = 0.0f;
    for (int j = 0; j < group; j++) {
      const float a = src[j] < 0.0f ? -src[j] : src[j];
      if (a > amax) amax = a;
    }
    const float scale = amax / 127.0f;
    xs[g] = scale;
    const float inv = scale != 0.0f ? 1.0f / scale : 0.0f;
    for (int j = 0; j < group; j++) {
      /* Round-half-away-from-zero, matching numpy's rint closely enough that the
       * converter's dequantized preview and the engine agree. */
      const float v = src[j] * inv;
      int q = (int)(v + (v >= 0.0f ? 0.5f : -0.5f));
      if (q > 127) q = 127;
      if (q < -127) q = -127;
      xq[g * group + j] = (int8_t)q;
    }
  }
}

void matmul_q8(float *out, const int8_t *xq, const float *xs, const int8_t *wq,
               const float *ws, int n, int d, int group) {
  const int n_groups = n / group;
  for (int i = 0; i < d; i++) {
    const int8_t *wrow = wq + (long)i * n;
    const float *wscale = ws + (long)i * n_groups;
    float sum = 0.0f;
    for (int g = 0; g < n_groups; g++) {
      const int base = g * group;
      int32_t acc;
#if defined(__wasm_simd128__)
      if ((group & 15) == 0) {
        acc = group_dot_q8(wrow + base, xq + base, group);
      } else
#endif
      {
        acc = 0;
        for (int j = 0; j < group; j++) {
          acc += (int32_t)wrow[base + j] * (int32_t)xq[base + j];
        }
      }
      sum += (float)acc * wscale[g] * xs[g];
    }
    out[i] = sum;
  }
}

void matmul_q4(float *out, const int8_t *xq, const float *xs, const uint8_t *wq,
               const uint16_t *ws, int n, int d, int group) {
  const int n_groups = n / group;
  const int half = group / 2;
  for (int i = 0; i < d; i++) {
    const uint8_t *wrow = wq + (long)i * (n / 2);
    const uint16_t *wscale = ws + (long)i * n_groups;
    float sum = 0.0f;
    for (int g = 0; g < n_groups; g++) {
      const uint8_t *packed = wrow + g * half;
      const int8_t *xlo = xq + g * group;
      const int8_t *xhi = xlo + half;
      int32_t acc;
#if defined(__wasm_simd128__)
      if ((half & 15) == 0) {
        acc = group_dot_q4(packed, xlo, xhi, half);
      } else
#endif
      {
        acc = 0;
        /* Byte j carries element j in its low nibble and element j+half in its
         * high nibble, so the two halves stay contiguous. Both are biased by +8. */
        for (int j = 0; j < half; j++) {
          const uint8_t byte = packed[j];
          const int32_t lo = (int32_t)(byte & 0x0fu) - 8;
          const int32_t hi = (int32_t)(byte >> 4) - 8;
          acc += lo * (int32_t)xlo[j] + hi * (int32_t)xhi[j];
        }
      }
      /* |w| <= 8 and |x| <= 127 so a group of 64 peaks at 64*8*127 = 65024,
       * comfortably inside int32 -- which is what lets the SIMD version widen
       * once per group rather than once per multiply. */
      sum += (float)acc * ml_half_to_float(wscale[g]) * xs[g];
    }
    out[i] = sum;
  }
}
