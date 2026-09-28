/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * sanomit.js -- the sanoMIT engine: front end + runtime + WAV, in one call.
 *
 * Environment-free by construction. Everything it needs is handed in, so the
 * same file runs in a page that has every byte embedded, a page that fetches
 * them, or node:
 *
 *   const engine = await createSanoMIT({
 *     runtime:    the emscripten factory from dist/sanomit.js,
 *     wasmBinary: an ArrayBuffer of dist/sanomit.wasm,        (optional)
 *     frontBlob / decBlob: ArrayBuffer|Uint8Array of the voice weights,
 *     cmudict:    the parsed CMU dictionary,                  (optional)
 *     g2pModel:   the parsed g2p_model.json                   (optional)
 *   });
 *   const r = await engine.say("Hull integrity: yours.", { seed: true });
 *   r.samples  Float32Array at engine.sampleRate
 *   r.wav      ArrayBuffer, 16-bit PCM mono
 *
 * What the voice cannot do, it says so: this runtime has no speed or noise
 * knob (durations come from the trained duration student), so asking for one
 * arrives in `warnings` rather than being silently ignored.
 */
var SanoMIT = (function () {
  'use strict';

  var VOICE_NAME = "heartnano";   /* this engine holds one voice; see voices/README.md */

  /* Phoneme ids per render. The model's own window is 207, but the wasm arena
   * the runtime renders into has been measured to run out just past 170, so a
   * window this side of that is the one that never fails. Bump it with
   * create({ chunkTokens }) if the arena grows. */
  var DEFAULT_CHUNK_TOKENS = 150;

  function bytesOf(x) {
    if (!x) return null;
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return new Uint8Array(x);
    throw new Error("expected an ArrayBuffer or Uint8Array, got " + Object.prototype.toString.call(x));
  }

  /* 16-bit PCM mono, the one container every platform already opens. */
  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var buffer = new ArrayBuffer(44 + n * 2);
    var view = new DataView(buffer);
    function ascii(offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    }
    ascii(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);           /* PCM */
    view.setUint16(22, 1, true);           /* mono */
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, n * 2, true);
    for (var i = 0, o = 44; i < n; i++, o += 2) {
      var v = samples[i];
      v = v > 1 ? 1 : (v < -1 ? -1 : v);
      view.setInt16(o, Math.round(v * 32767), true);
    }
    return buffer;
  }

  async function create(config) {
    config = config || {};
    if (typeof config.runtime !== "function") throw new Error("createSanoMIT needs the runtime factory");
    var booted = performance.now ? performance.now() : Date.now();

    var mod = await config.runtime(Object.assign({}, config.runtimeOptions || {},
      config.wasmBinary ? { wasmBinary: config.wasmBinary } : {}));

    var front = bytesOf(config.frontBlob);
    var dec = bytesOf(config.decBlob);
    if (!front || !dec) throw new Error("the engine needs both weight blobs (front_q8.bin, model_q8.bin)");
    var fP = mod._malloc(front.length); mod.HEAPU8.set(front, fP);
    var dP = mod._malloc(dec.length); mod.HEAPU8.set(dec, dP);
    var rc = mod._smit_voice_load(fP, dP);
    if (rc !== 0) throw new Error("the runtime refused the voice blobs (" + rc + ")");

    var G2p = config.g2p || (typeof SanoMitG2p !== "undefined" ? SanoMitG2p : null);
    if (!G2p) throw new Error("no front end: pass config.g2p or load smit-g2p.js first");
    var frontend = G2p.createFrontend({
      cmudict: config.cmudict || null,
      neural: config.g2pModel ? G2p.loadNeuralModel(config.g2pModel) : null,
      vocabulary: config.vocabulary || null,
      maxTokens: config.maxTokens || undefined
    });

    var sampleRate = mod._smit_sample_rate();
    var modelBytes = front.length + dec.length;

    /* The seed lives in the wasm heap for the whole render: a 64-bit number
     * cannot cross a JavaScript call, so it is written into memory instead. */
    function writeSeed(seedPtr, text) {
      var n = mod.lengthBytesUTF8(text) + 1;
      var tP = mod._malloc(n);
      mod.stringToUTF8(text, tP, n);
      var rc = mod._snt_nano_sha256_seed(tP, seedPtr);
      mod._free(tP);
      if (rc !== 0) throw new Error("seed derivation failed (" + rc + ")");
      return { lo: mod.HEAPU32[seedPtr / 4], hi: mod.HEAPU32[seedPtr / 4 + 1] };
    }

    /* say(text, options) -> the whole utterance, however long the text is.
     * options.seed: true (the default) or a number. true derives the seed from
     * the text, which is what makes a line sound the same every time it is
     * spoken; a number makes two different lines sound the same.
     * options.chunkTokens: how many phoneme ids one render may hold.
     *
     * The model takes one window of phonemes at a time — 207 ids is its own
     * cap, and the runtime's arena has been measured to fail past ~170 — so
     * longer text is spoken in pieces, cut where a listener hears a break (see
     * planChunks) and appended. One piece is exactly one render: same ids, same
     * seed, same samples as before there were pieces at all. */
    var chunkTokens = config.chunkTokens || DEFAULT_CHUNK_TOKENS;

    /* The seed belongs to the whole text, so a paragraph reads the same every
     * time; each piece mixes its number into it, so the pieces of one paragraph
     * do not all breathe the same noise. Piece 0 is left unmixed. */
    function seedPiece(seedPtr, text, index, options) {
      var base = (options.seed == null || options.seed === true)
        ? writeSeed(seedPtr, text)
        : {
            lo: options.seed.lo != null ? options.seed.lo >>> 0 : options.seed >>> 0,
            hi: options.seed.hi != null ? options.seed.hi >>> 0
                                        : Math.floor(options.seed / 4294967296)
          };
      var mixed = {
        lo: (base.lo + index * 0x9e3779b9) >>> 0,
        hi: (base.hi + index * 0x85ebca6b) >>> 0
      };
      mod.HEAPU32[seedPtr / 4] = mixed.lo;
      mod.HEAPU32[seedPtr / 4 + 1] = mixed.hi;
      return mixed;
    }

    async function say(text, options) {
      options = options || {};
      var warnings = [];
      if (options.speed != null && options.speed !== 1) {
        warnings.push("this voice has no speed control: durations come from the model");
      }
      if (options.noiseScale != null && options.noiseScale !== 0) {
        warnings.push("this voice has no noise control: the decoder is deterministic given a seed");
      }

      var budget = Math.min(options.chunkTokens || chunkTokens, frontend.maxTokens);
      /* A cut can leave a piece of nothing but spaces, and the front end is
       * right to refuse that, so those pieces never reach the runtime. */
      var pieces = frontend.planChunks(text, budget).filter(function (p) {
        return frontend.costOf(p) > 0;
      });
      if (!pieces.length) throw new Error("text produced nothing to say");
      var pieceTokens = [];                      /* ids per piece, for the bench */

      var seedPtr = mod._malloc(8);
      var idPtr = 0, idCap = 0, outPtr = 0, outCap = 0;
      var spoken = new Float32Array(0), written = 0, ids = [], phonemes = [];
      var runMs = 0, seed = null;
      try {
        for (var p = 0; p < pieces.length; p++) {
          /* textToIds restarts the warning list every time: collect as we go */
          var said = frontend.textToIds(pieces[p]);
          warnings = warnings.concat(said.warnings || []);
          if (said.dropped) {
            warnings.push('dropped "' + said.dropped + '" (not in the voice vocabulary)');
          }

          if (said.ids.length > idCap) {
            mod._free(idPtr);
            idCap = said.ids.length;
            idPtr = mod._malloc(idCap * 4);
          }
          mod.HEAP32.set(Int32Array.from(said.ids), idPtr / 4);

          var cap = mod._smit_required_samples(said.ids.length);
          if (cap > outCap) {
            mod._free(outPtr);
            outCap = cap;
            outPtr = mod._malloc(outCap * 4);
          }
          seed = seedPiece(seedPtr, text, p, options);

          var t0 = now();
          var n = mod._smit_render(idPtr, said.ids.length, seedPtr, outPtr, outCap);
          runMs += now() - t0;
          if (n <= 0) {
            throw new Error("the runtime returned " + n + " samples for a " +
              said.ids.length + "-id piece (window " + outCap + " samples): the arena ran out");
          }
          pieceTokens.push(said.ids.length);

          /* Appended, not crossfaded: the decoder leaves silence at both ends of
           * every render, so the joins land in silence — measured, not assumed. */
          spoken = appendSamples(spoken, written, mod.HEAPF32.subarray(outPtr / 4, outPtr / 4 + n));
          written += n;
          ids = ids.concat(Array.prototype.slice.call(said.ids));
          phonemes.push(said.phonemes);
        }
      } finally {
        mod._free(idPtr);
        mod._free(outPtr);
        mod._free(seedPtr);
      }

      var seconds = written / sampleRate;
      return {
        samples: spoken.subarray(0, written),
        wav: encodeWav(spoken.subarray(0, written), sampleRate),
        seconds: seconds,
        runMs: runMs,
        rtfx: runMs > 0 ? (seconds * 1000) / runMs : 0,
        sequenceLength: ids.length,
        /* the model renders one window at a time, so a long line is several */
        chunks: pieces.length,
        pieceTokens: pieceTokens,
        phonemes: phonemes.join(" "),
        ids: ids,
        warnings: warnings,
        seed: seed,
        /* the fields a bench shows for any voice, so one page can host more
         * than one engine without special-casing the table */
        voice: VOICE_NAME,
        voiceId: 0,
        normalized: String(text).toLowerCase()
      };
    }

    function now() {
      return performance.now ? performance.now() : Date.now();
    }

    /* Samples arrive piece by piece and the total is not known up front, so the
     * buffer doubles when it runs out rather than copying on every append. */
    function appendSamples(target, used, more) {
      if (used + more.length > target.length) {
        var bigger = new Float32Array(Math.max((used + more.length) * 2, 4096));
        bigger.set(target.subarray(0, used));
        target = bigger;
      }
      target.set(more, used);
      return target;
    }

    var ready = {
      engine: "sanomit",
      loadMs: (performance.now ? performance.now() : Date.now()) - booted,
      nVoices: 1,
      voices: [VOICE_NAME],
      modelBytes: modelBytes,
      threads: 1,
      sampleRate: sampleRate,
      vocab: mod._smit_vocab(),
      maxTokens: mod._smit_max_tokens(),
      chunkTokens: chunkTokens,
      params: 294279,
      supports: { speed: false, noise: false, voices: 1 }
    };

    return {
      say: say,
      phonemize: function (text) { return frontend.phonemize(text); },
      textToIds: function (text) { return frontend.textToIds(text); },
      ready: ready,
      module: mod,
      sampleRate: sampleRate
    };
  }

  return {
    create: create,
    encodeWav: encodeWav,
    DEFAULT_CHUNK_TOKENS: DEFAULT_CHUNK_TOKENS   /* the window say() renders at */
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SanoMIT;
if (typeof window !== "undefined") window.SanoMIT = SanoMIT;
