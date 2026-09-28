/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * tools/g2p-diff.js — compare sanoMIT's Apache front end against the front end
 * sanoTTS ships (espeak-ng + misaki, GPL-3.0).
 *
 *   node tools/g2p-diff.js [--texts file.txt] [--verbose N] [--no-oracle]
 *
 * The GPL side runs from vendor/sanoTTS on this machine and is never shipped,
 * packaged or imported by the engine; it exists here to answer one question:
 * how far is the phoneme-id sequence from the one the voice was trained on?
 * Without vendor/sanoTTS present the script still checks the Apache side.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SanoMitG2p = require('../g2p/js/smit-g2p.js');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, '..', 'vendor');
const TINY = path.join(VENDOR, 'tiny-tts', 'npm-package');
const SAANO_WEB = path.join(VENDOR, 'sanoTTS', 'web');

const TEXTS = [
  'Hello world, the weather is nice today.',
  "Kessler's kessellite thruster made a wet thwup near the airlock, and the regolith cracked against the xenolith.",
  'Oxygen at 42 percent. Hull pressure 1013. Docking at 09:05, backup at 14:30.',
  'Inspector Haldy of Claims 14-F, Portmaster Vasquez, Dr. Greb, B. Yuen, Khoda, "Sable", and the flight recorder KX-9 Kestrel are all on this frequency at once.',
  'SUIT ONLINE. OXYGEN 71 PERCENT. HULL INTEGRITY: YOURS, NOT THE SHIP\'S.',
  'Good morning. Or evening. The sun is coming over Anvil now, so: morning.',
  'The Kestrel Prime exploded at 04:11. Not dramatically.',
  'A pressure seam in the number four hold let go, and then everything that was nearby became part of the same event.',
  'Five other hulls. A habitat ring with its spine taken out. Six hundred and eleven dead.',
  'Dock control, Anchor Ring. You are on a Authority-restricted approach with a hull registration that reads like a joke.',
  'unidentified rig, this is a lifeboat, we have four people and a failing scrubber.',
  'Please do not go past us again.',
  'WARNING. You have made a hole in a volume that was holding air.',
  'Patch the hole. Then let the scrubber refill the volume.',
  'The water bottle is on the table.',
  'I would like a quarter, a dollar and thirty cents.',
  'She sells seashells by the seashore.',
  'This is a test of the emergency broadcast system.',
  'Bird, word, held, fur, birdword.',
  'About the hour, our tower is out.',
  'Station, motion, nation, education.',
  'Two thousand twenty-six, and the year 1066.',
  'Dr. Voss paid $3.50 for the 21st sample at 1 a.m.'
];

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

async function oracle(texts) {
  if (!fs.existsSync(path.join(SAANO_WEB, 'snt_g2p.js'))) return null;
  const src = fs.readFileSync(path.join(SAANO_WEB, 'snt_g2p.js'), 'utf8');
  const factory = new Function('require', '__dirname', src + '\n;return SaanoG2P;')(
    require, SAANO_WEB + '/');
  const mod = await factory({ locateFile: p => path.join(SAANO_WEB, p) });
  const toIpa = mod.cwrap('snt_g2p_text_to_ipa', 'number', ['number', 'number', 'number']);
  const BUF = 16384;
  const inP = mod._malloc(4096), outP = mod._malloc(BUF);
  new Function(fs.readFileSync(path.join(SAANO_WEB, 'trellis_frontend.js'), 'utf8'))();
  const fe = globalThis.SaanoTrellisFrontend.createFrontend({
    espeakIpa(text) {
      const nb = mod.lengthBytesUTF8(text) + 1;
      mod.stringToUTF8(text, inP, nb);
      const rc = toIpa(inP, outP, BUF);
      if (rc < 0) throw new Error('espeak ipa failed: ' + rc);
      return mod.UTF8ToString(outP);
    }
  });
  return texts.map(t => {
    try { return fe.textToIds(t); } catch (e) { return { error: e.message }; }
  });
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
}

/* edit distance over the phoneme string: "how alike does it read" as a number */
function similarity(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return 1 - prev[n] / Math.max(m, n);
}

async function main() {
  const argv = process.argv.slice(2);
  const wantOracle = !argv.includes('--no-oracle');
  const verboseAt = argv.indexOf('--verbose');
  const verbose = verboseAt >= 0 ? parseInt(argv[verboseAt + 1] || '3', 10) : 0;
  const textsAt = argv.indexOf('--texts');
  const texts = textsAt >= 0
    ? fs.readFileSync(argv[textsAt + 1], 'utf8').split('\n').filter(s => s.trim())
    : TEXTS;

  const cmudict = loadJson(path.join(TINY, 'cmudict.json'));
  const neural = SanoMitG2p.loadNeuralModel(loadJson(path.join(TINY, 'g2p_model.json')));
  const fe = SanoMitG2p.createFrontend({ cmudict, neural });

  const oracleOut = wantOracle ? await oracle(texts) : null;
  if (wantOracle && !oracleOut) console.log('oracle unavailable (no vendor/sanoTTS) — Apache side only\n');

  let exact = 0, compared = 0, lenDiff = 0, score = 0;
  const confusion = {};
  for (let i = 0; i < texts.length; i++) {
    const mine = fe.textToIds(texts[i]);
    const theirs = oracleOut ? oracleOut[i] : null;
    if (verbose && i < verbose) {
      console.log('--- ' + texts[i]);
      console.log('  sanoMIT : ' + mine.phonemes);
      if (theirs && theirs.phonemes) console.log('  espeak  : ' + theirs.phonemes);
    }
    if (!theirs || theirs.error) continue;
    compared++;
    score += similarity(mine.phonemes, theirs.phonemes);
    if (String(mine.ids) === String(theirs.ids)) exact++;
    else {
      /* the first place the two readings part company, with a little of each
       * reading on both sides so a human can see what happened */
      const d = firstDiff(mine.phonemes, theirs.phonemes);
      const key = JSON.stringify(theirs.phonemes.slice(Math.max(0, d - 3), d + 4)) +
        ' vs ' + JSON.stringify(mine.phonemes.slice(Math.max(0, d - 3), d + 4));
      confusion[key] = (confusion[key] || 0) + 1;
      lenDiff += Math.abs(mine.ids.length - theirs.ids.length);
      if (verbose) {
        console.log('  MISMATCH at ' + d +
          '  ref: ' + JSON.stringify(theirs.phonemes.slice(Math.max(0, d - 12), d + 12)) +
          '\n              ours: ' + JSON.stringify(mine.phonemes.slice(Math.max(0, d - 12), d + 12)));
      }
    }
  }
  console.log('sentences       : ' + texts.length);
  console.log('compared        : ' + compared);
  console.log('exact id match  : ' + exact + (compared ? ' (' + (100 * exact / compared).toFixed(0) + '%)' : ''));
  console.log('mean |len diff| : ' + (compared ? (lenDiff / compared).toFixed(1) : '0') + ' tokens');
  console.log('mean similarity : ' + (100 * score / Math.max(compared, 1)).toFixed(1) + '% of the reference reading');
  const top = Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log('first-divergence counts (reference -> ours):');
    for (const [k, n] of top) console.log('  ' + n + 'x ' + k);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
