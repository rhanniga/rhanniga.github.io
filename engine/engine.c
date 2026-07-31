/* engine.c -- the transformer forward pass.
 *
 * Derived from Andrej Karpathy's llama2.c (MIT). See LICENSE.llama2.c.
 *
 * Architecture is plain Llama: RMSNorm, GQA attention with RoPE, SwiGLU MLP, and
 * a tied lm_head. Two things differ from upstream llama2.c and both matter:
 *
 *   - RoPE angles come from a table shipped in the weights file, not from powf.
 *     That removes powf/sinf/cosf from the freestanding wasm build entirely.
 *   - q and k projections arrive already permuted into the interleaved-pair
 *     convention by tools/convert.py, so there is exactly one RoPE convention in
 *     this file. HuggingFace's half-split layout never appears here.
 */
#include "engine.h"

#include "matmul.h"
#include "platform.h"

/* ── State ──────────────────────────────────────────────────────────────── */

typedef struct {
  /* Pointers into the caller's weight buffer. Nothing here is owned or copied:
   * the weights exist exactly once in memory, which on a phone is the difference
   * between ~120 MB and ~200 MB of peak usage. */
  const float *rope;  /* [max_seq_len][head_dim/2][2] */
  const float *norms; /* [2*n_layers + 1][dim], fp32 always */
  const void *embed;  /* also the lm_head when tied */
  const float *embed_scales;

  /* One entry per layer, in the order convert.py writes them. */
  const void *wq, *wk, *wv, *wo, *w_gate, *w_down, *w_up;
  const void *wq_s, *wk_s, *wv_s, *wo_s, *w_gate_s, *w_down_s, *w_up_s;

  /* Byte stride between successive layers' copies of each matrix. */
  long stride_q, stride_k, stride_v, stride_o, stride_gate, stride_down, stride_up;
  long sstride_q, sstride_k, sstride_v, sstride_o, sstride_gate, sstride_down, sstride_up;
} Weights;

typedef struct {
  float *x;      /* [dim] the residual stream */
  float *xb;     /* [dim] scratch */
  float *xb2;    /* [dim] scratch */
  float *hb;     /* [hidden_dim] */
  float *hb2;    /* [hidden_dim] */
  float *q;      /* [n_heads * head_dim] */
  float *att;    /* [n_heads * n_ctx] */
  float *logits; /* [vocab_size] */

  int8_t *xq;  /* [max(dim, hidden_dim)] quantized activations */
  float *xs;   /* [max(dim, hidden_dim) / group] */

  float *k_cache; /* [n_layers][n_ctx][kv_dim] */
  float *v_cache;

  /* Repetition-penalty ring. llama2.c has none, and a 135M model at temp 0.5
   * loops within about 40 tokens without it. */
  int32_t *history;
  int history_len;
  int history_pos;

  uint64_t rng;
} Runtime;

static struct {
  int ready;
  hslm_header h;
  int n_ctx;
  int kv_dim;
  int kv_mul;
  Weights w;
  Runtime r;
} G;

/* ── Payload walking ────────────────────────────────────────────────────── */

/* Mirrors tools/convert.py's Payload.add: every section is padded UP to
 * HSLM_ALIGN before it starts. Keeping the two in lockstep is why the format is
 * documented in engine.h rather than in either implementation. */
static long align_up(long off) {
  const long r = off % HSLM_ALIGN;
  return r == 0 ? off : off + (HSLM_ALIGN - r);
}

/** Bytes one [d][n] matrix occupies, and its scale array, for a given scheme. */
static void matrix_bytes(int quant, int group, long d, long n, long *data,
                         long *scales) {
  switch (quant) {
    case HSLM_Q_F32:
      *data = d * n * 4;
      *scales = 0;
      break;
    case HSLM_Q_Q8:
      *data = d * n;
      *scales = d * (n / group) * 4;
      break;
    default: /* HSLM_Q_Q4 */
      *data = d * (n / 2);
      *scales = d * (n / group) * 2;
      break;
  }
}

int32_t ml_init(const uint8_t *w, uint32_t w_len, int32_t n_ctx) {
  if (w == NULL || w_len < HSLM_HEADER_BYTES) return ML_ERR_TRUNCATED;

  hslm_header h;
  ml_memcpy(&h, w, sizeof h);

  if (h.magic[0] != 'H' || h.magic[1] != 'S' || h.magic[2] != 'L' ||
      h.magic[3] != 'M' || h.version != HSLM_VERSION) {
    return ML_ERR_MAGIC;
  }
  if (n_ctx <= 0 || n_ctx > h.max_seq_len) return ML_ERR_CTX;

  /* Which schemes each tensor uses. The hybrid case is the whole reason these are
   * tracked separately: the quantization gate measured all-int4 degrading
   * perplexity by 56%, almost entirely through the tied embedding, so that one
   * tensor is int8 while the blocks stay int4. */
  int embed_quant, block_quant;
  switch (h.quant_type) {
    case HSLM_Q_F32:
      embed_quant = block_quant = HSLM_Q_F32;
      break;
    case HSLM_Q_Q8:
      embed_quant = block_quant = HSLM_Q_Q8;
      break;
    case HSLM_Q_Q4:
      embed_quant = block_quant = HSLM_Q_Q4;
      break;
    case HSLM_Q_HYBRID:
      embed_quant = HSLM_Q_Q8;
      block_quant = HSLM_Q_Q4;
      break;
    default:
      return ML_ERR_QUANT;
  }

  const int dim = h.dim, hidden = h.hidden_dim, group = h.group_size;
  const long q_dim = (long)h.n_heads * h.head_dim;
  const long kv_dim = (long)h.n_kv_heads * h.head_dim;

  const uint8_t *base = w + HSLM_HEADER_BYTES;
  const long avail = (long)w_len - HSLM_HEADER_BYTES;
  long off = 0;

  /* 1. RoPE table. */
  const long rope_bytes = (long)h.max_seq_len * (h.head_dim / 2) * 2 * 4;
  G.w.rope = (const float *)(base + off);
  off += rope_bytes;

  /* 2. RMSNorm weights, never quantized. */
  off = align_up(off);
  G.w.norms = (const float *)(base + off);
  off += (2L * h.n_layers + 1) * dim * 4;

  /* 3. Token embedding, which is also the lm_head when tied. */
  off = align_up(off);
  long data_bytes, scale_bytes;
  matrix_bytes(embed_quant, group, h.vocab_size, dim, &data_bytes, &scale_bytes);
  G.w.embed = base + off;
  G.w.embed_scales = (const float *)(base + off + data_bytes);
  off += data_bytes + scale_bytes;

  /* 4. Layer weights, in convert.py's order: wq wk wv wo gate down up.
   *
   * Each is stored contiguously per layer, so the per-layer stride is just the
   * total size of one layer's seven matrices -- which is why the pointers below
   * are captured from layer 0 and indexed by stride afterwards. */
  struct {
    const void **data;
    const void **scales;
    long *stride;
    long *sstride;
    long d, n;
  } mats[7] = {
      {&G.w.wq, &G.w.wq_s, &G.w.stride_q, &G.w.sstride_q, q_dim, dim},
      {&G.w.wk, &G.w.wk_s, &G.w.stride_k, &G.w.sstride_k, kv_dim, dim},
      {&G.w.wv, &G.w.wv_s, &G.w.stride_v, &G.w.sstride_v, kv_dim, dim},
      {&G.w.wo, &G.w.wo_s, &G.w.stride_o, &G.w.sstride_o, dim, q_dim},
      {&G.w.w_gate, &G.w.w_gate_s, &G.w.stride_gate, &G.w.sstride_gate, hidden, dim},
      {&G.w.w_down, &G.w.w_down_s, &G.w.stride_down, &G.w.sstride_down, dim, hidden},
      {&G.w.w_up, &G.w.w_up_s, &G.w.stride_up, &G.w.sstride_up, hidden, dim},
  };

  long layer_span = 0;
  for (int l = 0; l < h.n_layers; l++) {
    const long layer_start = off;
    for (int m = 0; m < 7; m++) {
      off = align_up(off);
      matrix_bytes(block_quant, group, mats[m].d, mats[m].n, &data_bytes,
                   &scale_bytes);
      if (l == 0) {
        *mats[m].data = base + off;
        *mats[m].scales = base + off + data_bytes;
      }
      off += data_bytes + scale_bytes;
    }
    if (l == 0) layer_span = off - layer_start;
  }
  for (int m = 0; m < 7; m++) {
    *mats[m].stride = layer_span;
    *mats[m].sstride = layer_span;
  }

  if (off > avail) return ML_ERR_TRUNCATED;

  /* ── Runtime buffers ──────────────────────────────────────────────────── */
  const int wide = hidden > dim ? hidden : dim;
  Runtime *r = &G.r;
  r->x = (float *)ml_alloc((uint32_t)(dim * 4));
  r->xb = (float *)ml_alloc((uint32_t)(dim * 4));
  r->xb2 = (float *)ml_alloc((uint32_t)(q_dim * 4));
  r->hb = (float *)ml_alloc((uint32_t)(hidden * 4));
  r->hb2 = (float *)ml_alloc((uint32_t)(hidden * 4));
  r->q = (float *)ml_alloc((uint32_t)(q_dim * 4));
  r->att = (float *)ml_alloc((uint32_t)((long)h.n_heads * n_ctx * 4));
  r->logits = (float *)ml_alloc((uint32_t)((long)h.vocab_size * 4));
  r->xq = (int8_t *)ml_alloc((uint32_t)wide);
  r->xs = (float *)ml_alloc((uint32_t)((wide / group + 1) * 4));
  r->k_cache = (float *)ml_alloc((uint32_t)((long)h.n_layers * n_ctx * kv_dim * 4));
  r->v_cache = (float *)ml_alloc((uint32_t)((long)h.n_layers * n_ctx * kv_dim * 4));
  r->history = (int32_t *)ml_alloc(64 * 4);

  if (!r->x || !r->xb || !r->xb2 || !r->hb || !r->hb2 || !r->q || !r->att ||
      !r->logits || !r->xq || !r->xs || !r->k_cache || !r->v_cache || !r->history) {
    return ML_ERR_OOM;
  }

  r->history_len = 0;
  r->history_pos = 0;
  r->rng = 0x853c49e6748fea9bULL;

  G.h = h;
  G.n_ctx = n_ctx;
  G.kv_dim = (int)kv_dim;
  G.kv_mul = h.n_heads / h.n_kv_heads;
  G.ready = 1;
  return ML_OK;
}

void ml_shutdown(void) {
  G.ready = 0;
  ml_arena_reset();
}

int32_t ml_n_vocab(void) { return G.h.vocab_size; }
int32_t ml_n_ctx(void) { return G.n_ctx; }
int32_t ml_eos_id(void) { return G.h.eos_id; }
int32_t ml_bos_id(void) { return G.h.bos_id; }
const uint8_t *ml_model_sha256(void) { return G.h.sha256; }
const float *ml_logits(void) { return G.r.logits; }

/* ── Kernels ────────────────────────────────────────────────────────────── */

static void rmsnorm(float *out, const float *x, const float *weight, int n,
                    float eps) {
  float ss = 0.0f;
  for (int i = 0; i < n; i++) ss += x[i] * x[i];
  /* 1/sqrt(mean + eps), matching LlamaRMSNorm. Computed in fp32 throughout, as
   * HF does when the model dtype is fp32. */
  const float scale = 1.0f / __builtin_sqrtf(ss / (float)n + eps);
  for (int i = 0; i < n; i++) out[i] = weight[i] * (x[i] * scale);
}

static void softmax(float *x, int n) {
  float max = x[0];
  for (int i = 1; i < n; i++) {
    if (x[i] > max) max = x[i];
  }
  float sum = 0.0f;
  for (int i = 0; i < n; i++) {
    x[i] = ml_expf(x[i] - max);
    sum += x[i];
  }
  const float inv = 1.0f / sum;
  for (int i = 0; i < n; i++) x[i] *= inv;
}

/** Dispatch one GEMV according to the scheme the weights were written with. */
static void gemv(float *out, const float *x, const void *w, const void *scales,
                 int n, int d, int quant, int group, Runtime *r) {
  if (quant == HSLM_Q_F32) {
    matmul_f32(out, x, (const float *)w, n, d);
    return;
  }
  quantize_row(r->xq, r->xs, x, n, group);
  if (quant == HSLM_Q_Q8) {
    matmul_q8(out, r->xq, r->xs, (const int8_t *)w, (const float *)scales, n, d,
              group);
  } else {
    matmul_q4(out, r->xq, r->xs, (const uint8_t *)w, (const uint16_t *)scales, n,
              d, group);
  }
}

/** Read row `row` of a quantized [rows][n] matrix into fp32. */
static void dequant_row(float *out, const void *w, const void *scales, long row,
                        int n, int quant, int group) {
  if (quant == HSLM_Q_F32) {
    ml_memcpy(out, (const float *)w + row * n, (size_t)n * 4);
    return;
  }
  const int n_groups = n / group;
  if (quant == HSLM_Q_Q8) {
    const int8_t *q = (const int8_t *)w + row * n;
    const float *s = (const float *)scales + row * n_groups;
    for (int g = 0; g < n_groups; g++) {
      for (int j = 0; j < group; j++) {
        out[g * group + j] = (float)q[g * group + j] * s[g];
      }
    }
    return;
  }
  const int half = group / 2;
  const uint8_t *packed = (const uint8_t *)w + row * (n / 2);
  const uint16_t *s = (const uint16_t *)scales + row * n_groups;
  for (int g = 0; g < n_groups; g++) {
    const float scale = ml_half_to_float(s[g]);
    const uint8_t *p = packed + g * half;
    for (int j = 0; j < half; j++) {
      out[g * group + j] = (float)((int)(p[j] & 0x0f) - 8) * scale;
      out[g * group + half + j] = (float)((int)(p[j] >> 4) - 8) * scale;
    }
  }
}

/* Optional instrumentation, so a divergence from the PyTorch reference can be
 * bisected to a layer instead of merely observed. Compiled out of the wasm build.
 */
#ifdef ML_TRACE
#include "trace.h"
#define TRACE(name, ptr, n) ml_trace_accumulate(name, ptr, n)
#else
#define TRACE(name, ptr, n) ((void)0)
#endif

void ml_forward(int32_t token, int32_t pos) {
  if (!G.ready) return;

  const hslm_header *h = &G.h;
  Runtime *r = &G.r;
  const Weights *w = &G.w;

  const int dim = h->dim, hidden = h->hidden_dim, head_dim = h->head_dim;
  const int group = h->group_size, kv_dim = G.kv_dim, kv_mul = G.kv_mul;
  const long q_dim = (long)h->n_heads * head_dim;

  int embed_quant, block_quant;
  if (h->quant_type == HSLM_Q_HYBRID) {
    embed_quant = HSLM_Q_Q8;
    block_quant = HSLM_Q_Q4;
  } else {
    embed_quant = block_quant = h->quant_type;
  }

  /* Embedding lookup: one row of the same matrix the lm_head uses. */
  dequant_row(r->x, w->embed, w->embed_scales, token, dim, embed_quant, group);
  TRACE("embed", r->x, dim);

  for (int l = 0; l < h->n_layers; l++) {
    const long off = (long)l * w->stride_q;
    const void *wq = (const uint8_t *)w->wq + off;
    const void *wk = (const uint8_t *)w->wk + off;
    const void *wv = (const uint8_t *)w->wv + off;
    const void *wo = (const uint8_t *)w->wo + off;
    const void *wg = (const uint8_t *)w->w_gate + off;
    const void *wd = (const uint8_t *)w->w_down + off;
    const void *wu = (const uint8_t *)w->w_up + off;
    const void *wq_s = (const uint8_t *)w->wq_s + off;
    const void *wk_s = (const uint8_t *)w->wk_s + off;
    const void *wv_s = (const uint8_t *)w->wv_s + off;
    const void *wo_s = (const uint8_t *)w->wo_s + off;
    const void *wg_s = (const uint8_t *)w->w_gate_s + off;
    const void *wd_s = (const uint8_t *)w->w_down_s + off;
    const void *wu_s = (const uint8_t *)w->w_up_s + off;

    float *krow = r->k_cache + ((long)l * G.n_ctx + pos) * kv_dim;
    float *vrow = r->v_cache + ((long)l * G.n_ctx + pos) * kv_dim;

    /* ── Attention ────────────────────────────────────────────────────── */
    rmsnorm(r->xb, r->x, w->norms + (2L * l) * dim, dim, h->rms_eps);

    gemv(r->q, r->xb, wq, wq_s, dim, (int)q_dim, block_quant, group, r);
    gemv(krow, r->xb, wk, wk_s, dim, kv_dim, block_quant, group, r);
    gemv(vrow, r->xb, wv, wv_s, dim, kv_dim, block_quant, group, r);

    /* RoPE, interleaved pairs, angles read from the shipped table. The weights
     * were permuted by convert.py so this is the only convention here. */
    {
      const float *tbl = w->rope + (long)pos * (head_dim / 2) * 2;
      for (int hh = 0; hh < h->n_heads; hh++) {
        float *qh = r->q + (long)hh * head_dim;
        for (int i = 0; i < head_dim / 2; i++) {
          const float c = tbl[i * 2], s = tbl[i * 2 + 1];
          const float a = qh[2 * i], b = qh[2 * i + 1];
          qh[2 * i] = a * c - b * s;
          qh[2 * i + 1] = a * s + b * c;
        }
      }
      for (int hh = 0; hh < h->n_kv_heads; hh++) {
        float *kh = krow + (long)hh * head_dim;
        for (int i = 0; i < head_dim / 2; i++) {
          const float c = tbl[i * 2], s = tbl[i * 2 + 1];
          const float a = kh[2 * i], b = kh[2 * i + 1];
          kh[2 * i] = a * c - b * s;
          kh[2 * i + 1] = a * s + b * c;
        }
      }
    }

    const float att_scale = 1.0f / __builtin_sqrtf((float)head_dim);
    for (int hh = 0; hh < h->n_heads; hh++) {
      const float *qh = r->q + (long)hh * head_dim;
      float *scores = r->att + (long)hh * G.n_ctx;
      /* GQA: kv_mul query heads share each kv head. */
      const long kv_off = (long)(hh / kv_mul) * head_dim;

      for (int t = 0; t <= pos; t++) {
        const float *kt = r->k_cache + ((long)l * G.n_ctx + t) * kv_dim + kv_off;
        float score = 0.0f;
        for (int i = 0; i < head_dim; i++) score += qh[i] * kt[i];
        scores[t] = score * att_scale;
      }
      softmax(scores, pos + 1);

      float *dst = r->xb2 + (long)hh * head_dim;
      for (int i = 0; i < head_dim; i++) dst[i] = 0.0f;
      for (int t = 0; t <= pos; t++) {
        const float *vt = r->v_cache + ((long)l * G.n_ctx + t) * kv_dim + kv_off;
        const float a = scores[t];
        for (int i = 0; i < head_dim; i++) dst[i] += a * vt[i];
      }
    }

    gemv(r->xb, r->xb2, wo, wo_s, (int)q_dim, dim, block_quant, group, r);
    TRACE("layer0_attn_out", r->xb, dim);
    for (int i = 0; i < dim; i++) r->x[i] += r->xb[i];

    /* ── SwiGLU MLP ───────────────────────────────────────────────────── */
    rmsnorm(r->xb, r->x, w->norms + (2L * l + 1) * dim, dim, h->rms_eps);
    gemv(r->hb, r->xb, wg, wg_s, dim, hidden, block_quant, group, r);
    gemv(r->hb2, r->xb, wu, wu_s, dim, hidden, block_quant, group, r);
    for (int i = 0; i < hidden; i++) {
      const float v = r->hb[i];
      /* SiLU: x * sigmoid(x), written so expf is the only call. */
      r->hb[i] = v / (1.0f + ml_expf(-v)) * r->hb2[i];
    }
    gemv(r->xb, r->hb, wd, wd_s, hidden, dim, block_quant, group, r);
    TRACE("layer0_mlp_out", r->xb, dim);
    for (int i = 0; i < dim; i++) r->x[i] += r->xb[i];

    TRACE("layer_out", r->x, dim);
  }

  rmsnorm(r->x, r->x, w->norms + (2L * h->n_layers) * dim, dim, h->rms_eps);
  TRACE("final_norm", r->x, dim);

  /* lm_head. Tied, so this is the embedding matrix again -- and its groups run
   * along `dim` for both uses, which is why one row-major layout serves both. */
  gemv(r->logits, r->x, w->embed, w->embed_scales, dim, h->vocab_size,
       embed_quant, group, r);
}

/* ── Sampling ───────────────────────────────────────────────────────────── */

static uint32_t rng_next(Runtime *r) {
  /* xorshift64*, as in llama2.c. Deterministic given a seed, which the golden
   * test depends on. */
  r->rng ^= r->rng >> 12;
  r->rng ^= r->rng << 25;
  r->rng ^= r->rng >> 27;
  return (uint32_t)((r->rng * 0x2545F4914F6CDD1DULL) >> 32);
}

void ml_seed(uint32_t lo, uint32_t hi) {
  G.r.rng = ((uint64_t)hi << 32) | lo;
  if (G.r.rng == 0) G.r.rng = 0x853c49e6748fea9bULL;
}

void ml_history_clear(void) {
  G.r.history_len = 0;
  G.r.history_pos = 0;
}

static void history_push(Runtime *r, int32_t token) {
  r->history[r->history_pos] = token;
  r->history_pos = (r->history_pos + 1) % 64;
  if (r->history_len < 64) r->history_len++;
}

int32_t ml_sample(float temp, float top_p, int32_t top_k, float rep_penalty,
                  int32_t rep_window) {
  if (!G.ready) return -1;
  Runtime *r = &G.r;
  const int n = G.h.vocab_size;
  float *logits = r->logits;

  /* Repetition penalty over a sliding window. Divide positive logits and
   * multiply negative ones, which is the standard formulation -- naively
   * subtracting would flip the sign of already-negative logits. */
  if (rep_penalty > 1.0f && rep_window > 0) {
    const int span = r->history_len < rep_window ? r->history_len : rep_window;
    for (int i = 1; i <= span; i++) {
      const int idx = (r->history_pos - i + 64) % 64;
      const int32_t tok = r->history[idx];
      if (tok < 0 || tok >= n) continue;
      logits[tok] = logits[tok] > 0.0f ? logits[tok] / rep_penalty
                                       : logits[tok] * rep_penalty;
    }
  }

  int32_t chosen;
  if (temp <= 0.0f) {
    int best = 0;
    for (int i = 1; i < n; i++) {
      if (logits[i] > logits[best]) best = i;
    }
    chosen = best;
  } else {
    for (int i = 0; i < n; i++) logits[i] /= temp;
    softmax(logits, n);

    /* Top-k by repeated selection. k is small (40 by default) so this beats
     * sorting 49152 entries, and it needs no scratch buffer. */
    const int k = (top_k > 0 && top_k < n) ? top_k : n;
    float cutoff = 0.0f;
    if (k < n) {
      /* Find the k-th largest probability via a partial selection over a small
       * running set of the best values seen so far. */
      float best[64];
      int m = 0;
      const int kk = k > 64 ? 64 : k;
      for (int i = 0; i < n; i++) {
        const float p = logits[i];
        if (m < kk) {
          int j = m++;
          while (j > 0 && best[j - 1] < p) {
            best[j] = best[j - 1];
            j--;
          }
          best[j] = p;
        } else if (p > best[kk - 1]) {
          int j = kk - 1;
          while (j > 0 && best[j - 1] < p) {
            best[j] = best[j - 1];
            j--;
          }
          best[j] = p;
        }
      }
      cutoff = best[m - 1];
    }

    /* Nucleus: accumulate until top_p of the mass is covered, then sample from
     * what is left. */
    float mass = 0.0f;
    for (int i = 0; i < n; i++) {
      if (logits[i] >= cutoff) mass += logits[i];
    }
    const float limit = (top_p > 0.0f && top_p < 1.0f) ? top_p * mass : mass;
    const float target = (float)rng_next(r) / 4294967296.0f * limit;

    float acc = 0.0f;
    chosen = 0;
    for (int i = 0; i < n; i++) {
      if (logits[i] < cutoff) continue;
      acc += logits[i];
      if (acc >= target) {
        chosen = i;
        break;
      }
      chosen = i;
    }
  }

  history_push(r, chosen);
  return chosen;
}

/* ── KV snapshot ────────────────────────────────────────────────────────── */

uint32_t ml_kv_bytes(int32_t n_pos) {
  return (uint32_t)((long)G.h.n_layers * n_pos * G.kv_dim * 4 * 2);
}

void ml_kv_save(uint8_t *dst, int32_t n_pos) {
  if (!G.ready) return;
  /* Compacted to exactly n_pos positions rather than copying a slice of the live
   * [n_ctx] array, so a snapshot taken at n_ctx=1024 loads into a session running
   * at 512. Discovering that limitation on a phone is the alternative. */
  const long row = (long)G.kv_dim * 4;
  uint8_t *p = dst;
  for (int l = 0; l < G.h.n_layers; l++) {
    ml_memcpy(p, G.r.k_cache + (long)l * G.n_ctx * G.kv_dim, (size_t)(n_pos * row));
    p += n_pos * row;
  }
  for (int l = 0; l < G.h.n_layers; l++) {
    ml_memcpy(p, G.r.v_cache + (long)l * G.n_ctx * G.kv_dim, (size_t)(n_pos * row));
    p += n_pos * row;
  }
}

void ml_kv_load(const uint8_t *src, int32_t n_pos) {
  if (!G.ready) return;
  const long row = (long)G.kv_dim * 4;
  const uint8_t *p = src;
  for (int l = 0; l < G.h.n_layers; l++) {
    ml_memcpy(G.r.k_cache + (long)l * G.n_ctx * G.kv_dim, p, (size_t)(n_pos * row));
    p += n_pos * row;
  }
  for (int l = 0; l < G.h.n_layers; l++) {
    ml_memcpy(G.r.v_cache + (long)l * G.n_ctx * G.kv_dim, p, (size_t)(n_pos * row));
    p += n_pos * row;
  }
}
