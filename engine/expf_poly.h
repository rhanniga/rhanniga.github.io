/* expf_poly.h -- expf without libm.
 *
 * The only transcendental the engine needs: softmax, and SiLU as x/(1+expf(-x)).
 * powf, sinf and cosf are avoided entirely because the RoPE cos/sin table ships in
 * the weights file -- which is what makes a freestanding wasm build cheap rather
 * than a project of its own.
 *
 * Kept in a header, and portable, so the identical code that runs under wasm can
 * be compiled natively and checked against libm. An expf that is subtly wrong only
 * on the wasm target would present as "the model is worse in the browser", which
 * is close to undebuggable.
 *
 * Accuracy target is ~1e-6 relative, which is far more than a 4-bit 135M model can
 * possibly care about.
 */
#ifndef HSLM_EXPF_POLY_H
#define HSLM_EXPF_POLY_H

#include <stdint.h>

/* expf overflows to inf above ~88.72 and flushes to zero below ~-103.97. */
#define HSLM_EXP_MAX 88.7228f
#define HSLM_EXP_MIN (-103.972f)

static inline float hslm_expf(float x) {
  /* NaN propagates. */
  if (x != x) return x;
  if (x > HSLM_EXP_MAX) {
    union { uint32_t u; float f; } inf = {0x7f800000u};
    return inf.f;
  }
  if (x < HSLM_EXP_MIN) return 0.0f;

  /* exp(x) = 2^(x*log2(e)); split into an integer power of two and a remainder
   * in [-0.5, 0.5], where a short polynomial is accurate. */
  const float LOG2E = 1.44269504088896341f;
  const float t = x * LOG2E;
  const int n = (int)(t + (t >= 0.0f ? 0.5f : -0.5f));
  const float r = t - (float)n;

  /* Minimax coefficients for 2^r on [-0.5, 0.5]: the Taylor series of 2^r, i.e.
   * (ln2)^k / k!, which is accurate enough here and needs no table. */
  const float p =
      1.0f +
      r * (0.6931471805599453f +
           r * (0.2402265069591007f +
                r * (0.0555041086648216f +
                     r * (0.0096181291076285f +
                          r * (0.0013333558146429f +
                               r * 0.0001540353039338f)))));

  /* Scale by 2^n by writing the exponent field directly.
   *
   * The comment here used to claim that the clamps above kept 127+n inside [1, 254].
   * They do not, and the gap between what it claimed and what it did was the worst
   * bug in the engine. expf's result goes subnormal below x = -87.34 and only flushes
   * to zero at -103.97, so for x in that window n reaches -150 and 127+n goes
   * NEGATIVE -- a left shift of a negative int, which is undefined behaviour, and
   * which clang compiled into a shift of the two's-complement pattern. exp(-103.9)
   * came back as 7.9e31 instead of 1e-45.
   *
   * That window is not exotic. softmax subtracts the max and `ask` divides the logits
   * by temperature 0.4 first, so over a 49k vocabulary x-max reaches -103 on an
   * ordinary question. Roughly forty tail tokens came back as the most probable in the
   * vocabulary, which pushed the real answer below the top-k cutoff. The symptom was
   * `ask` replying with a single letter and stopping -- and it was invisible at
   * temperature 0, which takes the argmax and never calls expf at all, so every golden
   * test passed.
   *
   * So the scale is applied in two steps whenever one exponent field cannot hold it.
   * n is bounded by the clamps above to [-150, 128], which leaves both halves in
   * range, and multiplying in this order (p * s1 first) keeps the top of the range
   * finite: exp(88.7228) lands on 3.4e38 rather than overflowing to inf. */
  int hi = n, lo = 0;
  if (hi > 127) {
    lo = hi - 127;
    hi = 127;
  } else if (hi < -126) {
    lo = hi + 126;
    hi = -126;
  }
  union { uint32_t u; float f; } s_hi, s_lo;
  s_hi.u = (uint32_t)((127 + hi) << 23);
  s_lo.u = (uint32_t)((127 + lo) << 23);
  return p * s_hi.f * s_lo.f;
}

#endif /* HSLM_EXPF_POLY_H */
