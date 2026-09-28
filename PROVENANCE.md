# Provenance

Every line of sanoMIT is either written here or forked from somewhere with a
name attached. This file is the map; `tools/provenance.json` is the machine
version and `node tools/check-provenance.js` (also `make provenance`) verifies
it — including a grep that fails the build if a GPL component ever shows up in
code rather than in prose.

## Forked from sanoTTS — MIT

The inference runtime, taken from the files sanoTTS's own `LICENSE.MIT` lists as
permissively licensed. It is **byte-identical** to upstream: the point of forking
the MIT parts is that they stay recognisable, and the hashes below are how you
check that nobody quietly edited them.

| File | Upstream (in `vendor/sanoTTS`) | Licence | sha256 (16) |
|---|---|---|---|
| `runtime/src/snt_nano.c` | `mcu/src/snt_nano.c` | MIT | `46357762ea163af7` |
| `runtime/src/snt_kernels_ref.c` | `mcu/src/snt_kernels_ref.c` | MIT | `2c310b765e245c67` |
| `runtime/include/snt_nano.h` | `mcu/include/snt_nano.h` | MIT | `59749fba949e52e9` |
| `runtime/include/snt_port.h` | `mcu/include/snt_port.h` | MIT | `ea50294bb811b0cb` |
| `runtime/ports/host/snt_port_host.c` | `mcu/ports/host/snt_port_host.c` | MIT | `2b29d8539d5e0ee3` |
| `runtime/models/en_us_e13b/nano_q8_meta.h` | `mcu/models/en_us_e13b/nano_q8_meta.h` | MIT | `ccdaa20f1268ee8e` |

Copyright (c) 2026 Ampixa. The full text of the MIT licence and the reasoning
behind the split are in `NOTICE`.

**What is *not* in that list matters as much as what is.** sanoTTS also ships a
second stack — `snt_front_q8.c`, `snt_piperlite*.c`, `snt_trellis.c` and their
headers — and those are not in the MIT file list, so they are GPL-3.0 and they
are not here. The nano line never needed them.

## Deliberately not taken

Everything in sanoTTS that touches espeak-ng (and therefore drags GPL-3.0 with
it), plus the training and packaging machinery this fork does not use:

| Upstream | Why it stays behind |
|---|---|
| `mcu/ports/wasm/espeak/**`, `mcu/ports/esp32s3/firmware/{espeak-ng-data,components/espeak-ng}` | espeak-ng itself. This is the thing the fork exists to avoid |
| `mcu/ports/wasm/snt_g2p_wasm.c`, `cp_id_table.h`, `cp_id_tables_multi.h` | the espeak G2P shim and its codepoint→id tables: GPL-3.0 |
| `mcu/ports/wasm/snt_nano_wasm.c`, `snt_port_wasm.c` | not in the MIT file list. sanoMIT's wasm face is `runtime/ports/wasm/smit_wasm.c` and its port is `smit_port_wasm.c`, both Apache-2.0 |
| `mcu/src/snt_front_*.c`, `snt_piperlite*.c`, `snt_trellis.c` | not in the MIT file list, so GPL-3.0; the nano line does not need them |
| `mcu/test/**` | test fixtures, including id sequences produced by espeak: GPL-3.0. sanoMIT's baseline was recorded from its own runtime instead — see "What the tests actually certify" |
| `web/**`, `pypkg/**`, `npmpkg/**` | the GPL front ends and packaging |
| `tools/**` | training and export tooling: GPL-3.0 |

## Written here — Apache-2.0

Everything else: `g2p/js/smit-g2p.js` (the front end: the ARPAbet→voice mapping,
the stress and syllabic rules, the number/currency/time readings, the neural
model's loader), `engine/js/sanomit.js`, `runtime/ports/wasm/*`,
`runtime/ports/host/smit_host.c`, the tests and the tools.

## Data, and where it comes from

`tools/get-data.sh` fetches these; none of them are committed.

| File | What it is | Licence |
|---|---|---|
| `g2p/data/cmudict.json` | CMU Pronouncing Dictionary, 123,463 entries, as shipped in tiny-tts's npm package | Apache-2.0 |
| `g2p/data/g2p_model.json` | the trained g2p_en GRU encoder-decoder weights | Apache-2.0 |
| `voices/heartnano/*.bin` | the voice weights the tests and the demo run on | ⚠ **not** Apache/MIT — see `voices/README.md` |

The neural G2P code path in `smit-g2p.js` is a restructuring of the g2p_en
predictor as shipped by tiny-tts (Apache-2.0): same GRU cell, same greedy decode,
same `</s>` handling. The vocabulary mapping on top of it is this project's.

`sanoTTS-jp` (the MIT-licensed Japanese implementation of the same recipe) was
read while designing the front end, the gate structure and this file. No code was
taken from it, and its weights are Japanese-only and were never a candidate.

## What the tests actually certify

Being honest about the difference between "unchanged" and "correct":

* `test/baseline.json` is a **regression baseline recorded from this engine**. It
  says today's render matches yesterday's. It is not a reference from the
  training stack, and it cannot catch a mistake that was there from the start.
* `test/g2p-test.js` checks the front end against **this project's own** written
  expectations.
* The one external check is `tools/g2p-diff.js`: it runs the GPL front end from
  `vendor/sanoTTS` and reports how far this front end's phoneme sequences are
  from it (currently ~93% reading similarity, differences being vowel-quality and
  stress-placement nuances rather than structural failures). That tool is a
  development instrument. Its output is a number on a terminal; no GPL code, and
  no data derived from GPL output, is stored in this repository.

The upstream runtime is separately gated at 0.98 Pearson correlation against a
PyTorch reference (`mcu/test/nano_golden_main.c` upstream). sanoMIT does not
re-run that gate: the fixture it needs is GPL data. If a voice with a permissive
licence ever ships with a PyTorch reference, that gate is worth re-establishing.
