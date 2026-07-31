/* engine.h -- the ABI and the weight-file format.
 *
 * This file is the contract. tools/convert.py writes the format described here
 * and engine.c reads it; if they disagree the failure is silent and looks like a
 * bad model rather than a bad reader, so both sides are specified in one place.
 *
 * Derived from Andrej Karpathy's llama2.c (MIT). See LICENSE.llama2.c.
 *
 * Every pointer below is an offset into WebAssembly linear memory -- an i32 at the
 * JS boundary. No strings ever cross: tokenization happens in JavaScript, so the
 * engine's entire input surface is an array of int32 token ids. That is what lets
 * the engine be tested against a frozen token list with no tokenizer in the loop.
 */
#ifndef HSLM_ENGINE_H
#define HSLM_ENGINE_H

#include <stdint.h>

/* ── Status codes ───────────────────────────────────────────────────────── */
#define ML_OK 0
#define ML_ERR_MAGIC -1     /* bad magic or unsupported version              */
#define ML_ERR_TRUNCATED -2 /* buffer shorter than the header implies        */
#define ML_ERR_OOM -3       /* memory.grow refused                           */
#define ML_ERR_CTX -4       /* requested n_ctx exceeds header.max_seq_len    */
#define ML_ERR_QUANT -5     /* quant_type this build cannot decode           */
#define ML_ERR_STATE -6     /* called before ml_init, or after ml_shutdown   */

/* ── Quantization schemes ───────────────────────────────────────────────── */
#define HSLM_Q_F32 0  /* no quantization; for the native golden test only    */
#define HSLM_Q_Q8 1   /* int8 weights, fp32 scale per group                  */
#define HSLM_Q_Q4 2   /* int4 packed 2/byte, fp16 scale per group            */
#define HSLM_Q_HYBRID 3 /* int8 embedding/lm_head, int4 transformer blocks   */

#define HSLM_MAGIC "HSLM"
#define HSLM_VERSION 1
#define HSLM_HEADER_BYTES 256
/* Payload sections are padded to this, so SIMD loads never straddle the end. */
#define HSLM_ALIGN 16

/* ── File header ─────────────────────────────────────────────────────────
 * Exactly 256 bytes, little-endian. Fixed size and generously padded so a new
 * field does not change any existing offset.
 */
typedef struct {
  char magic[4];      /* "HSLM"                                              */
  int32_t version;    /* HSLM_VERSION                                        */

  int32_t dim;        /* model width, 576 for SmolLM2-135M                   */
  int32_t hidden_dim; /* FFN width, 1536                                     */
  int32_t n_layers;   /* 30                                                  */
  int32_t n_heads;    /* query heads, 9                                      */
  int32_t n_kv_heads; /* key/value heads, 3 -- so GQA with kv_mul == 3        */

  /* Stored explicitly rather than computed as dim/n_heads. It happens to work
   * out for this model, but 360M is 960/15 and relying on the coincidence is
   * how the upgrade path breaks. */
  int32_t head_dim;

  int32_t vocab_size;  /* 49152, or fewer if the vocabulary was pruned       */
  int32_t max_seq_len; /* also the number of rows in the shipped RoPE table  */

  int32_t quant_type; /* one of HSLM_Q_*                                     */
  int32_t group_size; /* quantization group, along the INPUT dim; 64         */

  /* When set, token_embedding doubles as the lm_head matrix. Both uses want
   * groups along `dim`, so one row-major [vocab][dim] tensor serves both --
   * do not "optimize" that into two layouts. */
  int32_t tied_embeddings;

  int32_t has_qkv_bias; /* 0 for Llama; 1 reserved for Qwen2                 */
  int32_t bos_id;       /* 1                                                 */
  int32_t eos_id;       /* 2 (<|im_end|>)                                    */

  float rms_eps;    /* 1e-5. A field, not a constant: Qwen uses 1e-6.        */
  float rope_theta; /* 100000. Informational -- the table below is shipped.   */

  uint8_t sha256[32]; /* of the payload, for cache keys                      */
  uint8_t pad[152];
} hslm_header;

/* ── Payload layout, immediately after the header ────────────────────────
 * Each section starts on an HSLM_ALIGN boundary.
 *
 *   1. RoPE table          fp32[max_seq_len][head_dim/2][2]  (cos, sin)
 *   2. RMSNorm weights     fp32[2 * n_layers + 1][dim]       never quantized
 *   3. token_embedding     quantized [vocab_size][dim]
 *   4. per layer, in order: wq wk wv wo w_gate w_down w_up
 *
 * All matrices are row-major [out][in] and computed as
 *   out[d] = sum over n of w[d][n] * x[n]
 * which is also how torch.nn.Linear stores its weight, so no transpose happens
 * anywhere in the pipeline.
 *
 * The cos/sin table is shipped rather than computed so the freestanding wasm
 * build needs no powf, sinf or cosf at all -- expf, for softmax and SiLU, ends up
 * the only math function that has to be written by hand.
 *
 * 🔴 The q and k projections are stored PRE-PERMUTED into the interleaved RoPE
 * convention -- pairs (2i, 2i+1) -- because HuggingFace stores them for its
 * half-split rotate_half, pairing i with i + head_dim/2. convert.py applies the
 * inverse permutation. Getting this wrong yields fluent nonsense that reads like
 * "the model is just small", which is why tools/convert.py verifies the
 * equivalence numerically before writing anything.
 */

/* ── Arena ───────────────────────────────────────────────────────────────
 * A bump allocator. The engine makes about six allocations for its whole
 * lifetime, so a real allocator would be pure overhead.
 */
void *ml_alloc(uint32_t nbytes); /* HSLM_ALIGN-aligned; NULL on OOM */
void ml_arena_reset(void);

/* ── Lifecycle ───────────────────────────────────────────────────────────
 * `w` MUST come from ml_alloc and already contain the .hslm bytes. The engine
 * reads it in place and never copies, so the weights exist exactly once in
 * linear memory -- which is the difference between ~120 MB and ~200 MB of peak
 * usage, and therefore between working and not working on a phone.
 */
int32_t ml_init(const uint8_t *w, uint32_t w_len, int32_t n_ctx);
void ml_shutdown(void);

/* ── Introspection, so the JS side hardcodes nothing ─────────────────────── */
int32_t ml_n_vocab(void);
int32_t ml_n_ctx(void);
int32_t ml_eos_id(void);
int32_t ml_bos_id(void);
const uint8_t *ml_model_sha256(void); /* 32 bytes */

/* ── Generation ──────────────────────────────────────────────────────────
 * One token per call, at absolute position `pos`; writes KV[pos] and fills the
 * logits buffer. There is deliberately no batched prefill: decode is
 * compute-bound by roughly 11x over its memory traffic, so a GEMM kernel would
 * buy almost nothing while costing a second matmul and a second set of bugs.
 * JS drives the loop and yields between calls, which is also what makes
 * cancellation work without SharedArrayBuffer.
 */
void ml_forward(int32_t token, int32_t pos);
const float *ml_logits(void); /* n_vocab floats; the pointer is stable */

int32_t ml_sample(float temp, float top_p, int32_t top_k, float rep_penalty,
                  int32_t rep_window);
void ml_seed(uint32_t lo, uint32_t hi);
void ml_history_clear(void); /* forget the repetition-penalty window */

/* ── KV snapshot ─────────────────────────────────────────────────────────
 * Written in a COMPACTED layout -- [layer][pos][kv_dim] over exactly n_pos
 * positions, not a slice of the live [layer][n_ctx][kv_dim] array. Otherwise a
 * snapshot taken at n_ctx=1024 could not be loaded into a mobile session running
 * at n_ctx=512, and that is the sort of thing only discovered on a phone.
 */
uint32_t ml_kv_bytes(int32_t n_pos);
void ml_kv_save(uint8_t *dst, int32_t n_pos);
void ml_kv_load(const uint8_t *src, int32_t n_pos);

#endif /* HSLM_ENGINE_H */
