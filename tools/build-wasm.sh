#!/bin/sh
# Build the sanoMIT engine to WebAssembly. Needs emsdk (tested on 4.0.19):
#   source ~/emsdk/emsdk_env.sh
# Everything the module needs is in the two output files: sanomit.js (a factory)
# and sanomit.wasm. No model and no data are baked in; the caller hands the
# weight blobs over at runtime.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/dist"
mkdir -p "$OUT"

: "${EMCC:=emcc}"
if ! command -v "$EMCC" >/dev/null 2>&1; then
  echo "emcc not on PATH. Source your emsdk first:" >&2
  echo "  source \$HOME/emsdk/emsdk_env.sh" >&2
  exit 1
fi

# -O2 rather than -O3: the core's fixed-point sincos and fast-exp paths are
# gated on bit-identical integer semantics, and the reference build is -O2 too.
$EMCC \
  -O2 -std=c11 -Wall -Wextra \
  -I "$ROOT/runtime/include" -I "$ROOT/runtime/models/en_us_e13b" \
  "$ROOT/runtime/src/snt_nano.c" \
  "$ROOT/runtime/src/snt_kernels_ref.c" \
  "$ROOT/runtime/ports/wasm/smit_wasm.c" \
  "$ROOT/runtime/ports/wasm/smit_port_wasm.c" \
  -o "$OUT/sanomit.js" \
  -sENVIRONMENT=web,worker,node \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=SanoMitRuntime \
  -sEXPORT_ES6=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=16777216 \
  -sSTACK_SIZE=1048576 \
  -sEXPORTED_RUNTIME_METHODS=cwrap,UTF8ToString,lengthBytesUTF8,stringToUTF8,HEAPF32,HEAPU8,HEAPU32,HEAP32 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_snt_nano_sha256_seed \
  2>&1 | grep -v "^$" || true

ls -la "$OUT"/sanomit.*
