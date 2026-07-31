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
      int32_t acc = 0;
      const int base = g * group;
      for (int j = 0; j < group; j++) {
        acc += (int32_t)wrow[base + j] * (int32_t)xq[base + j];
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
      int32_t acc = 0;
      const uint8_t *packed = wrow + g * half;
      const int8_t *xlo = xq + g * group;
      const int8_t *xhi = xlo + half;
      /* Byte j carries element j in its low nibble and element j+half in its
       * high nibble, so the two halves stay contiguous. Both are biased by +8. */
      for (int j = 0; j < half; j++) {
        const uint8_t byte = packed[j];
        const int32_t lo = (int32_t)(byte & 0x0fu) - 8;
        const int32_t hi = (int32_t)(byte >> 4) - 8;
        acc += lo * (int32_t)xlo[j] + hi * (int32_t)xhi[j];
      }
      /* |w| <= 8 and |x| <= 127 so a group of 64 peaks at 64*8*127 = 65024,
       * comfortably inside int32 -- which is what lets the SIMD version widen
       * once per group rather than once per multiply. */
      sum += (float)acc * ml_half_to_float(wscale[g]) * xs[g];
    }
    out[i] = sum;
  }
}
