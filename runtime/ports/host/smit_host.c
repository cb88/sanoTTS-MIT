/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * smit_host.c -- command line driver for the sanoMIT runtime.
 *
 *   smit_host <voice_dir> <out.wav> <ids.txt> [--seed-from <text>]
 *
 * <voice_dir> holds the two weight blobs named in the voice meta.json
 * (front_q8.bin + model_q8.bin). <ids.txt> is phoneme ids in the voice's
 * vocabulary, separated by whitespace or commas; the ids themselves come from
 * the sanoMIT G2P, never from this binary.
 *
 * Exits 0 on success. Prints one line of JSON so a test can assert on it.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "snt_nano.h"

#define ARENA_BYTES (16u * 1024u * 1024u)
#define MAX_IDS 4096
#define SAMPLE_RATE 24000

typedef struct {
    float *pcm;
    int cap, n;
    int overflow;
} Sink;

static int sink_cb(const float *pcm, int n, void *user) {
    Sink *s = (Sink *) user;
    if (s->n + n > s->cap) { s->overflow = 1; return 1; }
    memcpy(s->pcm + s->n, pcm, (size_t) n * sizeof(float));
    s->n += n;
    return 0;
}

static void *read_file(const char *path, size_t *bytes) {
    FILE *fh = fopen(path, "rb");
    if (!fh) { fprintf(stderr, "cannot open %s\n", path); return NULL; }
    fseek(fh, 0, SEEK_END);
    long sz = ftell(fh);
    fseek(fh, 0, SEEK_SET);
    /* one byte over: read_ids terminates the buffer in place */
    void *buf = malloc((size_t) sz + 1);
    if (!buf || fread(buf, 1, (size_t) sz, fh) != (size_t) sz) {
        fprintf(stderr, "cannot read %s\n", path);
        free(buf);
        fclose(fh);
        return NULL;
    }
    fclose(fh);
    if (bytes) *bytes = (size_t) sz;
    return buf;
}

static int read_ids(const char *path, int32_t *ids, int cap) {
    size_t n = 0;
    char *text = (char *) read_file(path, &n);
    if (!text) return -1;
    text[n < 4096 ? (int) n : 4095] = '\0';
    int count = 0;
    char *p = text;
    while (*p) {
        while (*p && (*p < '0' || *p > '9') && *p != '-') p++;
        if (!*p) break;
        char *end;
        long v = strtol(p, &end, 10);
        if (end == p) break;
        if (count == cap) { fprintf(stderr, "more than %d ids\n", cap); free(text); return -1; }
        ids[count++] = (int32_t) v;
        p = end;
    }
    free(text);
    return count;
}

/* FNV-1a over the float32 bit pattern: enough to say "this render is the same
 * render it gated yesterday" without keeping a WAV in the repository. */
static unsigned long long fnv1a_pcm(const float *pcm, int n) {
    unsigned long long h = 1469598103934665603ULL;
    const unsigned char *b = (const unsigned char *) pcm;
    for (size_t i = 0; i < (size_t) n * sizeof(float); i++) {
        h ^= b[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static int write_wav(const char *path, const float *pcm, int n) {
    FILE *fh = fopen(path, "wb");
    if (!fh) { fprintf(stderr, "cannot write %s\n", path); return -1; }
    int data_bytes = n * 2;
    unsigned int riff = 36u + (unsigned) data_bytes;
    int fmt_len = 16, sr = SAMPLE_RATE, byte_rate = SAMPLE_RATE * 2;
    short audio_format = 1, channels = 1, block = 2, bits = 16;
    fwrite("RIFF", 1, 4, fh);
    fwrite(&riff, 4, 1, fh);
    fwrite("WAVEfmt ", 1, 8, fh);
    fwrite(&fmt_len, 4, 1, fh);
    fwrite(&audio_format, 2, 1, fh);
    fwrite(&channels, 2, 1, fh);
    fwrite(&sr, 4, 1, fh);
    fwrite(&byte_rate, 4, 1, fh);
    fwrite(&block, 2, 1, fh);
    fwrite(&bits, 2, 1, fh);
    fwrite("data", 1, 4, fh);
    fwrite(&data_bytes, 4, 1, fh);
    for (int i = 0; i < n; i++) {
        float v = pcm[i] > 1.0f ? 1.0f : (pcm[i] < -1.0f ? -1.0f : pcm[i]);
        short s = (short) lrintf(v * 32767.0f);
        fwrite(&s, 2, 1, fh);
    }
    fclose(fh);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr,
                "usage: %s <voice_dir> <out.wav> <ids.txt> [--seed-from <text>]\n", argv[0]);
        return 2;
    }
    const char *voice = argv[1], *out = argv[2], *ids_path = argv[3];
    const char *seed_text = NULL;
    for (int i = 4; i + 1 < argc; i++)
        if (!strcmp(argv[i], "--seed-from")) seed_text = argv[++i];

    char path[512];
    size_t front_bytes = 0, dec_bytes = 0;
    snprintf(path, sizeof path, "%s/front_q8.bin", voice);
    void *front = read_file(path, &front_bytes);
    if (!front) return 1;
    snprintf(path, sizeof path, "%s/model_q8.bin", voice);
    void *dec = read_file(path, &dec_bytes);
    if (!dec) { free(front); return 1; }

    int32_t ids[MAX_IDS];
    int n_ids = read_ids(ids_path, ids, MAX_IDS);
    if (n_ids <= 0) { fprintf(stderr, "no ids in %s\n", ids_path); return 1; }

    void *arena = malloc(ARENA_BYTES);
    float *pcm = (float *) malloc((size_t) SAMPLE_RATE * 120 * sizeof(float));
    if (!arena || !pcm) { fprintf(stderr, "out of host memory\n"); return 1; }
    Sink sink = { pcm, SAMPLE_RATE * 120, 0, 0 };

    snt_nano_config cfg;
    memset(&cfg, 0, sizeof cfg);
    cfg.front_blob = front;
    cfg.dec_blob = dec;
    cfg.arena = arena;
    cfg.arena_size = ARENA_BYTES;
    cfg.noise_seed = 0;
    if (seed_text) {
        if (snt_nano_sha256_seed(seed_text, &cfg.noise_seed) != 0) {
            fprintf(stderr, "seed derivation failed\n");
            return 1;
        }
    }

    snt_nano_stats stats;
    memset(&stats, 0, sizeof stats);
    int rc = snt_nano_synthesize(&cfg, ids, n_ids, sink_cb, &sink, &stats);
    if (rc != 0) {
        fprintf(stderr, "snt_nano_synthesize failed: %d (frames=%d)\n", rc, stats.frames);
        return 1;
    }
    if (sink.overflow) { fprintf(stderr, "output buffer overflowed\n"); return 1; }
    if (write_wav(out, pcm, sink.n) != 0) return 1;

    double seconds = (double) sink.n / SAMPLE_RATE;
    double xrt = stats.elapsed_us > 0 ? (double) stats.elapsed_us / 1e6 / seconds : 0.0;
    printf("{\"frames\": %d, \"samples\": %d, \"seconds\": %.3f, \"ms\": %.1f, "
           "\"xrt\": %.4f, \"arena_peak\": %zu, \"hash\": \"0x%016llx\", \"file\": \"%s\"}\n",
           stats.frames, sink.n, seconds, (double) stats.elapsed_us / 1000.0, xrt,
           stats.arena_peak, fnv1a_pcm(pcm, sink.n), out);
    free(front);
    free(dec);
    free(arena);
    free(pcm);
    return 0;
}
