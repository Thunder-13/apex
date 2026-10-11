'use strict';
/**
 * build-bank.js: Compile bank-index-*.jsonl files into references/bank-index.json.
 *
 * Usage:
 *   node router/build-bank.js [--input-dir <dir>] [--prompts-dir <dir>] [--out <path>]
 *
 * Reads: research/bank-index-a{a..f}.jsonl (or from --input-dir)
 * Copies: each referenced prompt file into references/bank/ (exact filename)
 * Writes: references/bank-index.json with BM25 stats (df, avgdl, doc lengths, term frequencies)
 *
 * If no bank-index files exist, uses tests/fixtures/*.jsonl as a fallback.
 */

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const RESEARCH_DIR = path.join(ROOT, '..', '..', 'research'); // apex-v2/research/
const PROMPTS_DIR = path.join(ROOT, '..', '..', 'awesome-prompts-main', 'prompts');
const BANK_DIR = path.join(ROOT, 'references', 'bank');
const OUT_PATH = path.join(ROOT, 'references', 'bank-index.json');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');

const args = process.argv.slice(2);
let inputDir = path.join(ROOT, '..', 'research');
let promptsDir = PROMPTS_DIR;
let outPath = OUT_PATH;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--input-dir' && args[i + 1]) inputDir = args[++i];
  else if (args[i] === '--prompts-dir' && args[i + 1]) promptsDir = args[++i];
  else if (args[i] === '--out' && args[i + 1]) outPath = args[++i];
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
function tokenize(text) {
  return (text || '').toLowerCase().match(/\b[a-z0-9_]+\b/g) || [];
}

function termFreq(tokens) {
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// ---------------------------------------------------------------------------
// Build field text for BM25 indexing
// ---------------------------------------------------------------------------
function buildFieldText(row) {
  const parts = [
    row.title || '',
    row.use_when || '',
    row.structure || '',
    ...(row.keywords || []),
    ...(row.keywords || []), // keywords x2 weight
    ...(row.task_types || []).map(t => t.replace(/_/g, ' ')),
    ...(row.techniques || []), // technique IDs
  ];
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Load all JSONL files
// ---------------------------------------------------------------------------
async function loadJsonlDir(dir, pattern) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(f => pattern.test(f)).map(f => path.join(dir, f));
  } catch {
    return [];
  }
  const rows = [];
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // Ensure output directories exist
  fs.mkdirSync(BANK_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Load bank-index-*.jsonl
  const bankPattern = /^bank-index-[a-z0-9]+\.jsonl$/;
  let rows = await loadJsonlDir(inputDir, bankPattern);

  if (rows.length === 0) {
    console.log('No bank-index files found. Checking fixture directory...');
    const fixturePattern = /^bank-fixture.*\.jsonl$/;
    rows = await loadJsonlDir(FIXTURE_DIR, fixturePattern);
  }

  if (rows.length === 0) {
    console.log('No rows found. Producing empty index.');
    const emptyIndex = { docs: [], df: {}, avgdl: 0 };
    fs.writeFileSync(outPath, JSON.stringify(emptyIndex, null, 2));
    console.log(`Wrote empty index to ${outPath}`);
    return;
  }

  console.log(`Processing ${rows.length} bank rows...`);

  // Deduplicate by file
  const seen = new Set();
  const unique = rows.filter(r => {
    if (seen.has(r.file)) return false;
    seen.add(r.file);
    return true;
  });

  // Build BM25 index
  const docs = [];
  const df = {}; // document frequency per term
  let totalLen = 0;

  for (const row of unique) {
    const fieldText = buildFieldText(row);
    const tokens = tokenize(fieldText);
    const tf = termFreq(tokens);
    const len = tokens.length;
    totalLen += len;

    // Update df
    for (const term of Object.keys(tf)) {
      df[term] = (df[term] || 0) + 1;
    }

    // Copy prompt file if it exists
    const srcFile = path.join(promptsDir, row.file);
    const dstFile = path.join(BANK_DIR, row.file);
    try {
      if (fs.existsSync(srcFile)) {
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
      }
    } catch (e) {
      console.warn(`Could not copy ${row.file}: ${e.message}`);
    }

    docs.push({
      file: row.file,
      title: row.title,
      use_when: row.use_when,
      structure: row.structure,
      fragment: row.fragment,
      quality: row.quality,
      task_types: row.task_types,
      techniques: row.techniques,
      keywords: row.keywords,
      termFreq: tf,
      len,
    });
  }

  const avgdl = docs.length > 0 ? totalLen / docs.length : 0;

  // Full index (human-readable, includes termFreq per doc)
  const index = { docs, df, avgdl };
  fs.writeFileSync(outPath, JSON.stringify(index, null, 2));
  const fullSize = fs.statSync(outPath).size;
  console.log(`Wrote ${docs.length} docs to ${outPath} (avgdl=${avgdl.toFixed(1)}, ${(fullSize/1024).toFixed(0)} KB)`);

  // Compact index for runtime: postings format
  // vocab: {term -> termIdx}
  // postings: {termIdx -> [docIdx, tf, docIdx, tf, ...]}
  // docs: [{file, use_when<=140, fragment<=160, quality, task_types, techniques}]
  // lens: [docLen, ...]
  // avgdl: number
  const vocab = {};
  const postings = {};
  let termIdxCounter = 0;

  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const tf = doc.termFreq || {};
    for (const [term, count] of Object.entries(tf)) {
      let ti = vocab[term];
      if (ti === undefined) {
        ti = termIdxCounter++;
        vocab[term] = ti;
        postings[ti] = [];
      }
      postings[ti].push(di, count);
    }
  }

  const minDocs = docs.map(doc => ({
    file: doc.file,
    use_when: (doc.use_when || '').slice(0, 140),
    fragment: (doc.fragment || '').slice(0, 160),
    quality: doc.quality,
    task_types: doc.task_types,
    techniques: doc.techniques,
  }));

  const minIndex = {
    avgdl,
    docs: minDocs,
    lens: docs.map(d => d.len),
    vocab,
    postings,
  };

  const minOutPath = outPath.replace(/\.json$/, '.min.json');
  fs.writeFileSync(minOutPath, JSON.stringify(minIndex));
  const minSize = fs.statSync(minOutPath).size;
  console.log(`Wrote compact index to ${minOutPath} (${(minSize/1024).toFixed(0)} KB vs full ${(fullSize/1024).toFixed(0)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
