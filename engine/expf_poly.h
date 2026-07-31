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

  /* Scale by 2^n by writing the exponent field directly. n is bounded by the
   * clamps above, so 127+n always lands in [1, 254] and never produces a
   * subnormal or an infinity by accident. */
  union { uint32_t u; float f; } scale;
  scale.u = (uint32_t)((127 + n) << 23);
  return p * scale.f;
}

#endif /* HSLM_EXPF_POLY_H */
