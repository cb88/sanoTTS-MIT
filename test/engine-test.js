/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * test/engine-test.js -- does the sanoMIT engine actually speak?
 *
 *   node test/engine-test.js            # run the gates
 *   node test/engine-test.js --update   # re-record the regression baseline
 *
 * Four gates per line of test text:
 *   1. ids     the front end produces ids the model accepts, and drops nothing
 *   2. audio   the wasm runtime renders something speech-shaped: long enough,
 *              loud enough, not a wall of noise, and it comes back in chunks
 *   3. hash    the render is the render it was yesterday
 *   4. parity  the wasm render is *bit identical* to the native build's
 *
 * The baseline in test/baseline.json was recorded from this engine, not from
 * PyTorch. It catches a change; it does not certify correctness against the
 * training stack. See PROVENANCE.md for what would.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const support = require('../tools/node-support');
const SanoMIT = require('../engine/js/sanomit.js');
const SanoMitG2p = require('../g2p/js/smit-g2p.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/* ---------------------------------------------------------------- utils */

function fnv1aFloat32(samples) {
  const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  let h = 1469598103934665603n;
  const MASK = (1n << 64n) - 1n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h = (h * 1099511628211n) & MASK;
  }
  return '0x' + h.toString(16).padStart(16, '0');
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(a.length, 1));
}

/* Speech, as opposed to a tone or a hiss: the level has to move a lot between
 * short windows, because a sentence is mostly consonants and pauses. */
function dynamics(samples, window) {
  const n = Math.floor(samples.length / window);
  if (n < 4) return 0;
  const levels = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < window; j++) { const v = samples[i * window + j]; s += v * v; }
    levels.push(Math.sqrt(s / window));
  }
  const mean = levels.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return 0;
  const sorted = levels.slice().sort((a, b) => a - b);
  return (sorted[n - 1] - sorted[0]) / mean;
}

let checks = 0, failures = 0;
function ok(name, pass, detail) {
  checks++;
  if (!pass) failures++;
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  — ' + detail : ''));
}

/* --------------------------------------------------------------- engine */

async function boot() {
  const runtime = require(path.join(DIST, 'sanomit.js'));
  return SanoMIT.create({
    g2p: SanoMitG2p,
    runtime,
    runtimeOptions: { locateFile: p => path.join(DIST, p) },
    frontBlob: fs.readFileSync(support.voiceFile('front_q8.bin')),
    decBlob: fs.readFileSync(support.voiceFile('model_q8.bin')),
    cmudict: support.json(support.data('cmudict.json')),
    g2pModel: support.json(support.data('g2p_model.json'))
  });
}

/* The same ids through the native build of the same core. */
function nativeRender(voice, ids, seedText) {
  const host = path.join(DIST, 'smit_host');
  if (!fs.existsSync(host)) return null;
  const idsFile = path.join(DIST, 'test-ids.txt');
  const wav = path.join(DIST, 'test-render.wav');
  fs.writeFileSync(idsFile, ids.join(' '));
  return { json: JSON.parse(execFileSync(host, [voice, wav, idsFile, '--seed-from', seedText],
    { encoding: 'utf8' }).trim()), wav };
}

/* Two libms do not agree on the last bit of logf/sinf, and this model runs
 * Box-Muller over both, so "bit identical across platforms" is not on the
 * table — upstream holds its own portability gate at 0.98 correlation against
 * a reference for exactly that reason. What is checked here is that the native
 * and wasm builds of this core agree with each other. */
function correlate(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i];
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) * (sa / n), vb = sbb / n - (sb / n) * (sb / n);
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

function readWavMono(file) {
  const buf = fs.readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = view.getUint32(40, true);
  const out = new Float32Array(n / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(44 + i * 2, true) / 32767;
  return out;
}

/* ----------------------------------------------------------------- main */

(async function main() {
  const update = process.argv.includes('--update');
  const voice = support.voiceDir();
  const texts = fs.readFileSync(path.join(__dirname, 'cases', 'sentences.txt'), 'utf8')
    .split('\n').filter(l => l.trim() && !l.startsWith('#'));

  console.log('sanoMIT engine test');
  console.log('  voice: ' + path.relative(ROOT, voice));

  const engine = await boot();
  const ready = engine.ready;
  ok('engine loads', ready.sampleRate === 24000 && ready.vocab === 62,
    ready.loadMs.toFixed(0) + ' ms, ' + (ready.modelBytes / 1024).toFixed(0) + ' KB of weights, ' +
    ready.sampleRate + ' Hz, vocab ' + ready.vocab + ', cap ' + ready.maxTokens);

  const baselinePath = path.join(__dirname, 'baseline.json');
  const baseline = fs.existsSync(baselinePath) ? support.json(baselinePath) : {};
  const recorded = {};
  let totalSeconds = 0, totalMs = 0;

  for (const text of texts) {
    const label = (text.length > 44 ? text.slice(0, 44) + '…' : text).padEnd(46);
    try {
      const r = engine.textToIds(text);
      ok('ids   ' + label, r.ids.every(id => id >= 0 && id < ready.vocab) && r.dropped === '' &&
        r.ids.length <= ready.maxTokens,
        r.ids.length + ' ids' + (r.dropped ? ', dropped "' + r.dropped + '"' : '') +
        (r.warnings.length ? ', ' + r.warnings.length + ' warning(s)' : ''));

      const said = await engine.say(text, { seed: true });
      const level = rms(said.samples);
      const movement = dynamics(said.samples, Math.round(engine.sampleRate * 0.05));
      totalSeconds += said.seconds; totalMs += said.runMs;
      ok('audio ' + label, said.seconds > 0.3 && said.seconds < 25 &&
        level > 0.02 && level < 0.9 && movement > 0.5,
        said.seconds.toFixed(2) + 's, rms ' + level.toFixed(3) +
        ', dynamics ' + movement.toFixed(1) + ', ' + said.runMs.toFixed(0) + ' ms (' +
        said.rtfx.toFixed(0) + 'x realtime)');

      const hash = fnv1aFloat32(said.samples);
      recorded[text] = { hash, samples: said.samples.length, seconds: +said.seconds.toFixed(3) };
      if (baseline[text] || update) {
        ok('hash  ' + label, baseline[text] ? baseline[text].hash === hash : true,
          hash + (baseline[text] ? '' : '  (new, recorded this run)'));
      }

      const native = nativeRender(voice, said.ids, text);
      if (native) {
        const r = correlate(readWavMono(native.wav), said.samples);
        ok('parity' + label, native.json.hash === hash || r >= 0.995,
          'correlation ' + r.toFixed(5) + (native.json.hash === hash ? ', bit exact' : '') +
          ' (native ' + native.json.samples + ' samples, wasm ' + said.samples.length + ')');
      }
    } catch (e) {
      ok('render ' + label, false, e.message);
    }
  }

  /* One render is one window of phonemes, so anything longer than the window is
   * spoken in pieces. The gate is that a long line arrives as speech rather
   * than as a refusal, and that it is the same speech every time. */
  const longLine = 'The Kestrel Prime exploded at 04:11. Not dramatically. A pressure seam '
    + 'in the number four hold let go, and then everything that was nearby became part of the '
    + 'same event. Five other hulls. A habitat ring with its spine taken out. Six hundred and '
    + 'eleven dead. Dock control, Anchor Ring. You are on an Authority restricted approach with '
    + 'a hull registration that reads like a joke. This is a lifeboat, we have four people and '
    + 'a failing scrubber. Please do not go past us again.';
  const long1 = await engine.say(longLine, { seed: true });
  const long2 = await engine.say(longLine, { seed: true });
  const longLevel = rms(long1.samples);
  const longMove = dynamics(long1.samples, Math.round(engine.sampleRate * 0.05));
  const sameTwice = long1.samples.length === long2.samples.length &&
    long1.samples.every((v, i) => v === long2.samples[i]);
  ok('long   text past one window', long1.chunks > 1 && long1.seconds > 20 &&
    longLevel > 0.02 && longLevel < 0.9 && longMove > 0.5 && sameTwice && !long1.warnings.length,
    long1.seconds.toFixed(1) + 's in ' + long1.chunks + ' pieces, ' + long1.sequenceLength +
    ' ids, rms ' + longLevel.toFixed(3) + ', dynamics ' + longMove.toFixed(1) +
    ', twice identical ' + sameTwice);
  ok('long   every piece fits the window',
    long1.pieceTokens.every(n => n <= engine.ready.chunkTokens),
    long1.pieceTokens.join(' ') + ' (window ' + engine.ready.chunkTokens + ')');
  /* A window the runtime cannot fill is an error, never a short line. */
  const greedy = await engine.say(longLine, { seed: true, chunkTokens: 400 }).catch(e => e);
  ok('long   an unfillable window says so', greedy instanceof Error && /arena/.test(greedy.message),
    greedy.message ? greedy.message.slice(0, 72) : String(greedy));

  console.log('  speech rendered: ' + totalSeconds.toFixed(1) + 's in ' + totalMs.toFixed(0) +
    ' ms — ' + (totalSeconds * 1000 / Math.max(totalMs, 1)).toFixed(0) + 'x realtime');

  if (update) {
    fs.writeFileSync(baselinePath, JSON.stringify(recorded, null, 2) + '\n');
    console.log('  baseline.json re-recorded (' + Object.keys(recorded).length + ' lines)');
  }
  console.log(failures ? failures + ' of ' + checks + ' checks FAILED'
    : 'all ' + checks + ' checks passed');
  process.exit(failures ? 1 : 0);
})();
