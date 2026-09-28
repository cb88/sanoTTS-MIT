# readings — readings the dictionary does not have

A patch, not a fork. Each json file here is `{ "WORD": "ARP ABET" }`, handed to
`createFrontend({ readings })`. The front end consults it **after** CMUdict and
**before** the neural model, so it fills holes and never overrides an entry the
dictionary already answers. `tools/speak.js` loads every file in this folder;
`--no-readings` runs without them.

    node tools/speak.js --phonemes "Nebuchadnezzar sat in the sepulchres"
    node tools/speak.js --no-readings --phonemes "the same line"

## kjv.json

Readings for the words an English reader meets in the King James Bible: the
archaic machinery (`saith`, `wherefore`, `threescore`, `hungred`), words for
things nobody digs up any more (`sepulchres`, `phylacteries`, `cherubims`), and
names (`Nebuchadnezzar`, `Hezekiah`, `Mephibosheth`). The target is the ordinary
English reading-room pronunciation, not Hebrew or Greek scholarship.

They are here because the neural model is a poor guesser about words a
dictionary simply lacks: it read `nakedness` as "nack-dun-diz" and
`Beelzebub` as "beelzebir". Some of that is now covered by the stem rules in
the front end (`-ness`, `-less`, `-eth`, `-est`, plurals); the rest needs to be
told.

Written from a scan of all 31,102 KJV verses for words the front end could not
read from the dictionary (`~/sano-bible/build/readings.py`, which also refuses
to write an entry that is not ARPAbet the voice knows, that carries anything
other than exactly one primary stress, or that shadows a CMUdict entry).

## Adding a reading

* One entry per word, uppercase, ARPAbet with a stress digit on every vowel.
* Never a word CMUdict already has — run the check in `readings.py` or ask the
  front end: `wordToPhonemes(word).source` says `dict`, `patch`, `stem+ness`,
  `neural` …
* Plurals of patched words are separate entries: the patch is consulted by
  exact word (`SEPULCHRE` and `SEPULCHRES` are both listed).

## Licence

The readings in this folder were written for this project and are Apache-2.0,
like the code. `g2p/data/cmudict.json`, which they complete, is the CMU
Pronouncing Dictionary — BSD-licensed by Carnegie Mellon, redistributed by the
Apache-2.0 tiny-tts package, fetched and never committed.
