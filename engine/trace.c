/* trace.c -- see trace.h. Native builds only. */
#include "trace.h"

#include <float.h>
#include <stdio.h>
#include <string.h>

/* One slot per (name, layer) pair. A 30-layer model traces four per-layer
 * tensors plus two singletons, so 92 slots -- the first version of this file had
 * 64 and its overflow path returned &g_slots[0], silently folding every
 * overflowing tensor into the `embed` accumulator and reporting the embeddings as
 * 5.6e7 times too large. The engine was correct the whole time; the instrument
 * was lying. Hence both the headroom and the loud failure below: a fallback that
 * silently corrupts a measurement is worse than no measurement. */
#define MAX_SLOTS 256
/* Distinct tensor names, which is a much smaller number than slots. */
#define MAX_NAMES 32

typedef struct {
  char name[32];
  int layer;
  double sum, abs_sum, sum_sq, min, max;
  long count;
} Slot;

static Slot g_slots[MAX_SLOTS];
static int g_n_slots;
static int g_overflowed;
/* How many times each name has been seen in the current forward pass, which is
 * how a repeated per-layer TRACE call is turned into distinct layer indices. */
static char g_seen[MAX_NAMES][32];
static int g_seen_count[MAX_NAMES];
static int g_n_seen;

void ml_trace_begin_step(void) {
  g_n_seen = 0;
  for (int i = 0; i < MAX_NAMES; i++) g_seen_count[i] = 0;
}

static int seen_index(const char *name) {
  for (int i = 0; i < g_n_seen; i++) {
    if (strcmp(g_seen[i], name) == 0) return i;
  }
  if (g_n_seen >= MAX_NAMES) {
    if (!g_overflowed) {
      fprintf(stderr, "trace: more than %d distinct names; raise MAX_NAMES\n",
              MAX_NAMES);
      g_overflowed = 1;
    }
    return -1;
  }
  snprintf(g_seen[g_n_seen], sizeof g_seen[0], "%s", name);
  g_seen_count[g_n_seen] = 0;
  return g_n_seen++;
}

static Slot *slot_for(const char *name, int layer) {
  for (int i = 0; i < g_n_slots; i++) {
    if (g_slots[i].layer == layer && strcmp(g_slots[i].name, name) == 0) {
      return &g_slots[i];
    }
  }
  if (g_n_slots >= MAX_SLOTS) {
    if (!g_overflowed) {
      fprintf(stderr, "trace: out of slots at %s/%d; raise MAX_SLOTS\n", name,
              layer);
      g_overflowed = 1;
    }
    return NULL; /* Drop the sample rather than corrupt another accumulator. */
  }
  Slot *s = &g_slots[g_n_slots++];
  snprintf(s->name, sizeof s->name, "%s", name);
  s->layer = layer;
  s->sum = s->abs_sum = s->sum_sq = 0.0;
  s->min = DBL_MAX;
  s->max = -DBL_MAX;
  s->count = 0;
  return s;
}

void ml_trace_accumulate(const char *name, const float *data, int n) {
  const int si = seen_index(name);
  if (si < 0) return;
  const int layer = g_seen_count[si]++;
  Slot *s = slot_for(name, layer);
  if (s == NULL) return;
  for (int i = 0; i < n; i++) {
    const double v = (double)data[i];
    s->sum += v;
    s->abs_sum += v < 0.0 ? -v : v;
    s->sum_sq += v * v;
    if (v < s->min) s->min = v;
    if (v > s->max) s->max = v;
  }
  s->count += n;
}

void ml_trace_dump(void) {
  printf("  \"trace\": [\n");
  for (int i = 0; i < g_n_slots; i++) {
    const Slot *s = &g_slots[i];
    printf("    {\"name\": \"%s\", \"layer\": %d, \"sum\": %.10g, "
           "\"abs_sum\": %.10g, \"sum_sq\": %.10g, \"min\": %.10g, "
           "\"max\": %.10g, \"count\": %ld}%s\n",
           s->name, s->layer, s->sum, s->abs_sum, s->sum_sq, s->min, s->max,
           s->count, i + 1 < g_n_slots ? "," : "");
  }
  printf("  ]\n");
}
