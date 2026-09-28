#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * tools/check-provenance.sh -- is the fork still the fork?
 *
 *   node tools/check-provenance.js
 *
 * Checks the sha256 of every file sanoMIT forked against the manifest, and,
 * when vendor/sanoTTS is present, against upstream too. It is the answer to
 * "did anything GPL creep in, and is the MIT code still the MIT code" — a
 * question that should not need a lawyer or a memory.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const manifest = require('./provenance.json');
const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let bad = 0;
console.log('forked files (MIT)');
for (const f of manifest.forked) {
  const here = path.join(ROOT, f.path);
  if (!fs.existsSync(here)) { console.log('  MISSING  ' + f.path); bad++; continue; }
  const mine = sha256(here);
  const upstreamPath = path.join(ROOT, '..', f.from);
  const upstream = fs.existsSync(upstreamPath) ? sha256(upstreamPath) : null;
  const okSelf = mine === f.sha256;
  const note = upstream ? (upstream === mine ? 'identical to upstream' : 'DIFFERS FROM UPSTREAM')
    : '(upstream not checked out)';
  if (!okSelf || (upstream && upstream !== mine)) bad++;
  console.log('  ' + (okSelf ? 'ok  ' : 'FAIL') + '  ' + f.path.padEnd(44) + f.license + '  ' + note);
}
console.log('\nnot committed on purpose');
for (const [what, why] of Object.entries(manifest.data_not_committed)) {
  const present = fs.existsSync(path.join(ROOT, what));
  console.log('  ' + (present ? 'present (local, uncommitted)' : 'absent  ') + '  ' + what + '  — ' + why);
}
console.log('\ndeliberately not forked (the GPL side of upstream)');
Object.keys(manifest.not_forked).filter(k => !k.startsWith('_')).forEach(k =>
  console.log('  ' + k));

/* The licence claim in one grep: no code file in here may name a GPL thing.
 * The dev-only oracle lives in tools/ and says so in its own header; docs are
 * allowed to explain what we avoided. */
/* Code-level references, not prose: a real dependency calls espeak_ng_init or
 * imports phonemizer. Comments explaining what this fork avoids are allowed to
 * name those projects, so the pattern looks for the shapes that cannot appear
 * in an ordinary English sentence. */
const GPL_WORDS = /(espeak[_-][a-z0-9_]*|libespeak|misaki[._][a-z_]+|from phonemizer|import phonemizer|phonemizer\.[a-z_]+|piper[_-](phonemize|lite|g2p)|snt_g2p|SaanoTrellisFrontend)/i;
const CODE_EXT = /\.(c|h|js|mjs|json|py)$/;
const EXEMPT = [/^tools\/g2p-diff\.js$/, /^tools\/provenance\.json$/, /^tools\/check-provenance\.js$/];
function walk(dir, at) {
  const hits = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = at ? at + '/' + entry.name : entry.name;
    if (entry.isDirectory()) { hits.push(...walk(dir + '/' + entry.name, rel)); continue; }
    if (!CODE_EXT.test(entry.name)) continue;
    if (EXEMPT.some(re => re.test(rel))) continue;
    const lines = fs.readFileSync(path.join(ROOT, dir, entry.name), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      const isProse = t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') ||
        t.startsWith('<!--');
      /* Comment lines are allowed to name the projects this fork exists to
       * avoid — that is how the documentation explains itself. Everything else
       * is code: an include, a require, a call. */
      if (isProse) return;
      const m = GPL_WORDS.exec(line);
      if (m) hits.push(rel + ':' + (i + 1) + ': ' + m[0] + ' — ' + t.slice(0, 70));
    });
  }
  return hits;
}
console.log('\nno GPL component named in shipped code');
const hits = walk('.').filter(h => !h.startsWith('tools/g2p-diff') && !h.startsWith('dist/'));
if (hits.length) { hits.forEach(h => console.log('  FAIL  ' + h)); bad += hits.length; }
else console.log('  ok    clean across runtime/, engine/, g2p/, test/, tools/');

console.log(bad ? '\n' + bad + ' provenance problem(s)' : '\nprovenance clean');
process.exit(bad ? 1 : 0);
