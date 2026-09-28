#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * tools/speak.js -- say something with sanoMIT, from the command line.
 *
 *   tools/speak.js "Hull integrity: yours, not the ship's."
 *   tools/speak.js --phonemes "the weather is nice"
 *   tools/speak.js --out /tmp/line.wav "Six hundred and eleven dead."
 *   echo "text" | tools/speak.js --stdin --out /tmp/line.wav
 *
 * It runs the wasm engine (the same one the page runs) and writes a 16-bit WAV.
 * --phonemes stops before the runtime and prints what the front end decided,
 * which is the first thing to look at when a line sounds wrong.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const support = require('./node-support');
const SanoMIT = require('../engine/js/sanomit.js');
const SanoMitG2p = require('../g2p/js/smit-g2p.js');

async function main() {
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? argv[outAt + 1] : '/tmp/sanomit.wav';
  const rest = argv.filter((a, i) => a !== '--out' && i !== outAt + 1 && a !== '--phonemes' && a !== '--stdin');
  const text = argv.includes('--stdin')
    ? fs.readFileSync(0, 'utf8').trim()
    : (rest.join(' ') || 'Hello world, the weather is nice today.');

  if (argv.includes('--phonemes')) {
    const fe = SanoMitG2p.createFrontend({
      cmudict: support.json(support.data('cmudict.json')),
      neural: SanoMitG2p.loadNeuralModel(support.json(support.data('g2p_model.json')))
    });
    /* The same pieces say() would render, so this shows what the runtime gets. */
    const window = Math.min(SanoMIT.DEFAULT_CHUNK_TOKENS, fe.maxTokens);
    const pieces = fe.planChunks(text, window).filter(p => fe.costOf(p) > 0);
    if (!pieces.length) throw new Error('text produced nothing to say');
    console.log('text     : ' + text);
    pieces.forEach((piece, i) => {
      const r = fe.textToIds(piece);
      if (pieces.length > 1) console.log('-- piece ' + (i + 1) + ' of ' + pieces.length + ': ' + piece);
      console.log('phonemes : ' + r.phonemes);
      console.log('ids      : ' + r.ids.join(' '));
      console.log('tokens   : ' + r.ids.length + ' of ' + fe.maxTokens);
      r.warnings.forEach(w => console.log('warning  : ' + w));
    });
    return;
  }

  const engine = await SanoMIT.create({
    g2p: SanoMitG2p,
    runtime: require(path.join(__dirname, '..', 'dist', 'sanomit.js')),
    runtimeOptions: { locateFile: p => path.join(__dirname, '..', 'dist', p) },
    frontBlob: fs.readFileSync(support.voiceFile('front_q8.bin')),
    decBlob: fs.readFileSync(support.voiceFile('model_q8.bin')),
    cmudict: support.json(support.data('cmudict.json')),
    g2pModel: support.json(support.data('g2p_model.json'))
  });

  const r = await engine.say(text, { seed: true });
  fs.writeFileSync(out, Buffer.from(r.wav));
  console.log(text);
  console.log(r.phonemes);
  console.log(out + '  ' + r.seconds.toFixed(2) + 's at ' + engine.sampleRate + ' Hz, ' +
    r.runMs.toFixed(0) + ' ms (' + r.rtfx.toFixed(0) + 'x realtime), ' +
    r.sequenceLength + ' tokens, seed ' + r.seed.lo.toString(16) + r.seed.hi.toString(16));
  r.warnings.forEach(w => console.log('warning  : ' + w));
}

main().catch(e => { console.error(e.message); process.exit(1); });
