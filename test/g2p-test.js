/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * test/g2p-test.js -- the front end on its own: readings, numbers, letters,
 * clitics, the token cap. Needs no model and no runtime, so it runs anywhere.
 *
 *   node test/g2p-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G2p = require('../g2p/js/smit-g2p.js');

const ROOT = path.join(__dirname, '..');

/* The data files live next to the vendor checkout when there is one, and in
 * g2p/data (where tools/get-data.sh puts them) when there is not. */
const SOURCES = [path.join(ROOT, '..', 'vendor', 'tiny-tts', 'npm-package'),
  path.join(ROOT, 'g2p', 'data')];
const from = name => {
  const hit = SOURCES.find(dir => fs.existsSync(path.join(dir, name)));
  if (!hit) throw new Error(name + ' is not in ' + SOURCES.join(' or ') + ' — run tools/get-data.sh');
  return JSON.parse(fs.readFileSync(path.join(hit, name), 'utf8'));
};

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases', 'g2p.json'), 'utf8'));
const cmudict = from('cmudict.json');
const neural = G2p.loadNeuralModel(from('g2p_model.json'));
const fe = G2p.createFrontend({ cmudict, neural });

/* every readings patch in g2p/readings, the way tools/speak.js loads them */
const READINGS = {};
{
  const dir = path.join(ROOT, 'g2p', 'readings');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const patch = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of Object.keys(patch)) if (!k.startsWith('_')) READINGS[k] = patch[k];
  }
}
const fePatched = G2p.createFrontend({ cmudict, neural, readings: READINGS });
const feNoNeural = G2p.createFrontend({ cmudict });

let checks = 0, failures = 0;
function is(name, got, want) {
  checks++;
  const pass = got === want;
  if (!pass) failures++;
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '  ' + got : '  got ' + got + ', want ' + want));
}

console.log('word readings');
for (const [word, want] of Object.entries(cases.words)) {
  const got = fe.wordToPhonemes(word);
  is(word, got ? got.ipa : null, want);
}

console.log('structural words carry no stress');
for (const word of cases.structural) {
  const got = fe.wordToPhonemes(word);
  checks++;
  const pass = got && !/[ˈˌ]/.test(got.ipa);
  if (!pass) failures++;
  console.log((pass ? '  ok   ' : '  FAIL ') + word.padEnd(12) + (got ? got.ipa : '—'));
}

console.log('numbers, symbols and letters');
for (const [text, want] of Object.entries(cases.phrases)) {
  is(text, fe.phonemize(text), want);
}

console.log('the neural model is what makes new words possible');
const unknownWord = 'kessellite';
const withNeural = fe.wordToPhonemes(unknownWord);
is('unknown word, neural on', withNeural.source, 'neural');
is('unknown word, neural off', feNoNeural.wordToPhonemes(unknownWord), null);
is('and it warns instead of failing quietly', feNoNeural.textToIds('a kessellite').warnings.length > 0, true);
const regolith = fe.wordToPhonemes('regolith');
const unreadable = [...regolith.ipa].filter(c => !(c in fe.vocabulary));
is('regolith reads as a word', unreadable.join('') + regolith.ipa, regolith.ipa);

console.log('the vocabulary is the contract');
const sample = fe.textToIds('SUIT ONLINE. Oxygen 71 percent, hull integrity — yours.');
is('nothing dropped', sample.dropped, '');
is('ids in range', sample.ids.every(id => id >= 0 && id < 62), true);
is('wrapped in bos/eos', sample.ids[0] === 1 && sample.ids[sample.ids.length - 1] === 2, true);

let tooLongFailed = false;
try { fe.textToIds('ha '.repeat(400)); } catch (e) { tooLongFailed = e.kind === 'too_long'; }
is('over-long text is refused, not truncated', tooLongFailed, true);

let emptyFailed = false;
try { fe.textToIds('   '); } catch (e) { emptyFailed = e.kind === 'empty'; }
is('empty text is refused', emptyFailed, true);

console.log('a symbol that stands for a word is said, not dropped');
{
  /* the reading is allowed no silence: a mark it cannot say has to warn */
  const r = fe.textToIds('Hull 90% nominal, left & right, 3.5 bar, 25kg, 20°C, #1, 50¢, 2 × 3 = 6.');
  is('nothing dropped or warned away', r.warnings.join(' ') + r.dropped, '');
  is('percent is said', /pəɹsˈɛnt/.test(r.phonemes), true);
  is('and is said', / ænd /.test(r.phonemes), true);
  is('no digit or sign survives', /[0-9%&§°]/.test(r.phonemes), false);
}

console.log('text past one window is cut where a listener hears the break');
{
  const budget = 150;
  const para = 'The Kestrel Prime exploded at 04:11. Not dramatically. A pressure seam in the '
    + 'number four hold let go, and then everything that was nearby became part of the same '
    + 'event. Five other hulls. A habitat ring with its spine taken out. Six hundred and eleven '
    + 'dead. Please do not go past us again.';
  const parts = fe.planChunks(para, budget);
  const costs = parts.map(p => fe.costOf(p));
  is('every piece fits', costs.every(c => c > 0 && c <= budget), true);
  is('nothing lost, nothing repeated', parts.join(''), para);
  is('more than one piece', parts.length > 1, true);
  is('sentences stay whole', parts[0].trim().endsWith('.'), true);
  is('a line that fits is left alone', fe.planChunks('Short line.', budget).length, 1);
  is('silence is not a piece', fe.planChunks('    ', budget).length, 0);
  /* text with no words in it at all still has to come out in windows */
  const url = 'https://example.com/a/very/long/path?query=' + 'x'.repeat(300);
  const bits = fe.planChunks(url, 40);
  is('even a wordless string', bits.every(p => fe.costOf(p) <= 40) && bits.join('') === url, true);
  const tiny = fe.planChunks('words in a row', 3);
  is('a hopeless budget still terminates', tiny.length > 1 && tiny.join('') === 'words in a row', true);
}

console.log('a word the dictionary missed is finished by rule, not guessed');
{
  /* CMUdict has "holiness" and not "nakedness"; the neural model answered the
   * gap with the wrong stem vowel and a voiced S ("nack-dun-diz"). */
  const derived = {
    nakedness: ['stem+ness', 'nˈAkədnəs'],
    bareness: ['stem+ness', 'bˈɛɹnəs'],
    maketh: ['stem+eth', 'mˈækəθ'],
    knowest: ['stem+est', 'nˈOəst'],
    shewed: ['stem+ed', 'ʃˈud'],
    thyself: ['stem+self', 'ðˈIsɛlf']
  };
  for (const [word, [source, ipa]] of Object.entries(derived)) {
    const r = fe.wordToPhonemes(word);
    is(word + ' by rule', r.source + ' ' + r.ipa, source + ' ' + ipa);
  }
  is('and the neural model is not asked', fe.wordToPhonemes('naked').source, 'dict');

  /* the plural ending takes the voice of the phone it lands on */
  const plurals = { cubits: 'S', loins: 'Z', euros: 'Z', rocks: 'S', beds: 'Z' };
  for (const [word, ending] of Object.entries(plurals)) {
    const r = fe.wordToPhonemes(word);
    is(word + ' plural ends in ' + ending, r.arpabet[r.arpabet.length - 1], ending);
  }
}

console.log('a readings patch fills holes without touching the dictionary');
{
  is('the patch answers saith', fePatched.wordToPhonemes('saith').source, 'patch');
  is('with the reading written down', fePatched.wordToPhonemes('saith').ipa, 'sˈɛθ');
  is('and sepulchres', fePatched.wordToPhonemes('sepulchres').ipa, 'sˈɛpəlkəɹz');
  is('without a patch the same word is guessed', fe.wordToPhonemes('saith').source, 'neural');
  is('a dictionary word is untouched either way', fePatched.wordToPhonemes('water').source, 'dict');
  const shadow = Object.keys(READINGS).filter(w => cmudict[w] || cmudict[w + '(1)']);
  is('no patch entry shadows CMUdict', shadow.join(' '), '');
  const badStress = Object.entries(READINGS)
    .filter(([, p]) => p.split(' ').filter(t => t.endsWith('1')).length !== 1)
    .map(([w]) => w);
  is('every patch entry carries exactly one primary stress', badStress.join(' '), '');
}

console.log('every symbol the front end can emit has an id');
{
  const emitted = new Set();
  for (const list of Object.values(G2p.ARPA)) {
    for (const ch of [list.ipa, list.stressed, list.reduced, list.flap]) {
      if (ch) for (const c of ch) emitted.add(c);
    }
  }
  for (const ch of 'ᵊlᵊmˈˌ,.!?;:—“”()"') emitted.add(ch);
  const unknown = [...emitted].filter(c => !(c in fe.vocabulary));
  is('no symbol without an id', unknown.length ? unknown.join(' ') : '', '');
}

console.log(failures ? failures + ' of ' + checks + ' checks failed'
  : 'all ' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
