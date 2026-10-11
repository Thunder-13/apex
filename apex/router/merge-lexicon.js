'use strict';
/**
 * merge-lexicon.js: Merge a researched trigger-lexicon.json into lexicons.json.
 *
 * Usage:
 *   node router/merge-lexicon.js [--src <path>] [--out <path>]
 *
 * Source format (e.g. research/trigger-lexicon.json):
 *   { "T7": { "triggers": [...], "anti": [...], "basis": "..." }, ... }
 *
 * Merges into lexicons.json techniques section: union of phrases, lowercase, dedupe.
 * Also accepts pool/task/tier/flag keys if present.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const RESEARCH_DIR = path.join(ROOT, '..', 'research');

const args = process.argv.slice(2);
let srcPath = path.join(RESEARCH_DIR, 'trigger-lexicon.json');
let outPath = path.join(__dirname, 'lexicons.json');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--src' && args[i + 1]) srcPath = args[++i];
  else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalize(phrases) {
  return [...new Set(phrases.map(p => p.toLowerCase().trim()).filter(Boolean))];
}

function mergeEntry(base, incoming) {
  const triggers = normalize([...(base.triggers || []), ...(incoming.triggers || [])]);
  const anti = normalize([...(base.anti || []), ...(incoming.anti || [])]);
  const basis = incoming.basis || base.basis || '';
  return { triggers, anti, basis };
}

// ---------------------------------------------------------------------------
// Determine which section an ID belongs to
// ---------------------------------------------------------------------------
function findSection(lexicons, key) {
  const sections = ['techniques', 'task_types', 'pools', 'tiers', 'flags'];
  for (const sec of sections) {
    if (lexicons[sec] && lexicons[sec][key] !== undefined) return sec;
  }
  // Heuristic: T1..T41 -> techniques
  if (/^T\d+$/.test(key)) return 'techniques';
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const lexicons = JSON.parse(fs.readFileSync(outPath, 'utf8'));

  let incoming;
  try {
    incoming = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  } catch (e) {
    console.error(`Could not read source file: ${srcPath}\n${e.message}`);
    process.exit(1);
  }

  let merged = 0;
  let added = 0;

  for (const [key, entry] of Object.entries(incoming)) {
    const section = findSection(lexicons, key);
    if (!section) {
      console.warn(`Unknown key ${key}, skipping.`);
      continue;
    }

    if (!lexicons[section]) lexicons[section] = {};

    if (lexicons[section][key]) {
      lexicons[section][key] = mergeEntry(lexicons[section][key], entry);
      merged++;
    } else {
      lexicons[section][key] = mergeEntry({}, entry);
      added++;
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(lexicons, null, 2));
  console.log(`Merged ${merged} entries, added ${added} new entries. Wrote to ${outPath}`);
}

main();
