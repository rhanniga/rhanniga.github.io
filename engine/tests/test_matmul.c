/* test_matmul.c -- self-checks for the GEMV kernels.
 *
 * These exist mainly for M10. When the SIMD paths arrive they must agree with the
 * scalar ones here, and a SIMD bug is otherwise indistinguishable from a bad
 * model: the output is plausible, slightly wrong, and impossible to eyeball.
 *
 *     make -C engine test
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../matmul.h"

static int g_failures;

static void check(int cond, const char *what) {
  printf("  %-58s %s\n", what, cond ? "ok" : "FAIL");
  if (!cond) g_failures++;
}

/* Deterministic PRNG, so a failure is reproducible. */
static uint32_t g_rng = 12345;
static float frand(void) {
  g_rng = g_rng * 1664525u + 1013904223u;
  return (float)((double)(g_rng >> 8) / 8388608.0 - 1.0);
}

/** Reference GEMV in double precision, to judge the fp32 one against. */
static void ref_f32(double *out, const float *x, const float *w, int n, int d) {
  for (int i = 0; i < d; i++) {
    double s = 0.0;
    for (int j = 0; j < n; j++) s += (double)w[(long)i * n + j] * (double)x[j];
    out[i] = s;
  }
}

static void test_half(void) {
  printf("ml_half_to_float\n");
  /* Raw half bit patterns with known values. */
  check(ml_half_to_float(0x0000) == 0.0f, "+0");
  check(ml_half_to_float(0x8000) == -0.0f, "-0");
  check(ml_half_to_float(0x3c00) == 1.0f, "1.0");
  check(ml_half_to_float(0xbc00) == -1.0f, "-1.0");
  check(ml_half_to_float(0x4000) == 2.0f, "2.0");
  check(fabsf(ml_half_to_float(0x3555) - 0.333252f) < 1e-5f, "~1/3");
  check(ml_half_to_float(0x7c00) > 1e30f, "+inf");
  /* Smallest subnormal: 2^-24. Exercised because the q4 scales can reach it when
   * a whole group of weights is tiny. */
  check(fabsf(ml_half_to_float(0x0001) - 5.9604645e-8f) < 1e-12f, "smallest subnormal");
  check(fabsf(ml_half_to_float(0x03ff) - 6.0975552e-5f) < 1e-10f, "largest subnormal");
}

static void test_f32(void) {
  printf("matmul_f32\n");
  const int n = 576, d = 128;
  float *x = malloc((size_t)n * 4);
  float *w = malloc((size_t)n * d * 4);
  float *out = malloc((size_t)d * 4);
  double *ref = malloc((size_t)d * 8);
  for (int i = 0; i < n; i++) x[i] = frand();
  for (long i = 0; i < (long)n * d; i++) w[i] = frand() * 0.05f;

  matmul_f32(out, x, w, n, d);
  ref_f32(ref, x, w, n, d);

  /* Measured against the sum of |terms|, not against the result.
   *
   * Relative-to-result is the wrong metric for a dot product: when the true sum
   * nearly cancels, the result can be arbitrarily small while the rounding error
   * stays proportional to the terms that produced it. That made the first version
   * of this test report 2.9e-05 and "fail" a perfectly correct kernel. The bound
   * that actually holds is |error| <= n * eps * sum|w_i * x_i|, so that is what is
   * checked. */
  double worst = 0.0;
  for (int i = 0; i < d; i++) {
    double magnitude = 0.0;
    for (int j = 0; j < n; j++) {
      magnitude += fabs((double)w[(long)i * n + j] * (double)x[j]);
    }
    const double backward = fabs(out[i] - ref[i]) / (magnitude > 0 ? magnitude : 1);
    if (backward > worst) worst = backward;
  }
  printf("    worst backward error %.2e (bound is n*eps = %.2e)\n", worst,
         (double)n * 1.1920929e-7);
  check(worst < (double)n * 1.1920929e-7, "within the fp32 accumulation bound");

  free(x); free(w); free(out); free(ref);
}

static void test_quantize_row(void) {
  printf("quantize_row\n");
  const int n = 256, group = 64;
  float x[256];
  int8_t xq[256];
  float xs[4];
  for (int i = 0; i < n; i++) x[i] = frand() * (float)(i / group + 1);

  quantize_row(xq, xs, x, n, group);

  double worst = 0.0;
  for (int g = 0; g < n / group; g++) {
    for (int j = 0; j < group; j++) {
      const double deq = (double)xq[g * group + j] * (double)xs[g];
      const double err = fabs(deq - (double)x[g * group + j]);
      /* One int8 step is scale; half a step is the best round-to-nearest can do. */
      if (err / (xs[g] > 0 ? xs[g] : 1) > worst) {
        worst = err / (xs[g] > 0 ? xs[g] : 1);
      }
    }
  }
  printf("    worst error %.3f quantization steps\n", worst);
  check(worst <= 0.5001, "never worse than half a step");

  /* Per-group scales must be independent: group 3 has ~4x the magnitude of
   * group 0, so a single global scale would show up here. */
  check(xs[3] > xs[0] * 2.0f, "scales adapt per group");

  /* An all-zero group must not divide by zero or produce NaN. */
  float z[64] = {0};
  int8_t zq[64];
  float zs[1];
  quantize_row(zq, zs, z, 64, 64);
  int zero_ok = (zs[0] == 0.0f);
  for (int i = 0; i < 64; i++) {
    if (zq[i] != 0) zero_ok = 0;
  }
  check(zero_ok, "an all-zero group yields zeros, not NaN");
}

/** Quantize to int8 the way convert.py does, for the q8 kernel test. */
static void make_q8(const float *w, int n, int d, int group, int8_t *wq, float *ws) {
  const int ng = n / group;
  for (int i = 0; i < d; i++) {
    for (int g = 0; g < ng; g++) {
      float amax = 0.0f;
      for (int j = 0; j < group; j++) {
        const float a = fabsf(w[(long)i * n + g * group + j]);
        if (a > amax) amax = a;
      }
      const float scale = amax / 127.0f;
      ws[(long)i * ng + g] = scale;
      const float inv = scale != 0.0f ? 1.0f / scale : 0.0f;
      for (int j = 0; j < group; j++) {
        const float v = w[(long)i * n + g * group + j] * inv;
        int q = (int)(v + (v >= 0 ? 0.5f : -0.5f));
        if (q > 127) q = 127;
        if (q < -127) q = -127;
        wq[(long)i * n + g * group + j] = (int8_t)q;
      }
    }
  }
}

static uint16_t float_to_half(float f) {
  /* Round-to-nearest-even, enough for building test fixtures. */
  union { float f; uint32_t u; } in = {f};
  const uint32_t sign = (in.u >> 31) & 1u;
  int exp = (int)((in.u >> 23) & 0xffu) - 127 + 15;
  uint32_t mant = in.u & 0x7fffffu;
  if (exp <= 0) return (uint16_t)(sign << 15);
  if (exp >= 31) return (uint16_t)((sign << 15) | 0x7c00u);
  uint16_t h = (uint16_t)((sign << 15) | ((uint32_t)exp << 10) | (mant >> 13));
  if ((mant & 0x1fffu) > 0x1000u) h++;
  return h;
}

/** Quantize to int4 exactly as convert.py packs it: element j and j+group/2 share
 *  byte j, biased by +8. */
static void make_q4(const float *w, int n, int d, int group, uint8_t *wq,
                    uint16_t *ws, float *deq) {
  const int ng = n / group, half = group / 2;
  for (int i = 0; i < d; i++) {
    for (int g = 0; g < ng; g++) {
      const float *src = w + (long)i * n + g * group;
      float extremum = 0.0f;
      float amax = 0.0f;
      for (int j = 0; j < group; j++) {
        if (fabsf(src[j]) > amax) { amax = fabsf(src[j]); extremum = src[j]; }
      }
      const float dscale = extremum / -8.0f;
      const uint16_t h = float_to_half(dscale);
      ws[(long)i * ng + g] = h;
      const float back = ml_half_to_float(h);
      const float inv = back != 0.0f ? 1.0f / back : 0.0f;
      int q[64];
      for (int j = 0; j < group; j++) {
        const float v = src[j] * inv;
        int qq = (int)(v + (v >= 0 ? 0.5f : -0.5f)) + 8;
        if (qq > 15) qq = 15;
        if (qq < 0) qq = 0;
        q[j] = qq;
        deq[(long)i * n + g * group + j] = (float)(qq - 8) * back;
      }
      uint8_t *packed = wq + (long)i * (n / 2) + g * half;
      for (int j = 0; j < half; j++) {
        packed[j] = (uint8_t)(q[j] | (q[j + half] << 4));
      }
    }
  }
}

static void test_q8(void) {
  printf("matmul_q8\n");
  const int n = 576, d = 64, group = 64;
  float *x = malloc((size_t)n * 4);
  float *w = malloc((size_t)n * d * 4);
  int8_t *wq = malloc((size_t)n * d);
  float *ws = malloc((size_t)d * (n / group) * 4);
  int8_t *xq = malloc((size_t)n);
  float *xs = malloc((size_t)(n / group) * 4);
  float *got = malloc((size_t)d * 4);
  float *want = malloc((size_t)d * 4);
  float *wdeq = malloc((size_t)n * d * 4);

  for (int i = 0; i < n; i++) x[i] = frand();
  for (long i = 0; i < (long)n * d; i++) w[i] = frand() * 0.05f;

  make_q8(w, n, d, group, wq, ws);
  for (int i = 0; i < d; i++) {
    for (int g = 0; g < n / group; g++) {
      for (int j = 0; j < group; j++) {
        const long k = (long)i * n + g * group + j;
        wdeq[k] = (float)wq[k] * ws[(long)i * (n / group) + g];
      }
    }
  }

  quantize_row(xq, xs, x, n, group);
  matmul_q8(got, xq, xs, wq, ws, n, d, group);

  /* The reference is dequantized weights times *dequantized* activations, so this
   * isolates the kernel's arithmetic from the quantization error itself. */
  float *xdeq = malloc((size_t)n * 4);
  for (int g = 0; g < n / group; g++) {
    for (int j = 0; j < group; j++) {
      xdeq[g * group + j] = (float)xq[g * group + j] * xs[g];
    }
  }
  matmul_f32(want, xdeq, wdeq, n, d);

  double worst = 0.0;
  for (int i = 0; i < d; i++) {
    const double scale = fabs(want[i]) > 1e-4 ? fabs(want[i]) : 1e-4;
    const double rel = fabs(got[i] - want[i]) / scale;
    if (rel > worst) worst = rel;
  }
  printf("    worst relative error vs dequantize-then-f32: %.2e\n", worst);
  check(worst < 1e-4, "equals dequantize-then-multiply");

  free(x); free(w); free(wq); free(ws); free(xq); free(xs);
  free(got); free(want); free(wdeq); free(xdeq);
}

static void test_q4(void) {
  printf("matmul_q4\n");
  const int n = 576, d = 64, group = 64;
  float *x = malloc((size_t)n * 4);
  float *w = malloc((size_t)n * d * 4);
  uint8_t *wq = malloc((size_t)n * d / 2);
  uint16_t *ws = malloc((size_t)d * (n / group) * 2);
  float *wdeq = malloc((size_t)n * d * 4);
  int8_t *xq = malloc((size_t)n);
  float *xs = malloc((size_t)(n / group) * 4);
  float *got = malloc((size_t)d * 4);
  float *want = malloc((size_t)d * 4);
  float *xdeq = malloc((size_t)n * 4);

  for (int i = 0; i < n; i++) x[i] = frand();
  for (long i = 0; i < (long)n * d; i++) w[i] = frand() * 0.05f;

  make_q4(w, n, d, group, wq, ws, wdeq);
  quantize_row(xq, xs, x, n, group);
  matmul_q4(got, xq, xs, wq, ws, n, d, group);

  for (int g = 0; g < n / group; g++) {
    for (int j = 0; j < group; j++) {
      xdeq[g * group + j] = (float)xq[g * group + j] * xs[g];
    }
  }
  matmul_f32(want, xdeq, wdeq, n, d);

  double worst = 0.0;
  for (int i = 0; i < d; i++) {
    const double scale = fabs(want[i]) > 1e-4 ? fabs(want[i]) : 1e-4;
    const double rel = fabs(got[i] - want[i]) / scale;
    if (rel > worst) worst = rel;
  }
  printf("    worst relative error vs dequantize-then-f32: %.2e\n", worst);
  check(worst < 1e-4, "equals dequantize-then-multiply");

  /* The nibble layout is load-bearing for the SIMD path: element j and j+half
   * share byte j. Verify the kernel reads it that way by planting a single
   * non-zero weight in the high nibble of byte 0 -- i.e. element `half` -- and
   * checking it lands there and nowhere else. */
  memset(wq, (uint8_t)(8 | (8 << 4)), (size_t)n * d / 2); /* all zeros after bias */
  for (long i = 0; i < (long)d * (n / group); i++) ws[i] = float_to_half(1.0f);
  wq[0] = (uint8_t)(8 | ((8 + 1) << 4)); /* element half of group 0 = +1 */
  for (int i = 0; i < n; i++) xq[i] = 0;
  for (int g = 0; g < n / group; g++) xs[g] = 1.0f;
  xq[group / 2] = 100; /* only element `half` is non-zero */
  matmul_q4(got, xq, xs, wq, ws, n, d, group);
  check(fabsf(got[0] - 100.0f) < 1e-3f, "high nibble of byte j is element j+group/2");

  xq[group / 2] = 0;
  xq[0] = 100; /* low nibble position, whose weight is zero */
  matmul_q4(got, xq, xs, wq, ws, n, d, group);
  check(fabsf(got[0]) < 1e-3f, "low nibble of byte j is element j");

  free(x); free(w); free(wq); free(ws); free(wdeq);
  free(xq); free(xs); free(got); free(want); free(xdeq);
}

int main(void) {
  test_half();
  test_f32();
  test_quantize_row();
  test_q8();
  test_q4();
  printf("\n%s\n", g_failures ? "FAILED" : "all matmul checks passed");
  return g_failures ? 1 : 0;
}
