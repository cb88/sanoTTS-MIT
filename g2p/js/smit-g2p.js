/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 kessler-rig authors
 *
 * smit-g2p.js -- sanoMIT's text front end: English text -> sano phoneme ids.
 *
 * This is the piece sanoTTS gets from espeak-ng (GPL-3.0). sanoMIT replaces it
 * with two Apache-2.0 parts and a mapping table written for this project:
 *
 *   text -> words
 *        -> CMU Pronouncing Dictionary (123k entries, Apache-2.0, from tiny-tts)
 *        -> g2p_en neural grapheme-to-phoneme (GRU seq2seq, Apache-2.0) for
 *           anything the dictionary does not know
 *        -> ARPAbet (with 0/1/2 stress)
 *        -> the sano voice's IPA-flavoured character vocabulary + ids
 *
 * The vocabulary and id numbers are the model's input contract; they come from
 * the voice package (runtime/models/en_us_e13b/nano_q8_meta.h, NANO_VOCAB).
 *
 * No espeak, no misaki, no phonemizer: nothing here is derived from GPL code.
 * Loadable as a plain <script> (defines window.SanoMitG2p) or via require().
 */
var SanoMitG2p = (function () {
  'use strict';

  /* -------------------------------------------------- voice vocabulary -- */

  /* The 62-symbol table the heartnano voice was trained against. Symbols are
   * characters, and the model reads them one at a time, so a diphthong is one
   * symbol: "I" is aɪ, "A" is eɪ, "O" is oʊ, "W" is aʊ, "Y" is ɔɪ, "ʧ" is tʃ
   * and "ʤ" is dʒ. Punctuation and word spaces carry ids of their own. */
  var DEFAULT_VOCABULARY = {
    "<pad>": 0, "<bos>": 1, "<eos>": 2,
    " ": 3, "!": 4, '"': 5, "(": 6, ")": 7, ",": 8, ".": 9, ":": 10, ";": 11,
    "?": 12, "A": 13, "I": 14, "O": 15, "T": 16, "W": 17, "Y": 18, "b": 19,
    "d": 20, "f": 21, "h": 22, "i": 23, "j": 24, "k": 25, "l": 26, "m": 27,
    "n": 28, "p": 29, "s": 30, "t": 31, "u": 32, "v": 33, "w": 34, "z": 35,
    "æ": 36, "ð": 37, "ŋ": 38, "ɐ": 39, "ɑ": 40,
    "ɔ": 41, "ə": 42, "ɛ": 43, "ɜ": 44, "ɡ": 45,
    "ɪ": 46, "ɹ": 47, "ʃ": 48, "ʊ": 49, "ʌ": 50,
    "ʒ": 51, "ʤ": 52, "ʧ": 53, "ˈ": 54, "ˌ": 55,
    "θ": 56, "ᵊ": 57, "ᵻ": 58, "—": 59, "“": 60,
    "”": 61
  };
  var SPECIAL = { "<pad>": 0, "<bos>": 1, "<eos>": 2 };
  var DEFAULT_MAX_TOKENS = 207;

  function FrontendError(kind, message) {
    var e = new Error(message);
    e.name = "SanoMitG2pError";
    e.kind = kind;
    return e;
  }

  /* Function words: the voice learned to hear them without a stress mark —
   * espeak calls them structural words and leaves ˈ off unless they are
   * emphasised. Not a translation table, a property of this word class, so
   * adding a word here is a lexical decision, not a rule change. */
  var STRUCTURAL = {};
  [
    "a", "an", "and", "are", "as", "at", "am", "be", "been", "being", "but",
    "by", "can", "did", "do", "does", "for", "from", "had", "has", "have",
    "he", "her", "here", "him", "his", "i", "in", "is", "it", "its", "me",
    "might", "must", "my", "of", "on", "our", "ours", "shall", "she", "so",
    "than", "that", "the", "their", "them", "there", "they", "this", "those",
    "to", "us", "was", "we", "were", "which", "who", "will", "with", "would",
    "your", "yours",
    /* the same words with their clitics attached, because the word class does
     * not stop at the apostrophe */
    "it's", "that's", "there's", "what's", "he's", "she's", "i'm", "i've",
    "i'll", "i'd", "we're", "we've", "you're", "they're", "who's", "let's",
    "don't", "doesn't", "didn't", "isn't", "aren't", "wasn't", "weren't",
    "can't", "couldn't", "shouldn't", "wouldn't", "hasn't", "haven't", "hadn't"
  ].forEach(function (w) { STRUCTURAL[w] = true; });

  /* ---------------------------------------------------- ARPAbet -> IPA -- */

  /* One entry per ARPAbet phoneme as CMUdict and g2p_en emit them.
   *   ipa    what the voice expects, in the vocabulary above
   *   stress true for the syllabic nuclei, which is where ˈ and ˌ go
   *
   * Vowel choices follow the American reading the voice was trained on: AO is
   * the open "thought" vowel, the AH series splits by stress (stressed ʌ,
   * unstressed schwa), ER is written as ɜ + ɹ because the vocabulary has no
   * rhotic schwa, and the diphthongs collapse to the single symbols the
   * training vocabulary defines. */
  var ARPA = {
    B: { ipa: "b" }, CH: { ipa: "ʧ" }, D: { ipa: "d" }, DH: { ipa: "ð" },
    F: { ipa: "f" }, G: { ipa: "ɡ" }, HH: { ipa: "h" }, JH: { ipa: "ʤ" },
    K: { ipa: "k" }, L: { ipa: "l" }, M: { ipa: "m" }, N: { ipa: "n" },
    NG: { ipa: "ŋ" }, P: { ipa: "p" }, R: { ipa: "ɹ" }, S: { ipa: "s" },
    SH: { ipa: "ʃ" }, T: { ipa: "t", flap: "T" }, TH: { ipa: "θ" },
    V: { ipa: "v" }, W: { ipa: "w" }, Y: { ipa: "j" }, Z: { ipa: "z" },
    ZH: { ipa: "ʒ" },
    AA: { ipa: "ɑ", stress: true }, AE: { ipa: "æ", stress: true },
    AH: { ipa: "ə", stressed: "ʌ", stress: true },
    AO: { ipa: "ɔ", stress: true },
    AW: { ipa: "W", stress: true }, AY: { ipa: "I", stress: true },
    EH: { ipa: "ɛ", stress: true },
    ER: { ipa: "ɜɹ", reduced: "əɹ", stress: true },
    EY: { ipa: "A", stress: true },
    IH: { ipa: "ɪ", stress: true }, IY: { ipa: "i", stress: true },
    OW: { ipa: "O", stress: true }, OY: { ipa: "Y", stress: true },
    UH: { ipa: "ʊ", stress: true },
    UW: { ipa: "u", stress: true }
  };

  /* Punctuation the voice has an id for. Marks outside this set (quotes it has
   * no symbol for, brackets it would have to invent) are dropped and reported.
   * A hyphen or apostrophe inside a word is not punctuation to a dictionary, so
   * "don't" is DON + T and "fourteen-f" is two words. */
  var PUNCT = {
    ",": ",", ".": ".", "!": "!", "?": "?", ":": ":", ";": ";",
    "—": "—", "–": "—", "…": ".", "“": "“", "”": "”", '"': '"',
    "(": "(", ")": ")", "-": "", "'": "", "’": ""
  };

  /* Written short, read long. Only abbreviations CMUdict has no entry for. */
  var LETTER_WORDS = {
    Mr: "MISTER", Mrs: "MISSES", Ms: "MISS", Dr: "DOCTOR",
    St: "SAINT", Jr: "JUNIOR", Sr: "SENIOR", Prof: "PROFESSOR",
    Capt: "CAPTAIN", Lt: "LIEUTENANT", Sgt: "SERGEANT", vs: "VERSUS",
    /* The zero in "oh nine" is this "o", and CMUdict reads it as the
     * interjection — unstressed, which is why it has to be said here first. */
    o: "OH"
  };

  /* ------------------------------------------------------- numbers ----- */

  var ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven",
    "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
    "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  var TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety"];

  function below1000(n) {
    if (n < 20) return ONES[n];
    if (n < 100) {
      var t = Math.floor(n / 10), u = n % 10;
      return TENS[t] + (u ? " " + ONES[u] : "");
    }
    /* "two hundred thirteen": the hundred says what it is even when nothing
     * follows it — there is no "two hundreds" and no "two hundred and". */
    var hundreds = Math.floor(n / 100), rest = n % 100;
    return ONES[hundreds] + " hundred" + (rest ? " " + below1000(rest) : "");
  }

  function below1000000(n) {
    if (n < 1000) return below1000(n);
    var thousands = Math.floor(n / 1000), rest = n % 1000;
    return below1000(thousands) + " thousand" + (rest ? " " + below1000(rest) : "");
  }

  function integerToWords(n) {
    if (n < 0) return "minus " + integerToWords(-n);
    var scales = [[1e9, "billion"], [1e6, "million"]];
    for (var i = 0; i < scales.length; i++) {
      var v = scales[i][0];
      if (n >= v) {
        var head = Math.floor(n / v) * v;
        var rest = n - head;
        return integerToWords(Math.floor(n / v)) + " " + scales[i][1] +
          (rest ? " " + integerToWords(rest) : "");
      }
    }
    return below1000000(n);
  }

  /* A number written with a leading zero is read digit by digit with "oh" for
   * the zero — 09:05, 007, 04:11 — which is how the voice heard them in
   * training. 07:00 is "oh seven hundred", not "seven o'clock". */
  function spokenNumber(n, leadingZero) {
    if (leadingZero && n === 0) return "zero";
    if (leadingZero && n < 10) return "oh " + ONES[n];
    if (n >= 2000 && n <= 2039) {           /* years: twenty oh six */
      var head = Math.floor(n / 100), tail = n % 100;
      return integerToWords(head) + (tail === 0 ? " hundred" : " " + spokenNumber(tail, tail < 10));
    }
    return integerToWords(n);
  }

  /* "42" -> "forty two", "1013" -> "one thousand thirteen", "1066" -> "ten
   * hundred sixty six", "09" -> "oh nine", "3.14" -> "three point one four". */
  function numberToWords(token) {
    var cleaned = String(token).replace(/,/g, "");
    var ordinal = /^(\d+)(?:st|nd|rd|th)$/i.exec(cleaned);
    if (ordinal) return ordinalize(integerToWords(parseInt(ordinal[1], 10)));
    var point = /^(\d+)\.([0-9]*)$/.exec(cleaned);
    if (point) {
      /* one digit at a time after the point, which is how a decimal is heard:
       * "3.14" is "three point one four", never "three point fourteen" */
      return numberToWords(point[1]) +
        (point[2] ? " point " + digitWords(point[2]) : "");
    }
    if (cleaned === "0") return "zero";
    /* A long number written with a leading zero was not written to be counted:
     * "01637 200 200" is a telephone number, and as a value it is "one thousand
     * six hundred thirty seven" with the zero gone and the number undiallable.
     * Four digits stay as they were — "0700" is military for seven hundred —
     * because that is a time this engine is asked to say far more often. */
    if (/^0\d{4,}$/.test(cleaned)) return digitWords(cleaned).replace(/\bzero\b/g, "oh");
    if (/^0\d/.test(cleaned)) return spokenNumber(parseInt(cleaned, 10), true);
    if (cleaned.length > 12 || !/^\d+$/.test(cleaned)) return digitWords(cleaned);
    return spokenNumber(parseInt(cleaned, 10), false);
  }

  function digitWords(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var d = s[i];
      out.push(/\d/.test(d) ? ONES[parseInt(d, 10)] : d);
    }
    return out.join(" ");
  }

  /* ------------------------------------------- symbols that are words -- */

  /* "%", "&" and "£" are words wearing punctuation, and what they are said as
   * lives in the shape around them — "%" belongs to the number in front of it,
   * "#" to the digits after — so they are spoken here, before tokenising, while
   * the shape is still there to read. Anything that reaches the tokeniser is
   * punctuation: an id the voice has, or a warning. Never silence, which is how
   * "90%" used to lose its percent. Expanded words come out lowercase: the
   * dictionary is read case-insensitively, and capitals get heard as a KX-9. */

  /* Currency sign -> the unit it is said as, singular and plural. The unit
   * follows the amount: "$3.50" is "three dollars fifty". */
  var SIGNS = {
    "$": ["dollar", "dollars"],
    "£": ["pound", "pounds"],
    "€": ["euro", "euros"],
    "¥": ["yen", "yen"],
    "¢": ["cent", "cents"]
  };

  /* Letters that are a unit rather than an initialism when a number sits in
   * front of them — left alone they are letter names, and "5kg" is "five kay
   * gee". Two letters only: after a digit, a single letter is as likely part of
   * a designation (12 V, 24V, 5A), and a letter name is the honest reading of
   * one. */
  var UNIT_WORDS = {
    kg: "kilograms", km: "kilometers", cm: "centimeters", mm: "millimeters",
    kmh: "kilometers per hour", kph: "kilometers per hour", mph: "miles per hour",
    ml: "milliliters", kl: "kilo liters", kw: "kilowatts", mw: "megawatts",
    gw: "giga watts", kj: "kilo joules", cal: "calories",
    hz: "hertz", khz: "kilo hertz", mhz: "megahertz", ghz: "giga hertz",
    tb: "tera bytes", gb: "gigabytes", mb: "megabytes", kb: "kilobytes",
    db: "decibels", psi: "psi", ft: "feet", lb: "pounds", oz: "ounces"
  };

  var IRREGULAR_SINGULARS = { feet: "foot" };

  /* The unit a number is said with: one takes the singular, and only the first
   * word of a unit carries the count — "one mile per hour". The plurals here
   * are the dictionary's own; CMUdict has "miles" but no "euros", and a plural
   * it lacks is finished by the reading rules (see pluralReading). */
  function unitWords(unit, amount) {
    if (!isOne(amount)) return UNIT_WORDS[unit];
    var parts = UNIT_WORDS[unit].split(" ");
    parts[0] = IRREGULAR_SINGULARS[parts[0]] || parts[0].replace(/s$/, "");
    return parts.join(" ");
  }

  /* A number is one when its last group says so — "1,001" is, "1,200" is not. */
  function isOne(digits) {
    var last = String(digits).replace(/,/g, "").split(/\s+/).pop();
    return /^0*1$/.test(last || "");
  }

  /* Everything else that stands for a word, in the order the shapes have to be
   * tried in: the patterns that own their own digits first, then the marks that
   * sit on a number, then the rest. ± before +, and the degree scale before the
   * bare degree sign. */
  var SYMBOL_READINGS = [
    /* Money either side of the amount — "$1.50" and "50¢" are one shape — and
     * the two digits after the point are only cents when there is a whole
     * amount in front of them, which is why "1.5 km" keeps its decimal. */
    [/([$£€¥¢])\s*(\d+(?:,\d{3})*)(?:[.,](\d{1,2}))?/g, function (_m, sign, amount, frac) {
      return moneySpoken(sign, amount, frac);
    }],
    [/(\d+(?:,\d{3})*)(?:[.,](\d{1,2}))?\s*([$£€¥¢])/g, function (_m, amount, frac, sign) {
      return moneySpoken(sign, amount, frac);
    }],
    [/(\b|:)(\d{1,2}):(\d{2})\b/g, function (_m, pre, hh, mm) {
      var hour = spokenNumber(parseInt(hh, 10), hh.charAt(0) === "0");
      var minutes = parseInt(mm, 10);
      /* ":00" is a whole hour, and the reference front end calls it hundred */
      return pre + " " + hour + " " +
        (minutes === 0 ? "hundred" : spokenNumber(minutes, mm.charAt(0) === "0")) + " ";
    }],
    [/°\s*([CF])\b/gi, function (_m, scale) {
      return " degrees " + (scale.toUpperCase() === "C" ? "celsius" : "fahrenheit") + " ";
    }],
    [/°/g, " degrees "],
    [/(.?)\b(\d+)\s?([A-Za-z]{2,5})\b/g, function (match, before, amount, unit) {
      /* the whole number, not its last digit, and not the tail of a decimal:
       * "25kg" is kilograms, "1.5 l" is litres after its point, not cents */
      var spoken = /[.,\d]/.test(before) ? undefined : UNIT_WORDS[unit.toLowerCase()];
      if (!spoken) return match;
      return " " + amount + " " + unitWords(unit.toLowerCase(), amount) + " ";
    }],
    [/%/g, " percent "],
    [/#/g, " number "],
    [/&/g, " and "],
    [/@/g, " at "],
    [/±/g, " plus or minus "],
    [/×|∗|✕/g, " times "],
    [/÷/g, " divided by "],
    [/=/g, " equals "],
    [/−/g, " minus "],
    [/\+/g, " plus "],
    [/\//g, " slash "]
  ];

  function moneySpoken(sign, amount, frac) {
    var unit = SIGNS[sign];
    return " " + numberToWords(amount) + " " + unit[isOne(amount) ? 0 : 1] +
      centsToWords(frac) + " ";
  }

  /* "50" is fifty, "05" is oh five, and "00" says nothing because the whole
   * amount already said it all. */
  function centsToWords(frac) {
    if (!frac) return "";
    var value = parseInt(frac, 10);
    if (value === 0) return "";
    return " " + (value < 10 ? "oh " + integerToWords(value) : integerToWords(value));
  }

  function expandSymbols(text) {
    var out = text;
    for (var i = 0; i < SYMBOL_READINGS.length; i++) {
      out = out.replace(SYMBOL_READINGS[i][0], SYMBOL_READINGS[i][1]);
    }
    return out;
  }

  var ORDINALS = {
    one: "first", two: "second", three: "third", five: "fifth",
    eight: "eighth", nine: "ninth", twelve: "twelfth"
  };
  function ordinalize(words) {
    var parts = words.split(" ");
    var last = parts[parts.length - 1];
    if (ORDINALS[last]) {
      parts[parts.length - 1] = ORDINALS[last];
    } else if (/y$/.test(last)) {
      parts[parts.length - 1] = last.slice(0, -1) + "ieth";
    } else {
      parts[parts.length - 1] = last + "th";
    }
    return parts.join(" ");
  }

  /* ------------------------------------------- g2p_en neural predictor -- */

  /* GRU encoder-decoder over characters, greedy decode. The maths is the
   * upstream g2p_en predict() as shipped in tiny-tts's npm package
   * (Apache-2.0); restructured here to take a model object instead of reading
   * a file, so one module serves node and the browser. */
  var WEIGHT_KEYS = ["enc_emb", "enc_w_ih", "enc_w_hh", "enc_b_ih", "enc_b_hh",
    "dec_emb", "dec_w_ih", "dec_w_hh", "dec_b_ih", "dec_b_hh", "fc_w", "fc_b"];
  var MAX_STEPS = 20, START_IDX = 2, END_IDX = 3;

  function b64ToFloat32(b64) {
    var bytes;
    if (typeof atob === "function") {
      var bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      var pooled = Buffer.from(b64, "base64");
      bytes = new Uint8Array(pooled.length);
      bytes.set(pooled);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }

  function rowsOf(flat, count, width) {
    var out = [];
    for (var r = 0; r < count; r++) out.push(flat.subarray(r * width, (r + 1) * width));
    return out;
  }

  /* raw = parsed g2p_model.json */
  function loadNeuralModel(raw) {
    var m = {};
    for (var k = 0; k < WEIGHT_KEYS.length; k++) {
      var tensor = raw[WEIGHT_KEYS[k]];
      if (!tensor) throw FrontendError("model", "g2p model is missing " + WEIGHT_KEYS[k]);
      var flat = b64ToFloat32(tensor.data);
      m[WEIGHT_KEYS[k]] = (tensor.shape && tensor.shape.length === 2)
        ? rowsOf(flat, tensor.shape[0], tensor.shape[1]) : flat;
      m[WEIGHT_KEYS[k] + "_shape"] = tensor.shape;
    }
    m.g2idx = {};
    for (var g = 0; g < raw.graphemes.length; g++) m.g2idx[raw.graphemes[g]] = g;
    m.idx2p = {};
    for (var p = 0; p < raw.phonemes.length; p++) m.idx2p[p] = raw.phonemes[p];
    m.hidden = m.enc_w_hh_shape[1];
    return m;
  }

  function gruStep(x, h, wIh, wHh, bIh, bHh, dim) {
    var three = dim * 3, two = dim * 2, i, j, sum;
    var fromX = new Float32Array(three), fromH = new Float32Array(three);
    for (i = 0; i < three; i++) {
      sum = bIh[i];
      for (j = 0; j < x.length; j++) sum += x[j] * wIh[i][j];
      fromX[i] = sum;
    }
    for (i = 0; i < three; i++) {
      sum = bHh[i];
      for (j = 0; j < h.length; j++) sum += h[j] * wHh[i][j];
      fromH[i] = sum;
    }
    var next = new Float32Array(dim);
    for (i = 0; i < dim; i++) {
      var r = 1 / (1 + Math.exp(-(fromX[i] + fromH[i])));
      var z = 1 / (1 + Math.exp(-(fromX[dim + i] + fromH[dim + i])));
      var n = Math.tanh(fromX[two + i] + r * fromH[two + i]);
      next[i] = (1 - z) * n + z * h[i];
    }
    return next;
  }

  /* word (lowercase, no punctuation) -> ["K","EH1","S","L","ER0"] */
  function neuralPredict(m, word) {
    var dim = m.hidden;
    var chars = word.split("").concat(["</s>"]);
    var h = new Float32Array(dim);
    for (var t = 0; t < chars.length; t++) {
      var idx = m.g2idx[chars[t]] !== undefined ? m.g2idx[chars[t]] : m.g2idx["<unk>"];
      h = gruStep(m.enc_emb[idx], h, m.enc_w_ih, m.enc_w_hh, m.enc_b_ih, m.enc_b_hh, dim);
    }
    var dec = m.dec_emb[START_IDX], out = [];
    for (var step = 0; step < MAX_STEPS; step++) {
      h = gruStep(dec, h, m.dec_w_ih, m.dec_w_hh, m.dec_b_ih, m.dec_b_hh, dim);
      var best = -Infinity, bestIdx = 0;
      for (var f = 0; f < m.fc_w.length; f++) {
        var logit = m.fc_b[f];
        for (var q = 0; q < dim; q++) logit += h[q] * m.fc_w[f][q];
        if (logit > best) { best = logit; bestIdx = f; }
      }
      if (bestIdx === END_IDX) break;
      out.push(m.idx2p[bestIdx] || "<unk>");
      dec = m.dec_emb[bestIdx];
    }
    return out;
  }

  /* ------------------------------------------------------- dictionary -- */

  /* CMUdict keys are uppercase and homophones are tagged: "LEAD(1)", "LEAD(2)".
   * The untagged form is the first reading, which is what we want. */
  function lookupCmu(dict, wordUpper) {
    if (!dict) return null;
    var hit = dict[wordUpper];
    if (hit) return hit;
    return dict[wordUpper + "(1)"] || null;
  }

  /* --------------------------------------------------------- tokenizer -- */

  /* Split into {kind:'word'|'number'|'punct'|'space', text}. Every character
   * of the input lands in exactly one token, so nothing vanishes. */
  function tokenize(text) {
    var tokens = [], i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (/\s/.test(ch)) {
        var ws = i;
        while (i < text.length && /\s/.test(text[i])) i++;
        tokens.push({ kind: "space", text: text.slice(ws, i) });
      } else if (/[A-Za-z]/.test(ch)) {
        if (/^[A-Za-z]\.(?:[A-Za-z]\.?){1,}/.test(text.slice(i))) {
          var run = /^[A-Za-z]\.(?:[A-Za-z]\.?){1,}/.exec(text.slice(i))[0];
          tokens.push({ kind: "initialism", text: run });
          i += run.length;
          continue;
        }
        var w = i;
        while (i < text.length && /[A-Za-z'’]/.test(text[i])) i++;
        tokens.push({ kind: "word", text: text.slice(w, i) });
      } else if (/[0-9]/.test(ch)) {
        /* digits, then thousands separators and decimals only between digits,
         * then an ordinal tail — "1,024th"; a sentence-full stop is not part of
         * the number. A bare letter may hang off the end ("deck 3a") and is read
         * as a letter, because the dictionary's "a" is the article, not a name. */
        var num = /^([0-9]+(?:[.,][0-9]+)*(?:st|nd|rd|th)?)([A-Za-z](?![A-Za-z]))?/
          .exec(text.slice(i));
        tokens.push({ kind: "number", text: num[1], suffix: num[2] });
        i += num[0].length;
      } else {
        tokens.push({ kind: "punct", text: ch });
        i++;
      }
    }
    return tokens;
  }

  function dictionaryLookup(dict, word) {
    var hit = lookupCmu(dict, word.toUpperCase());
    return hit ? { phones: hit, source: "dict" } : null;
  }

  /* ------------------------------------------------------ ARPAbet -> IPA -- */

  /* A word's ARPAbet becomes a string in the voice's alphabet. ˈ lands on the
   * first primary-stressed nucleus and ˌ on the first secondary, immediately
   * before the vowel — that is where the voice learned to see them. A
   * structural word ("the", "of", "is") arrives with opts.unstressed and
   * carries no mark at all, which is also how the reference sounds. */

  /* The American flap: a T between a stressed vowel and a weaker one, and
   * only there. Blocked after another consonant — "thirty" and "winter" keep
   * their t — and after a vowel that is not the stressed one, which is what
   * keeps "Italian" at t. test/cases/g2p.json pins the words this rule was
   * settled on. */
  function flapped(phones, k) {
    if (phones[k].charAt(0) !== "T") return false;
    var before = null;
    for (var i = k - 1; i >= 0; i--) {
      var p = phones[i].replace(/[0-2]$/, "");
      if (ARPA[p] && ARPA[p].stress) { before = { index: i, digit: phones[i].slice(-1) }; break; }
      var e = ARPA[p];
      if (e && p !== "Y" && p !== "W") return false;      /* preceded by a consonant */
    }
    if (!before || before.digit !== "1") return false;    /* must follow the stressed vowel */
    var after = phones[k + 1] ? phones[k + 1].replace(/[0-2]$/, "") : null;
    var ae = after ? ARPA[after] : null;
    if (!ae || !ae.stress) return false;                  /* must lead into a vowel */
    var afterDigit = phones[k + 1].slice(-1);
    return afterDigit !== "1";                            /* ... a weaker one */
  }
  function arpabetToWord(phones, opts) {
    opts = opts || {};
    var nuclei = [];
    for (var i = 0; i < phones.length; i++) {
      var base = phones[i].replace(/[0-2]$/, "");
      var entry = ARPA[base];
      if (entry && entry.stress) nuclei.push(i);
    }
    if (!nuclei.length) return null;

    var primaryIdx = null, secondaryIdx = null;
    for (var n = 0; n < nuclei.length; n++) {
      var digit = phones[nuclei[n]].slice(-1);
      if (digit === "1" && primaryIdx === null) primaryIdx = nuclei[n];
      if (digit === "2" && secondaryIdx === null) secondaryIdx = nuclei[n];
    }

    var stressMark = {};
    if (primaryIdx !== null) stressMark[primaryIdx] = "ˈ";
    if (secondaryIdx !== null && !stressMark[secondaryIdx]) stressMark[secondaryIdx] = "ˌ";
    if (opts.unstressed) stressMark = {};         /* structural word in running speech */

    var out = "";
    var swallowNext = false;
    for (var k = 0; k < phones.length; k++) {
      if (swallowNext) { swallowNext = false; continue; }
      var raw = phones[k];
      var b = raw.replace(/[0-2]$/, "");
      var digit = raw.slice(-1);
      var e = ARPA[b];
      if (!e) continue;                       /* <unk> and friends */

      /* An unstressed AH before a liquid or nasal is the vowel the consonant
       * swallows, but only in the coda: "bottle" is b-o-T with a syllabic l,
       * while "hello" keeps its schwa because that l goes on to open the next
       * syllable. Before n the vowel is only gone after a flapped t — "sudden"
       * keeps it, and so does "open". m never swallows: "atom" and "rhythm"
       * keep their schwa. */
      if (b === "AH" && digit === "0" && k + 2 >= phones.length && k + 1 < phones.length) {
        var next = phones[k + 1].replace(/[0-2]$/, "");
        if (next === "L") { out += "ᵊl"; swallowNext = true; continue; }
        if (next === "N" && phones[k - 1] === "T") continue;   /* the n follows alone */
      }

      if (stressMark[k]) out += stressMark[k];
      var ipa = e.ipa;
      if (e.stressed && digit === "1") ipa = e.stressed;
      if (e.reduced && digit === "0") ipa = e.reduced;
      if (e.flap && flapped(phones, k)) ipa = e.flap;
      out += ipa;
    }
    return out;
  }

  /* Name of a letter, as it is said. CMUdict stores most of them but stores
   * "A" and "I" as the words they are also, so the names live here. */
  var LETTER_NAMES = {
    A: "EY1", B: "B IY1", C: "S IY1", D: "D IY1", E: "IY1", F: "EH1 F",
    G: "JH IY1", H: "EY1 CH", I: "AY1", J: "JH EY1", K: "K EY1", L: "EH1 L",
    M: "EH1 M", N: "EH1 N", O: "OW1", P: "P IY1", Q: "K Y UW1", R: "AA1 R",
    S: "EH1 S", T: "T IY1", U: "Y UW1", V: "V IY1", W: "D AH1 B AH0 L Y UW0",
    X: "EH1 K S", Y: "W AY1", Z: "Z IY1", "0": "Z IY1 R OW0"
  };

  /* A short run of capitals that no dictionary knows is read as letters: KX-9,
   * LMN, TX-4. A lowercase unknown is a new word, and a new word gets the
   * neural model. */
  function spelledOut(token) {
    var letters = token.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!letters || letters.length > 6 || letters.length < 2) return null;
    if (!/^[A-Z][A-Z0-9]*$/.test(token.replace(/[^A-Za-z0-9]/g, ""))) return null;
    var phones = [];
    for (var i = 0; i < letters.length; i++) {
      var name = LETTER_NAMES[letters[i]];
      if (!name) return null;
      phones = phones.concat(name.split(" "));
    }
    return phones;
  }

  /* What an apostrophe stands for when the dictionary has no entry for the
   * contraction: a clitic sound, not a letter. "kessler's" is a name plus /z/,
   * and reading the possessive as the letter "ess" is how machines say
   * "kessler-ess". */
  var CLITICS = { S: "Z", T: "T", D: "D", LL: "L", RE: "R", VE: "V", M: "M" };

  function splitApostrophe(dict, word) {
    if (!/[’']/.test(word)) return null;
    var parts = word.toUpperCase().split(/[’']/).filter(function (p) { return p.length; });
    if (parts.length !== 2) return null;
    var head = lookupCmu(dict, parts[0]);
    if (!head) return null;
    if (CLITICS[parts[1]]) {
      return { phones: head.concat(CLITICS[parts[1]].split(" ")), source: "clitic" };
    }
    var tail = lookupCmu(dict, parts[1]);
    return tail ? { phones: head.concat(tail), source: "dict-split" } : null;
  }

  /* A plural the dictionary does not list is the stem plus its own plural
   * ending, and the ending takes the voice of the phone it lands on: "cubits"
   * is "-bits", "loins" is "-loinz", "laws" is "-lawz". CMUdict knows "EURO"
   * and not "EUROS"; letting the neural model invent a plural this plain is how
   * "euros" arrives as "you-roh-ess". */
  var VOICED_TAIL = { B: 1, D: 1, G: 1, V: 1, Z: 1, ZH: 1, JH: 1, N: 1, M: 1,
    NG: 1, L: 1, R: 1, W: 1, Y: 1, HH: 1 };
  var VOWELS = { AA: 1, AE: 1, AH: 1, AO: 1, AW: 1, AY: 1, EH: 1, ER: 1, EY: 1,
    IH: 1, IX: 1, OW: 1, OY: 1, UH: 1, UW: 1, UX: 1 };
  var SIBILANT = { S: 1, Z: 1, SH: 1, ZH: 1, CH: 1, JH: 1 };

  function pluralEnding(stem) {
    var last = stem[stem.length - 1].replace(/[0-2]$/, "");
    if (SIBILANT[last]) return ["IH0", "Z"];
    return (VOICED_TAIL[last] || VOWELS[last]) ? ["Z"] : ["S"];
  }

  function pluralReading(dict, word) {
    if (!/s$/i.test(word)) return null;
    var stem = lookupCmu(dict, word.slice(0, -1).toUpperCase());
    if (!stem || !stem.length) return null;
    return { phones: stem.concat(pluralEnding(stem)), source: "plural" };
  }

  /* Stem + suffix, for the derived words the dictionary missed. CMUdict carries
   * "holiness" and "righteousness" but neither "nakedness" nor "bareness", and
   * the neural model answers those with the wrong stem vowel and a voiced final
   * S ("nack-dun-diz"). Measured over the whole dictionary these suffixes are
   * appended to the stem's own phones 88-95% of the time (273/309 for -ness,
   * 157/165 for -less, 100/106 for -ful), so when the stem is known and the
   * whole word is not, that rule beats a guess. The inflections are the ones
   * the Bible needs most: "maketh" and "knowest" are the verbs CMUdict knows
   * with an archaic ending on them, and the model hears "MAK-ith" and
   * "MAK-est" instead. */
  var DERIVED = [
    ["ments", "M AH0 N T S"], ["ness", "N AH0 S"], ["less", "L AH0 S"],
    ["ment", "M AH0 N T"], ["ship", "SH IH2 P"], ["hood", "HH UH2 D"],
    ["like", "L AY2 K"], ["ful", "F AH0 L"],
    ["eth", "AH0 TH"], ["est", "AH0 S T"], ["ed", "D"]
  ];

  /* The self-compounds, which the model reads with an S where the th is:
   * "thyself" came out "tiss-elf". */
  var SELF_WORDS = {
    MYSELF: "M AY0 S EH1 L F", OURSELVES: "AW0 ER0 S EH1 L V Z",
    YOURSELVES: "Y AO0 ER0 S EH1 L V Z", THEMSELVES: "DH EH0 M S EH1 L V Z"
  };

  function derivedReading(dict, word) {
    var upper = word.toUpperCase();
    if (SELF_WORDS[upper]) return { phones: SELF_WORDS[upper].split(" "), source: "self" };
    var lower = word.toLowerCase();
    if (/self$/.test(lower)) {
      var head = lookupCmu(dict, lower.slice(0, -4).toUpperCase());
      if (head) return { phones: head.concat(["S", "EH1", "L", "F"]), source: "stem+self" };
    }
    for (var i = 0; i < DERIVED.length; i++) {
      var suffix = DERIVED[i][0];
      if (lower.length <= suffix.length + 1 || !lower.endsWith(suffix)) continue;
      var stem = lookupCmu(dict, lower.slice(0, -suffix.length).toUpperCase());
      if (stem) return { phones: stem.concat(DERIVED[i][1].split(" ")), source: "stem+" + suffix };
    }
    return null;
  }

  /* --------------------------------------------------------- frontend -- */

  function createFrontend(options) {
    options = options || {};
    var vocabulary = options.vocabulary || DEFAULT_VOCABULARY;
    var maxTokens = options.maxTokens == null ? DEFAULT_MAX_TOKENS : options.maxTokens;
    var dict = options.cmudict || null;
    var neuralModel = options.neural || null;      /* from loadNeuralModel() */
    /* Readings the dictionary lacks, as { WORD: "ARP ABET" }: a patch, not a
     * fork. It is consulted after the dictionary and before the neural model,
     * so it fills holes without changing anything CMUdict already answers. */
    var patch = options.readings || null;
    var warnings = [];

    function patchReading(word) {
      if (!patch) return null;
      var hit = patch[word.toUpperCase()];
      if (!hit) return null;
      var phones = String(hit).toUpperCase().split(/[\s,]+/).filter(Boolean);
      return phones.length ? { phones: phones, source: "patch" } : null;
    }

    function warn(msg) { warnings.push(msg); }

    /* Written-short read-long: "Dr." in CMUdict is the street you drive down, so
     * the abbreviations in LETTER_WORDS have to be settled before the
     * dictionary gets a chance. */
    function abbrevReading(word) {
      var asWord = LETTER_WORDS[word] ||
        LETTER_WORDS[word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()];
      if (!asWord) return null;
      var phones = [];
      var pieces = asWord.split(" ");
      for (var i = 0; i < pieces.length; i++) {
        var p = lookupCmu(dict, pieces[i].toUpperCase());
        if (!p) return null;
        phones = phones.concat(p);
      }
      return { phones: phones, source: "abbreviation" };
    }

    /* One word -> { ipa, source, arpabet }, the reading it chose included,
     * because "why does it say that" is the first question anyone asks. */
    function wordToPhonemes(word) {
      var cleaned = word.replace(/[’']/g, "").toLowerCase();
      if (!cleaned) return null;
      /* looked up both ways: "don't" is on the list, and so is the stem of a
       * name that has a clitic hanging off it */
      var lower = word.toLowerCase().replace(/’/g, "'");
      var unstressed = !!STRUCTURAL[lower] || !!STRUCTURAL[cleaned];

      /* Dictionary first: it is the biggest and the most trusted thing here.
       * Then the shapes the dictionary cannot know — an abbreviation, a callsign
       * spelled in capitals — then the neural model for genuinely new words,
       * and finally the alphabet so that an unknown name is still not silence. */
      var found = abbrevReading(word) || dictionaryLookup(dict, word) || patchReading(word) ||
        splitApostrophe(dict, word) || pluralReading(dict, word) || derivedReading(dict, word);
      if (!found && /^[A-Z][A-Z0-9]{1,5}$/.test(word)) {
        var letters = spelledOut(word);
        if (letters) found = { phones: letters, source: "letters" };
      }
      if (!found && neuralModel) {
        var predicted = neuralPredict(neuralModel, cleaned);
        if (predicted && predicted.length) found = { phones: predicted, source: "neural" };
      }
      if (!found) {
        var fallback = spelledOut(word) || [];
        if (!fallback.length) {
          warn('no reading for "' + word + '" — the dictionary does not know it ' +
            'and there is no neural model to guess with');
          return null;
        }
        warn('spelled out "' + word + '" (no dictionary or neural reading)');
        found = { phones: fallback, source: "letters" };
      }

      var ipa = arpabetToWord(found.phones, { unstressed: unstressed });
      if (!ipa) { warn('no vowels in reading of "' + word + '"'); return null; }
      return { ipa: ipa, source: found.source, arpabet: found.phones };
    }

    /* A run of letters, each said as a letter. */
    function letterNames(run) {
      var out = [];
      var letters = run.replace(/[^A-Za-z]/g, "").toUpperCase().split("");
      for (var i = 0; i < letters.length; i++) {
        var name = LETTER_NAMES[letters[i]];
        if (!name) { warn('dropped "' + letters[i] + '": no letter name'); continue; }
        var named = arpabetToWord(name.split(" "), { unstressed: true });
        if (named) out.push(named);
      }
      return out;
    }

    /* text -> the phoneme string in the voice's alphabet */
    function phonemize(text) {
      if (typeof text !== "string") throw FrontendError("type", "text must be a string");
      warnings = [];
      var tokens = tokenize(expandSymbols(text));
      /* One atom per word; a punctuation mark hangs off the atom before it, so
       * words end up space separated and "," never does. */
      var atoms = [];
      var pushAtom = function (ipa) {
        if (ipa) atoms.push(ipa);
      };
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t.kind === "space") continue;
        if (t.kind === "initialism") {
          /* "a.m." is two letter names, not the article "a" plus "m". */
          var named = letterNames(t.text);
          for (var c = 0; c < named.length; c++) pushAtom(named[c]);
          continue;
        }
        if (t.kind === "punct") {
          if (!Object.prototype.hasOwnProperty.call(PUNCT, t.text)) {
            warn('dropped "' + t.text + '": no symbol in the vocabulary');
            continue;
          }
          var mark = PUNCT[t.text];
          if (!mark) continue;
          if (atoms.length) atoms[atoms.length - 1] += mark;
          else atoms.push(mark);
          continue;
        }
        if (t.kind === "number") {
          var spoken = numberToWords(t.text).split(/\s+/);
          for (var w = 0; w < spoken.length; w++) {
            var numWord = wordToPhonemes(spoken[w]);
            if (numWord) pushAtom(numWord.ipa);
          }
          if (t.suffix) {
            var suffixed = letterNames(t.suffix);
            for (var s = 0; s < suffixed.length; s++) pushAtom(suffixed[s]);
          }
          continue;
        }
        var word = wordToPhonemes(t.text);
        if (word) pushAtom(word.ipa);
      }
      return atoms.join(" ");
    }

    function phonemesToIds(phonemes, cap) {
      var ids = [SPECIAL["<bos>"]], dropped = "";
      for (var i = 0; i < phonemes.length; i++) {
        var ch = phonemes[i];
        if (Object.prototype.hasOwnProperty.call(vocabulary, ch) &&
            !Object.prototype.hasOwnProperty.call(SPECIAL, ch)) {
          ids.push(vocabulary[ch]);
        } else if (!Object.prototype.hasOwnProperty.call(vocabulary, ch)) {
          dropped += ch;
        }
      }
      ids.push(SPECIAL["<eos>"]);
      if (ids.length === 2) throw FrontendError("empty", "text produced no phonemes");
      var limit = cap == null ? maxTokens : cap;
      if (ids.length > limit) {
        throw FrontendError("too_long", "phoneme sequence is " + ids.length +
          " tokens including BOS/EOS; the maximum is " + limit);
      }
      return { ids: ids, dropped: dropped };
    }

    function textToIds(text) {
      var phonemes = phonemize(text);
      var r = phonemesToIds(phonemes);
      return { phonemes: phonemes, ids: r.ids, dropped: r.dropped, warnings: warnings };
    }

    /* How many ids a piece of text costs, BOS/EOS included — the currency the
     * chunker packs against. Measuring is not refusing, so there is no cap
     * here, and a piece with no phonemes in it costs nothing instead of raising. */
    function costOf(text) {
      try {
        return phonemesToIds(phonemize(text), Infinity).ids.length;
      } catch (e) {
        return 0;
      }
    }

    /* Text longer than one model window is spoken in pieces, and the cut goes
     * where a listener hears one: end of sentence, then clause, then word, and
     * only for text with no words to give up (a URL, a code) between
     * characters. A piece that no cut can fit stays whole — the renderer
     * refuses it, which is a good deal louder than clipping it quiet. */
    function planChunks(text, budget) {
      var limit = budget > 0 ? budget : maxTokens;
      /* Text with nothing sayable in it has no pieces — silence included. */
      if (typeof text !== "string" || !costOf(text)) return [];
      return packPieces(text, limit);
    }

    function packPieces(piece, limit) {
      /* What fits, goes as it is — spaces and all: a piece of a text must not
       * lose the gap between two words on the way. */
      if (costOf(piece) <= limit) return [piece];
      for (var level = 0; level < 4; level++) {
        var parts = cutAt(piece, level);
        if (parts.length < 2) continue;
        return packRuns(parts, limit);
      }
      return [piece];
    }

    /* Greedy, and only as fine-grained as it has to be: the run in hand is
     * emitted at this level, and only the piece that will not fit goes on to be
     * cut finer. A sentence that fits is never chopped. */
    function packRuns(parts, limit) {
      var out = [], run = [];
      function emit(group) {
        var joined = group.join("");
        if (joined) out = out.concat(packPieces(joined, limit));
      }
      for (var i = 0; i < parts.length; i++) {
        if (run.length && costOf(run.concat(parts[i]).join("")) > limit) {
          emit(run);
          run = [];
        }
        run.push(parts[i]);
      }
      emit(run);
      return out;
    }

    /* Where a piece may be cut, in order of preference: sentence end, clause
     * end, word, and finally character — that last one only for text with no
     * words to give up, like a URL. Each part keeps what follows the cut, so
     * joining the parts back gives the piece, spaces and all. */
    var CUTS = [
      /[.!?…]+["'”)\]]*\s*/g,          /* end of sentence, marks and quotes kept */
      /[,;:—–]\s*/g,                    /* clause */
      /\s+/g,                           /* word */
      /(?=[\s\S])/g                     /* character: the last resort, for a URL */
    ];

    function cutAt(piece, level) {
      var re = new RegExp(CUTS[level].source, "g");   /* a private lastIndex */
      var parts = [], from = 0, m;
      while ((m = re.exec(piece)) !== null) {
        if (re.lastIndex === m.index) re.lastIndex++;   /* a zero-width match */
        var end = m.index + m[0].length;
        if (end > from) {
          parts.push(piece.slice(from, end));
          from = end;
        }
      }
      if (from < piece.length) parts.push(piece.slice(from));
      return parts;
    }

    return {
      phonemize: phonemize,
      textToIds: textToIds,
      wordToPhonemes: wordToPhonemes,
      tokenize: tokenize,
      numberToWords: numberToWords,
      planChunks: planChunks,
      costOf: costOf,
      vocabulary: vocabulary,
      maxTokens: maxTokens
    };
  }

  return {
    createFrontend: createFrontend,
    loadNeuralModel: loadNeuralModel,
    neuralPredict: neuralPredict,
    arpabetToWord: arpabetToWord,
    numberToWords: numberToWords,
    ARPA: ARPA,
    DEFAULT_VOCABULARY: DEFAULT_VOCABULARY,
    DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SanoMitG2p;
if (typeof window !== "undefined") window.SanoMitG2p = SanoMitG2p;
