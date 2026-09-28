/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * tools/node-support.js -- where node finds the data this engine reads.
 *
 * sanoMIT carries code, not the 5 MB dictionary or the voice blobs (see
 * tools/get-data.sh for fetching them, voices/README.md for the licence). Locally
 * they live in g2p/data and voices/; in the vendor tree next door they already
 * exist, so a checkout two directories up counts too.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, '..', 'vendor');

function firstExisting(candidates, what) {
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  throw new Error(what + ' not found. Run tools/get-data.sh, or set ' +
    'SMIT_DATA / SMIT_VOICE. Looked in:\n  ' + candidates.join('\n  '));
}

function data(name, subdir) {
  const fromEnv = process.env.SMIT_DATA;
  return firstExisting([
    fromEnv && path.join(fromEnv, name),
    path.join(ROOT, subdir || 'g2p', 'data', name),
    path.join(VENDOR, 'tiny-tts', 'npm-package', name)
  ], name);
}

/* A directory holding front_q8.bin and model_q8.bin. */
function voiceDir() {
  const candidates = [
    process.env.SMIT_VOICE,
    path.join(ROOT, 'voices', 'heartnano'),
    path.join(VENDOR, 'sanoTTS', 'web', 'voices', 'heartnano')
  ];
  for (const d of candidates) {
    if (d && fs.existsSync(path.join(d, 'front_q8.bin'))) return d;
  }
  throw new Error('no voice blobs (front_q8.bin, model_q8.bin). Looked in:\n  ' +
    candidates.join('\n  '));
}

function voiceFile(name) { return path.join(voiceDir(), name); }

function json(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

module.exports = { ROOT, VENDOR, data, voiceDir, voiceFile, json, firstExisting };
