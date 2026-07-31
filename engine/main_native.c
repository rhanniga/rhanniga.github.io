/* main_native.c -- the native CLI. Never compiled for wasm.
 *
 * Keeping argv parsing, stdio and file IO in a file the wasm build never sees is
 * what lets engine.c stay freestanding while still being debuggable with gdb,
 * ASan and valgrind.
 *
 * Input is a list of token ids, not text. The engine has no tokenizer by design --
 * byte-level BPE lives in JavaScript -- so the golden test exercises the forward
 * pass with nothing else in the loop.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "engine.h"
#include "platform.h"
#ifdef ML_TRACE
#include "trace.h"
#endif

static void usage(void) {
  fprintf(stderr,
          "usage: engine --model FILE [options]\n"
          "  --tokens FILE     newline-separated token ids to prefill\n"
          "  --steps N         generate N tokens after the prompt\n"
          "  --temp F          sampling temperature (0 = greedy, default 0)\n"
          "  --top-p F         nucleus threshold (default 0.9)\n"
          "  --top-k N         (default 40)\n"
          "  --rep-penalty F   (default 1.1)\n"
          "  --seed N\n"
          "  --ctx N           context length (default 1024)\n"
          "  --dump-logits     emit JSON: top-50 logits per prompt position\n"
          "  --bench           report tokens/second\n");
}

static uint8_t *read_file(const char *path, long *len_out) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", path);
    return NULL;
  }
  fseek(f, 0, SEEK_END);
  const long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  /* Through ml_alloc, so ml_init receives a pointer with the same alignment
   * guarantee it will have under wasm. */
  uint8_t *buf = (uint8_t *)ml_alloc((uint32_t)len);
  if (!buf) {
    fprintf(stderr, "out of memory reading %s (%ld bytes)\n", path, len);
    fclose(f);
    return NULL;
  }
  if (fread(buf, 1, (size_t)len, f) != (size_t)len) {
    fprintf(stderr, "short read on %s\n", path);
    fclose(f);
    return NULL;
  }
  fclose(f);
  *len_out = len;
  return buf;
}

static int read_tokens(const char *path, int32_t *out, int max) {
  FILE *f = fopen(path, "r");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", path);
    return -1;
  }
  int n = 0;
  long v;
  while (n < max && fscanf(f, "%ld", &v) == 1) out[n++] = (int32_t)v;
  fclose(f);
  return n;
}

/** Indices of the `k` largest logits, descending. Selection sort over a small k. */
static void top_k_indices(const float *logits, int n, int k, int *idx) {
  for (int i = 0; i < k; i++) idx[i] = -1;
  for (int i = 0; i < n; i++) {
    const float v = logits[i];
    int j = k - 1;
    if (idx[j] >= 0 && v <= logits[idx[j]]) continue;
    while (j > 0 && (idx[j - 1] < 0 || v > logits[idx[j - 1]])) {
      idx[j] = idx[j - 1];
      j--;
    }
    idx[j] = i;
  }
}

int main(int argc, char **argv) {
  const char *model_path = NULL;
  const char *tokens_path = NULL;
  int steps = 0, n_ctx = 1024, top_k = 40, dump_logits = 0, bench = 0;
  float temp = 0.0f, top_p = 0.9f, rep = 1.1f;
  unsigned long seed = 1234;

  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *next = (i + 1 < argc) ? argv[i + 1] : NULL;
#define NEEDS(x) do { if (!next) { usage(); return 2; } i++; x; } while (0)
    if (!strcmp(a, "--model")) NEEDS(model_path = next);
    else if (!strcmp(a, "--tokens")) NEEDS(tokens_path = next);
    else if (!strcmp(a, "--steps")) NEEDS(steps = atoi(next));
    else if (!strcmp(a, "--ctx")) NEEDS(n_ctx = atoi(next));
    else if (!strcmp(a, "--temp")) NEEDS(temp = (float)atof(next));
    else if (!strcmp(a, "--top-p")) NEEDS(top_p = (float)atof(next));
    else if (!strcmp(a, "--top-k")) NEEDS(top_k = atoi(next));
    else if (!strcmp(a, "--rep-penalty")) NEEDS(rep = (float)atof(next));
    else if (!strcmp(a, "--seed")) NEEDS(seed = strtoul(next, NULL, 10));
    else if (!strcmp(a, "--dump-logits")) dump_logits = 1;
    else if (!strcmp(a, "--bench")) bench = 1;
    else { usage(); return 2; }
#undef NEEDS
  }
  if (!model_path) {
    usage();
    return 2;
  }

  long model_len = 0;
  uint8_t *model = read_file(model_path, &model_len);
  if (!model) return 1;

  const int32_t rc = ml_init(model, (uint32_t)model_len, n_ctx);
  if (rc != ML_OK) {
    fprintf(stderr, "ml_init failed: %d\n", rc);
    return 1;
  }
  ml_seed((uint32_t)(seed & 0xffffffffu), (uint32_t)(seed >> 32));

  static int32_t prompt[4096];
  int n_prompt = 0;
  if (tokens_path) {
    n_prompt = read_tokens(tokens_path, prompt, 4096);
    if (n_prompt <= 0) return 1;
  } else {
    prompt[0] = ml_bos_id();
    n_prompt = 1;
  }
  if (n_prompt > n_ctx) {
    fprintf(stderr, "prompt (%d) exceeds context (%d)\n", n_prompt, n_ctx);
    return 1;
  }

  const int n_vocab = ml_n_vocab();
  static int idx[50];

  if (dump_logits) printf("{\n  \"positions\": [\n");

  const clock_t t0 = clock();
  for (int pos = 0; pos < n_prompt; pos++) {
#ifdef ML_TRACE
    ml_trace_begin_step();
#endif
    ml_forward(prompt[pos], pos);

    if (dump_logits) {
      const float *logits = ml_logits();
      top_k_indices(logits, n_vocab, 50, idx);
      printf("    {\"pos\": %d, \"token\": %d, \"argmax\": %d, \"top_ids\": [",
             pos, prompt[pos], idx[0]);
      for (int i = 0; i < 50; i++) printf("%s%d", i ? ", " : "", idx[i]);
      printf("], \"top_logits\": [");
      for (int i = 0; i < 50; i++) printf("%s%.5f", i ? ", " : "", logits[idx[i]]);
      double sum = 0.0;
      for (int i = 0; i < n_vocab; i++) sum += logits[i];
      printf("], \"logit_sum\": %.6f}%s\n", sum,
             pos + 1 < n_prompt ? "," : "");
    }
  }
  const double prefill_s = (double)(clock() - t0) / CLOCKS_PER_SEC;

  if (dump_logits) {
    printf("  ]%s\n", 0 ? "," : ",");
#ifdef ML_TRACE
    ml_trace_dump();
#else
    printf("  \"trace\": []\n");
#endif
    printf("}\n");
  }

  /* Generation. Sampled from the last prompt position's logits. */
  int generated = 0;
  const clock_t t1 = clock();
  if (steps > 0) {
    int pos = n_prompt;
    int token = ml_sample(temp, top_p, top_k, rep, 64);
    for (; generated < steps && pos < n_ctx; generated++, pos++) {
      if (!dump_logits) printf("%d\n", token);
      if (token == ml_eos_id()) break;
      ml_forward(token, pos);
      token = ml_sample(temp, top_p, top_k, rep, 64);
    }
  }
  const double decode_s = (double)(clock() - t1) / CLOCKS_PER_SEC;

  if (bench) {
    fprintf(stderr, "prefill %d tok in %.3fs = %.1f tok/s\n", n_prompt, prefill_s,
            n_prompt / (prefill_s > 0 ? prefill_s : 1e-9));
    if (generated > 0) {
      fprintf(stderr, "decode  %d tok in %.3fs = %.1f tok/s\n", generated,
              decode_s, generated / (decode_s > 0 ? decode_s : 1e-9));
    }
  }

  ml_shutdown();
  return 0;
}
