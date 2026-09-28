# Voice weights

This directory is **not part of the Apache/MIT codebase** and is deliberately
empty in git.

sanoMIT runs the `snt_nano` voice format: a directory holding

    front_q8.bin   duration student + acoustic student   (~107 KB)
    model_q8.bin   the iSTFT decoder                      (~230 KB)
    meta.json      what the blobs are: lineage, sample rate, vocab, checksums

`tools/get-data.sh voice` fills this in from the vendor checkout next door, or
from the upstream release at <https://huggingface.co/ampixa/sanoTTS>
(`voices-v2` → `heartnano-e13b`).

## The licence of what lands here

The **code** in this repository is Apache-2.0, and the runtime it runs is MIT.
The **weights** are a different asset with different terms: the upstream model
card is tagged `license: gpl-3.0`, which is the whole reason this fork exists —
an Apache/MIT engine is only useful if you can point it at a voice you are
allowed to ship.

So:

* fetching a voice here for development is fine;
* `git status` will never show a `.bin`, because of the `.gitignore` in this
  directory;
* **redistributing a voice fetched here means redistributing it under its own
  terms**, not under Apache-2.0. Read the upstream model card before you do.

## Swapping in a voice this repository owns

The plan is to train our own voices, at which point a directory here gets a
`meta.json` naming its licence and this README becomes a table of voices and
their terms. The engine does not care where the weights come from: it is handed two blobs and
an alphabet. A voice with a different symbol table overrides the one baked into
the front end — `createSanoMIT({ vocabulary })` takes the `frontend.vocabulary`
object from the voice's own `meta.json`, and `runtime/models/<lineage>` picks the
lineage whose dims, caps and hop the blobs were exported against.
