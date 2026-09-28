/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * smit_wasm.c -- the browser/WASM face of the sanoMIT runtime.
 *
 * The MIT core (snt_nano.c) never allocates and knows nothing about the host:
 * it is handed two weight blobs and an arena and calls back with PCM. This file
 * is the adapter that makes that usable from JavaScript:
 *
 *   smit_voice_load(front_ptr, dec_ptr)                  -> 0, or -1
 *   smit_required_samples(n_ids)                        -> upper bound
 *   smit_render(ids_ptr, n_ids, seed_words, out_ptr, out_cap) -> samples, or negative
 *   smit_seed_for(text)                                 -> deterministic seed
 *   smit_sample_rate() / smit_vocab() / smit_arena_bytes()
 *
 * One-shot by design: a fresh bump arena per render, no streaming, and the PCM
 * lands in a buffer the caller allocated, so the JS side owns every byte and
 * can hand them straight to an AudioBuffer. The arena is module static, which
 * keeps the malloc heap out of the picture entirely; the core reports ERR_OOM
 * (-2) rather than overflowing it.
 */
#include <stdint.h>
#include <string.h>

#include "snt_nano.h"
/* The lineage header is the model: dims, caps and the hop. The build picks a
 * lineage with -I runtime/models/<lineage>, exactly as the MCU builds do. */
#include "nano_q8_meta.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define SMIT_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define SMIT_EXPORT
#endif

/* 256 KB covers the 138 KB peak measured for a 41-id utterance with room to
 * spare; a longer sentence fails with -2 instead of walking over memory. */
#define SMIT_ARENA_BYTES (256u * 1024u)

static unsigned char g_arena[SMIT_ARENA_BYTES] __attribute__((aligned(16)));
static const void *g_front;
static const void *g_dec;

typedef struct {
    float *out;
    long cap;
    long used;
    int overflow;
} Sink;

static int append(const float *pcm, int n, void *user) {
    Sink *s = (Sink *) user;
    if (s->used + n > s->cap) {
        s->overflow = 1;
        return 1;                   /* non-zero aborts the render, as documented */
    }
    memcpy(s->out + s->used, pcm, (size_t) n * sizeof(float));
    s->used += n;
    return 0;
}

/* Hand the weights over once. The blobs are read-only and have to stay put for
 * the life of the module — copy them into the wasm heap and never move it. */
SMIT_EXPORT
int smit_voice_load(const void *front_blob, const void *dec_blob) {
    if (!front_blob || !dec_blob) return -1;
    g_front = front_blob;
    g_dec = dec_blob;
    return 0;
}

SMIT_EXPORT
int smit_sample_rate(void) {
    return 24000;                   /* the nano lineage renders at 24 kHz */
}

SMIT_EXPORT
int smit_vocab(void) {
    return NANO_VOCAB;
}

SMIT_EXPORT
int smit_max_tokens(void) {
    return NANO_DUR_MAX_TOKENS;
}

SMIT_EXPORT
long smit_arena_bytes(void) {
    return SMIT_ARENA_BYTES;
}

/* Upper bound on samples for n phoneme ids: the duration student caps a token
 * at NANO_DUR_MAX_DURATION frames and each frame is NANO_HOP samples. Callers
 * size their output with this and never have to guess. */
SMIT_EXPORT
long smit_required_samples(int n_ids) {
    long frames = (long) n_ids * NANO_DUR_MAX_DURATION;
    if (frames < 8) frames = 8;
    return (frames + 8) * (long) NANO_HOP;
}

/* Render one utterance. `seed` is the deterministic noise seed the decoder was
 * trained to be given, handed over as two 32-bit words — a uint64_t in memory,
 * which sidesteps shoving a 64-bit number through a JavaScript call. Fill it
 * with snt_nano_sha256_seed(text, seed) and a line of dialogue sounds the same
 * every time it is spoken.
 *
 * Returns samples written, or negative: -1 bad arguments, -2 the output buffer
 * or the arena ran out, anything else is the core's own code. */
SMIT_EXPORT
int smit_render(const int32_t *ids, int n_ids, const uint32_t seed[2],
                float *out, long out_cap) {
    if (!ids || n_ids <= 0 || !out || out_cap <= 0 || !seed) return -1;
    if (!g_front || !g_dec) return -1;

    Sink sink;
    sink.out = out;
    sink.cap = out_cap;
    sink.used = 0;
    sink.overflow = 0;

    snt_nano_config cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.front_blob = g_front;
    cfg.dec_blob = g_dec;
    cfg.arena = g_arena;
    cfg.arena_size = SMIT_ARENA_BYTES;
    cfg.dur_override = NULL;
    memcpy(&cfg.noise_seed, seed, sizeof cfg.noise_seed);

    snt_nano_stats stats;
    memset(&stats, 0, sizeof stats);
    int rc = snt_nano_synthesize(&cfg, ids, n_ids, append, &sink, &stats);
    if (rc != 0) return rc;
    if (sink.overflow) return -2;
    return (int) sink.used;
}
