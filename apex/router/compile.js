'use strict';
/**
 * compile.js: Build-time: compile lexicons.json -> lexicon.compiled.json.
 *
 * Usage:
 *   node router/compile.js [--src <lexicons.json>] [--out <lexicon.compiled.json>]
 *
 * Output format:
 *   {
 *     "_maxLen": <max phrase token length>,
 *     "map": {
 *       "<phrase tokens joined by ' '>": [
 *         { "feat": "lex:group:key", "polarity": "trigger"|"anti" },
 *         ...
 *       ]
 *     }
 *   }
 *
 * At runtime: tokenize the text once, slide a window of widths 1.._maxLen,
 * join the window tokens with ' ', look up in the map. No RegExp construction.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);

let srcPath = path.join(__dirname, 'lexicons.json');
let outPath = path.join(__dirname, 'lexicon.compiled.json');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--src' && args[i + 1]) srcPath = args[++i];
  else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
}

// ---------------------------------------------------------------------------
// Tokenizer (matches runtime tokenizer in features.js)
// ---------------------------------------------------------------------------
/**
 * Split a phrase into tokens, preserving trailing ":" on the final token.
 * "rm -rf"   -> ["rm", "rf"]
 * "step by step" -> ["step", "by", "step"]
 * "output:"  -> ["output:"]
 * "result:"  -> ["result:"]
 * "i don't know" -> ["i", "don", "t", "know"]
 */
function phraseTokens(phrase) {
  const s = phrase.toLowerCase();
  // If the phrase ends with ':', extract a trailing-colon token for the last word
  if (s.trimEnd().endsWith(':')) {
    const inner = s.slice(0, s.trimEnd().length - 1);
    const words = inner.match(/[a-z0-9]+/g) || [];
    if (words.length > 0) {
      words[words.length - 1] += ':';
    }
    return words;
  }
  return s.match(/[a-z0-9]+/g) || [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const lex = JSON.parse(fs.readFileSync(srcPath, 'utf8'));

  const mapObj = {}; // phraseKey -> [{feat, polarity}]
  let maxLen = 1;

  const groups = ['task_types', 'pools', 'tiers', 'flags', 'techniques'];
  for (const group of groups) {
    const section = lex[group];
    if (!section) continue;
    for (const [key, entry] of Object.entries(section)) {
      const featName = `lex:${group}:${key}`;

      for (const [polarity, phrases] of [['trigger', entry.triggers || []], ['anti', entry.anti || []]]) {
        for (const rawPhrase of phrases) {
          const tokens = phraseTokens(rawPhrase);
          if (tokens.length === 0) continue;
          const phraseKey = tokens.join(' ');
          if (tokens.length > maxLen) maxLen = tokens.length;

          if (!mapObj[phraseKey]) mapObj[phraseKey] = [];
          // Only push if not already there (dedupe)
          const existing = mapObj[phraseKey].find(e => e.feat === featName && e.polarity === polarity);
          if (!existing) {
            mapObj[phraseKey].push({ feat: featName, polarity });
          }
        }
      }
    }
  }

  const compiled = { _maxLen: maxLen, map: mapObj };
  fs.writeFileSync(outPath, JSON.stringify(compiled));
  console.log(`Compiled ${Object.keys(mapObj).length} phrases (maxLen=${maxLen}) -> ${outPath}`);
  console.log(`Size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
}

main();
