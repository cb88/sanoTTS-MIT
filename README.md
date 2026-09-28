# sanoMIT

An English text-to-speech engine with **no GPL in it**.

It is the inference runtime of [sanoTTS](https://github.com/Ampixa/sanoTTS) — the
part that is MIT — forked out of that repository, with the one component that made
the whole project GPL-3.0 (an embedded [espeak-ng](https://github.com/espeak-ng/espeak-ng)
grapheme-to-phoneme layer) replaced by an Apache-2.0 front end built out of
[tiny-tts](https://github.com/tronghieuit/tiny-tts)'s pieces: the CMU Pronouncing
Dictionary and a neural g2p_en GRU. The result is a 294k-parameter voice that
renders 24 kHz speech at **~40× realtime** in a browser tab, from a single
self-contained HTML file, with no network.

```
text ──► front end (Apache-2.0)                ┌─ CMUdict, 123,463 entries
       │   dictionary first, then a neural      └─ g2p_en GRU for unknown words
       │   GRU for words the dictionary lacks,        │
       │   then numbers, currency, times, letters     ▼
       └─► ARPAbet ──► the voice's 62-symbol alphabet ──► ids
                                                        │
   runtime (MIT, byte-identical to upstream)            ▼
     duration student ─► acoustic student ─► iSTFT decoder ─► PCM
```

## Run it

```sh
./tools/get-data.sh            # dictionary, neural weights, voice blobs
make                           # host CLI + wasm engine  (wasm needs emsdk)
make test                      # front end, then the engine
node tools/speak.js "Hull integrity: yours, not the ship's." --out /tmp/line.wav
node tools/speak.js --phonemes "Inspector Haldy of Claims 14-F"
```

The bench page lives in the rig: `node build/build-tts-demo.js` writes
`sanoMIT/demo/sanomit-demo.html` (11.6 MB, everything embedded) and the
`vendor/tiny-tts` page it sits beside, and `python3 tools/ttscheck.py` proves both
still boot off `file://` with zero network requests and produce real audio.

## What is whose

| | Licence |
|---|---|
| The front end, the wasm port, the host CLI, the engine wrapper, the tests, the tools | **Apache-2.0** |
| `runtime/` — the nano runtime core, kernels, headers, the lineage header | **MIT** (sanoTTS), byte-identical to upstream, sha256s in `PROVENANCE.md` |
| `g2p/data/`, `voices/` | fetched, never committed: CMUdict and g2p weights are Apache-2.0; **the voice weights carry their own upstream terms** — see `voices/README.md` |

`NOTICE` has the licence texts and attributions. `PROVENANCE.md` lists what was
forked, what was deliberately left behind and why, and `make provenance` re-checks
it — including a grep that fails if a GPL component ever appears in code rather
than in a comment.

## The front end

`g2p/js/smit-g2p.js`, ~700 lines, no dependencies, node and browser alike.

* **CMUdict first**, then a clitic-aware apostrophe split (`kessler's` is a name
  plus /z/, not the letter "ess"), then the **neural GRU** for words no dictionary
  knows, then letter names as a last resort. Which of those fired is reported per
  word, because "why does it say that" is the first question anyone asks.
* **ARPAbet → the voice's alphabet**, including the parts that make it sound
  right rather than merely legal: ˈ sits before the stressed vowel; structural
  words ("the", "of", "is") carry no stress mark at all; AH collapses to a
  syllabic ᵊl in coda but keeps its schwa in "hello"; the American flap fires
  between a stressed and a weaker vowel and is blocked after a consonant —
  *water*, *bottle*, *atom*, but not *thirty* or *curtain*.
* **Stem + suffix for the words CMUdict missed**: it has "holiness" and not
  "nakedness", and the neural model filled the hole with "nack-dun-diz". When the
  stem is known the suffix is appended instead — measured over the dictionary,
  that is what CMUdict itself does 88-95% of the time for `-ness`, `-less`,
  `-ful`, `-ment`, `-ship`, `-hood`, `-like`, and it is what makes `maketh`,
  `knowest` and `shewed` come out as the verbs they are. Plurals take the voice
  of the phone they land on (`cubits`, `loins`), which the old rule got half right.
* **`g2p/readings/` is a patch, not a fork**: `{ WORD: "ARP ABET" }` for words the
  dictionary lacks — the Bible's `saith`, `sepulchres`, `Nebuchadnezzar`. It is
  consulted after the dictionary and before the model, so it fills holes without
  overriding anything. `tools/speak.js` loads it; `--no-readings` runs without.
* **Numbers, money, units, times, callsigns**: 1013 is "one thousand thirteen",
  $3.50 is "three dollars fifty", 90% is "ninety percent", 25kg is "twenty five
  kilograms", 20°C is "twenty degrees celsius", "left & right" keeps its "and",
  09:05 is "oh nine oh five", KX-9 is "kay ex nine", a.m. is two letter names.
  A mark that stands for a word is said before the tokeniser can treat it as
  punctuation; a mark that stands for nothing the voice has a sound for warns
  rather than going quiet. (The engine it replaces read "KX-9" as "kxminus nine".)
* **Any length, spoken in pieces**: the model reads one window of ~200 phonemes
  at a time, so `say()` cuts long text where a listener hears a break — end of
  sentence, then clause, then word, and characters only for a string with no
  words in it — renders each piece and appends it. The decoder leaves silence at
  both ends of a render, so the joins are silent and need no crossfade.
* **Refuses rather than truncates**: a piece that cannot be said — no phonemes in
  it, or a window the runtime's arena cannot fill — comes back as an error with
  a `kind`, never as a shorter line than you asked for.

How close is it to the front end it replaced? `tools/g2p-diff.js` runs sanoTTS's
own espeak path from a vendor checkout and measures the distance: **~93% reading
similarity** on the rig's dialogue, with the remaining differences being vowel
quality and stress placement rather than structure. That tool is a development
instrument — the comparison never enters the engine.

## The engine

The MIT core takes two weight blobs and an arena and never calls `malloc`;
`runtime/ports/wasm/smit_wasm.c` (Apache-2.0) is the browser face of that: hand
over the weights once, ask for an upper bound on samples, render, get PCM. No
streaming, no globals worth worrying about, one arena. The same core compiles to
a native binary (`make host`) which is what the tests compare the wasm build
against: **the two agree to correlation ≥ 0.995** on every test line (two libms
do not agree on the last bit of `logf`, and this model runs Box-Muller over both).

`engine/js/sanomit.js` wraps the whole thing — front end, runtime, WAV encoder —
in one `create()`/`say()` pair that takes every input as an argument, so the same
file runs in a page with everything embedded, a page that fetches, or node.
`say()` has no length limit: it renders `chunkTokens` ids at a time (150 by
default — the model's window is 207, and this wasm arena has been measured to
run out just past 170) and reports `chunks` and `pieceTokens` alongside the
audio. Text that fits in one window renders exactly as it did before pieces.

## What this voice cannot do

No speed control (durations come from the trained duration student), no noise
control (the decoder is deterministic given a seed), one speaker. The bench page
greys those knobs out instead of pretending. The seed is derived from the text,
so a line of dialogue sounds the same every time it is spoken — pass
`{ seed: n }` for the opposite effect.

## Layout

    runtime/          MIT core (forked), ports/ (ours): host, wasm
    g2p/              the Apache front end + fetched data
    engine/           the wrapper the demo and the CLI both use
    test/             g2p-test.js (front end), engine-test.js (wasm + parity + baseline)
    tools/            speak, build-wasm, get-data, g2p-diff, check-provenance
    voices/           weights: fetched, licensed separately, never committed
