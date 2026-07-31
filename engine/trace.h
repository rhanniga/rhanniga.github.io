/* trace.h -- bisection instrumentation, native builds only.
 *
 * "The logits are wrong" is not a debuggable statement. These accumulators
 * reproduce exactly the checksums tools/golden_logits.py records from PyTorch, so
 * a divergence can be localised to the layer where it starts rather than merely
 * observed at the output.
 *
 * The checksums are reductions -- sum, abs_sum, sum_sq, min, max -- which is what
 * makes this work at all: HuggingFace computes them over the whole [1, seq, dim]
 * tensor, while this engine sees one position at a time. Every one of those
 * reductions composes across positions, so accumulating per forward call and
 * comparing totals is exact rather than approximate.
 *
 * Compiled out entirely unless ML_TRACE is defined.
 */
#ifndef HSLM_TRACE_H
#define HSLM_TRACE_H

/**
 * Fold one tensor into the accumulator named `name`. Successive calls with the
 * same name within one forward pass are treated as successive layers.
 */
void ml_trace_accumulate(const char *name, const float *data, int n);

/** Start a new forward pass, so per-layer names line up again. */
void ml_trace_begin_step(void);

/** Print every accumulator as JSON, for engine/tests/check_golden.py. */
void ml_trace_dump(void);

#endif /* HSLM_TRACE_H */
