/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * smit_port_wasm.c -- the porting surface for a browser or node.
 *
 * One thread, one scratch, a millisecond clock. The core asks for three things
 * (snt_port.h); everything else it does itself.
 */
#include <stdint.h>

#include "snt_port.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

/* The core splits its trunk convolutions over cores through this. Single
 * threaded here, and correctly so: it returns only when the range is done. */
void snt_par_run(snt_par_fn f, int n, void *ctx) { f(0, n, ctx); }

/* Which scratch buffer this call is running on. One thread, so always zero. */
int snt_scratch_id(void) { return 0; }

/* Profiling clock in microseconds. */
int64_t snt_now_us(void) {
#ifdef __EMSCRIPTEN__
    return (int64_t) (emscripten_get_now() * 1000.0);
#else
    return 0;
#endif
}
