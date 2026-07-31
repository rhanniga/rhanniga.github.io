/* matmul.h -- the GEMVs, which are ~99% of the runtime.
 *
 * Every matrix is row-major [out][in] and every call computes
 *   out[d] = sum over n of w[d][n] * x[n]
 * which is also how torch.nn.Linear stores its weight, so nothing transposes
 * anywhere in the pipeline.
 *
 * M8 uses the fp32 path only. The quantized paths arrive in M9, and the SIMD
 * implementations in M10 -- at which point the scalar versions here stay as the
 * correctness oracle they are tested against.
 */
#ifndef HSLM_MATMUL_H
#define HSLM_MATMUL_H

#include <stdint.h>

/**
 * fp32 weights.
 * @param out  [d]
 * @param x    [n]
 * @param w    [d][n] row-major
 */
void matmul_f32(float *out, const float *x, const float *w, int n, int d);

/**
 * int8 weights with one fp32 scale per group of `group` along the input dim.
 * Activations are quantized to int8 at runtime by quantize_row().
 *
 * @param xq  [n]              int8 activations
 * @param xs  [n/group]        fp32 activation scales
 * @param wq  [d][n]           int8 weights
 * @param ws  [d][n/group]     fp32 weight scales
 */
void matmul_q8(float *out, const int8_t *xq, const float *xs, const int8_t *wq,
               const float *ws, int n, int d, int group);

/**
 * int4 weights, two per byte, with one fp16 scale per group.
 *
 * Packing places element j and element j+group/2 in the low and high nibbles of
 * byte j, so masking and shifting a 16-byte SIMD load yields two *contiguous*
 * 16-element runs. Packing (2i, 2i+1) instead would interleave them and cost a
 * shuffle in the hottest loop in the project.
 *
 * @param wq  [d][n/2]         packed nibbles, biased by +8
 * @param ws  [d][n/group]     fp16 scales, as raw uint16
 */
void matmul_q4(float *out, const int8_t *xq, const float *xs, const uint8_t *wq,
               const uint16_t *ws, int n, int d, int group);

/**
 * Quantize one activation row to int8, one scale per group.
 * @param xq  [n]         output
 * @param xs  [n/group]   output scales
 */
void quantize_row(int8_t *xq, float *xs, const float *x, int n, int group);

/** Decode an IEEE half. Used for the q4 scales; there is no _Float16 in the
 *  freestanding wasm build. */
float ml_half_to_float(uint16_t h);

#endif /* HSLM_MATMUL_H */
