#!/bin/sh
# Pull the data this engine needs but does not carry.
#
#   tools/get-data.sh            everything
#   tools/get-data.sh cmudict    just the dictionary
#   tools/get-data.sh voice      just the voice blobs
#
# What it fetches, and why it is not in the repository:
#
#   cmudict.json     the CMU Pronouncing Dictionary, Apache-2.0 (via tiny-tts).
#                    5 MB of data; the code that reads it is here, the data is
#                    somebody else's file and git need not hold it twice.
#   g2p_model.json   the g2p_en neural grapheme-to-phoneme weights, Apache-2.0.
#   voice blobs      the heartnano weights. ⚠ These are the upstream voice DATA
#                    and carry the upstream voice licence (GPL-3.0 on the
#                    ampixa/sanoTTS model card): they are fetched, never
#                    committed, and everything in this folder stays Apache/MIT.
#
# It reads from the vendor checkouts next door when they exist, and falls back
# to the network otherwise.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR=$(cd "$ROOT/.." && pwd)/vendor
G2PDATA="$ROOT/g2p/data"
VOICE="$ROOT/voices/heartnano"
mkdir -p "$G2PDATA" "$VOICE"

want=${1:-all}

fetch_cmudict() {
  dest="$G2PDATA/cmudict.json"
  src="$VENDOR/tiny-tts/npm-package/cmudict.json"
  if [ -f "$src" ]; then cp "$src" "$dest"; echo "cmudict.json  ← $src"
  elif [ ! -f "$dest" ]; then
    echo "cmudict.json ← npm registry (tiny-tts)"
    tmp=$(mktemp -d)
    (cd "$tmp" && npm pack tiny-tts >/dev/null 2>&1 && tar xzf tiny-tts-*.tgz)
    cp "$tmp/package/cmudict.json" "$dest"
    rm -rf "$tmp"
  else echo "cmudict.json  already there"; fi
}

fetch_g2p() {
  dest="$G2PDATA/g2p_model.json"
  src="$VENDOR/tiny-tts/npm-package/g2p_model.json"
  if [ -f "$src" ]; then cp "$src" "$dest"; echo "g2p_model.json ← $src"
  elif [ ! -f "$dest" ]; then
    echo "g2p_model.json ← npm registry (tiny-tts)"
    tmp=$(mktemp -d)
    (cd "$tmp" && npm pack tiny-tts >/dev/null 2>&1 && tar xzf tiny-tts-*.tgz)
    cp "$tmp/package/g2p_model.json" "$dest"
    rm -rf "$tmp"
  else echo "g2p_model.json  already there"; fi
}

fetch_voice() {
  src="$VENDOR/sanoTTS/web/voices/heartnano"
  for f in front_q8.bin model_q8.bin meta.json; do
    if [ -f "$src/$f" ]; then cp "$src/$f" "$VOICE/$f"; echo "$f ← $src"; fi
  done
  if [ ! -f "$VOICE/front_q8.bin" ]; then
    echo "no voice blobs next door. The upstream release is" >&2
    echo "  https://huggingface.co/ampixa/sanoTTS (voices-v2 / heartnano-e13b)" >&2
    echo "Put front_q8.bin and model_q8.bin in $VOICE" >&2
  fi
}

case "$want" in
  cmudict) fetch_cmudict ;;
  g2p)     fetch_g2p ;;
  voice)   fetch_voice ;;
  all)     fetch_cmudict; fetch_g2p; fetch_voice ;;
  *) echo "unknown part: $want (want: all|cmudict|g2p|voice)" >&2; exit 2 ;;
esac
