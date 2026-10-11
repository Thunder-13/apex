'use strict';
/**
 * features.js: state -> feature vector
 * Deterministic, lowercase, Unicode-aware.
 * Returns a flat {name: number} map.
 *
 * Lexicon hits use the compiled lookup table (lexicon.compiled.json):
 * tokenize once, slide n-gram window, O(1) Map lookup per n-gram.
 * No per-entry RegExp construction at runtime.
 */

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Compiled lexicon (loaded once at module start)
// ---------------------------------------------------------------------------
let _compiled = null;
let _compiledMap = null; // Map<phraseKey, [{feat, polarity}]>

function getCompiled() {
  if (_compiled) return _compiled;
  const p = path.join(__dirname, 'lexicon.compiled.json');
  _compiled = JSON.parse(fs.readFileSync(p, 'utf8'));
  _compiledMap = new Map(Object.entries(_compiled.map));
  return _compiled;
}

function getCompiledMap() {
  if (_compiledMap) return _compiledMap;
  getCompiled();
  return _compiledMap;
}

// ---------------------------------------------------------------------------
// Lexicon-hit tokenizer (matches compile.js's phraseTokens)
// Emits plain tokens AND "word:" tokens when a word is followed by colon.
// ---------------------------------------------------------------------------
// Marker inserted at punctuation boundaries so that n-grams cannot span
// across commas, semicolons, periods, etc.  Must compare by reference (===).
const LEX_BREAK = null;

function tokenizeLex(text) {
  const lower = text.toLowerCase();
  const tokens = [];
  // Scan character-by-character: emit word tokens (with optional trailing ':')
  // and null boundary markers at punctuation.  This keeps n-gram matching
  // behaviour equivalent to the regex path, which uses word-boundary anchors
  // and cannot span punctuation.
  // Hyphens and slashes are NOT treated as boundaries (they join compound
  // terms: "real-time" -> ["real","time"], "input/output" -> ["input","output"]).
  // Commas and other punctuation DO break n-gram spans.
  const re = /[a-z0-9]+|[,;.!?()\[\]{}<>\\"'`~@#$%^&*+=|]/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    const tok = m[0];
    if (/[a-z0-9]/.test(tok[0])) {
      // Skip oversized tokens (e.g. minified JS, base64) — they carry no
      // lexicon signal and would pollute n-gram windows.
      if (tok.length > 256) continue;
      const after = lower[m.index + tok.length];
      tokens.push(after === ':' ? tok + ':' : tok);
    } else {
      // Punctuation: only insert a break if the last token was a word (avoid
      // consecutive breaks cluttering the array).
      if (tokens.length > 0 && tokens[tokens.length - 1] !== LEX_BREAK) {
        tokens.push(LEX_BREAK);
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Compiled-lexicon feature computation
// ---------------------------------------------------------------------------
/**
 * Count phrase hits using compiled Map + n-gram sliding window.
 * @param {string[]} tokens - pre-tokenized text
 * @param {number} maxLen - max phrase length in tokens
 * @param {Map} map - compiled phrase -> [{feat, polarity}]
 * @param {number} weight - 1.0 for main text, 0.3 for snippet
 * @param {Object} counts - accumulator {feat: {trigger: n, anti: n}}
 */
function countNgrams(tokens, maxLen, map, weight, counts) {
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    if (tokens[i] === LEX_BREAK) continue; // skip boundary markers
    // Build n-grams starting at position i, width 1..maxLen
    let key = '';
    for (let w = 1; w <= maxLen && i + w <= n; w++) {
      const tok = tokens[i + w - 1];
      if (tok === LEX_BREAK) break; // don't cross punctuation boundaries
      key = w === 1 ? tok : key + ' ' + tok;
      let entries = map.get(key);
      // Fallback: if the key ends with ':' (happens when the last word in the
      // n-gram was followed by ':' in the text, e.g. "diverge then converge:"),
      // try the key without the trailing colon.  Single-word colon phrases like
      // "output:" have an exact entry and will have already matched above.
      if (!entries && key.endsWith(':')) entries = map.get(key.slice(0, -1));
      if (!entries) continue;
      for (const { feat, polarity } of entries) {
        if (!counts[feat]) counts[feat] = { trigger: 0, anti: 0 };
        counts[feat][polarity] += weight;
      }
    }
  }
}

/**
 * Compute all lexicon features from pre-tokenized main and snippet text.
 * Returns {featName: number} using: log1p(trigger) - 0.7*log1p(anti)
 */
function lexiconFeaturesCompiled(mainTokens, snippetTokens) {
  const { _maxLen: maxLen } = getCompiled();
  const map = getCompiledMap();
  const counts = {}; // feat -> {trigger, anti}

  countNgrams(mainTokens, maxLen, map, 1.0, counts);
  countNgrams(snippetTokens, maxLen, map, 0.3, counts);

  // Collect all known feat names from lexicons to ensure zero-valued features exist
  const features = {};
  // Initialize all features to 0
  for (const entries of map.values()) {
    for (const { feat } of entries) {
      if (!(feat in features)) features[feat] = 0;
    }
  }
  // Fill in computed values
  for (const [feat, { trigger, anti }] of Object.entries(counts)) {
    features[feat] = Math.log1p(trigger) - 0.7 * Math.log1p(anti);
  }
  return features;
}

// ---------------------------------------------------------------------------
// Legacy regex path (kept for test comparison; not used in production path)
// ---------------------------------------------------------------------------
let _lexicons = null;
function getLexicons() {
  if (_lexicons) return _lexicons;
  const p = path.join(__dirname, 'lexicons.json');
  _lexicons = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _lexicons;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePatterns(phrases) {
  return phrases.map(ph => {
    // Normalize hyphens and slashes to spaces so that "real-time" or
    // "input/output" phrases match hyphenated/slashed text.
    // The compiled path does this implicitly: tokenizer strips these chars
    // and break markers prevent span across commas/periods.
    ph = ph.toLowerCase().replace(/[-/]/g, ' ');
    return new RegExp('(?<![a-z0-9])' + escapeRe(ph) + '(?![a-z0-9])', 'gi');
  });
}

function countHits(text, patterns) {
  let n = 0;
  // Normalize hyphens and slashes to spaces in text to match compiled-path
  // tokenizer behaviour (both chars are stripped by the tokenizer).
  const normText = text.replace(/[-/]/g, ' ');
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = normText.match(re);
    if (m) n += m.length;
  }
  return n;
}

let _compiledPatternsLegacy = null;
function getLegacyPatterns() {
  if (_compiledPatternsLegacy) return _compiledPatternsLegacy;
  const lex = getLexicons();
  const compiled = new Map();
  const groups = ['task_types', 'pools', 'tiers', 'flags', 'techniques'];
  for (const group of groups) {
    const section = lex[group];
    if (!section) continue;
    for (const [key, entry] of Object.entries(section)) {
      compiled.set(`${group}:${key}`, {
        triggers: compilePatterns(entry.triggers || []),
        anti: compilePatterns(entry.anti || []),
      });
    }
  }
  _compiledPatternsLegacy = compiled;
  return compiled;
}

/**
 * Legacy regex-based lexicon features. Exported only for test comparison.
 * @param {string} mainText - lowercase main text
 * @param {string} snippetText - lowercase snippet text
 */
function _lexiconFeaturesRegex(mainText, snippetText) {
  const lex = getLexicons();
  const features = {};
  const groups = ['task_types', 'pools', 'tiers', 'flags', 'techniques'];
  const legacyMap = getLegacyPatterns();
  for (const group of groups) {
    const section = lex[group];
    if (!section) continue;
    for (const [key] of Object.entries(section)) {
      const cacheKey = `${group}:${key}`;
      const patterns = legacyMap.get(cacheKey) || { triggers: [], anti: [] };
      const trigMain = countHits(mainText, patterns.triggers);
      const trigSnip = countHits(snippetText, patterns.triggers);
      const antiMain = countHits(mainText, patterns.anti);
      const antiSnip = countHits(snippetText, patterns.anti);
      const trigTotal = trigMain + 0.3 * trigSnip;
      const antiTotal = antiMain + 0.3 * antiSnip;
      features[`lex:${group}:${key}`] = Math.log1p(trigTotal) - 0.7 * Math.log1p(antiTotal);
    }
  }
  return features;
}

// ---------------------------------------------------------------------------
// Structural feature extraction (unchanged)
// ---------------------------------------------------------------------------
// CODE_FENCE_RE: bounded quantifier prevents O(n²) on unclosed triple-backtick spans.
const CODE_FENCE_RE = /```[\s\S]{0,65536}?```/g;
const PATH_RE = /(?:^|\s)((?:\/|~\/|\.\/|\.\.\/)[^\s]{2,}|[a-zA-Z]:\\[^\s]+)/g;
const URL_RE = /https?:\/\/[^\s]+/g;
const MCP_TOOL_RE = /\bmcp[_\-][a-z][a-z0-9_]*/gi;
const SLASH_CMD_RE = /(?:^|\s)(\/[a-z][a-z0-9_-]*)/g;
const ENDS_QUESTION_RE = /\?\s*$/;
const IMPERATIVE_FIRST_WORD_RE = /^(write|build|create|implement|make|add|fix|refactor|generate|run|deploy|send|delete|analyze|explain|review|extract|parse|show|list|find|get|give|tell|describe|design|plan|develop|set|update|change|remove|insert|convert|transform|output|return|check|test|draft|compose|define|calculate|compute|summarize|compare|evaluate|suggest|brainstorm|optimize|scaffold|initialize|configure|install|setup)\b/i;
const LIST_ITEM_RE = /(?:^|\n)\s*(?:\d+\.\s+|\*\s+|-\s+|•\s+)/g;
const AND_CLAUSE_RE = /\band\b/gi;
// JSON_BLOB_RE removed: replaced with linear brace-counting helpers below.
const STACK_TRACE_RE = /(?:at\s+\w+\s*\(|Traceback|Error:|Exception:|^\s+at\s)/m;

// ---------------------------------------------------------------------------
// Linear JSON-blob helpers (O(n), no regex backtracking)
// Handles nested braces via brace counter; caps snippet extraction at 8 KB.
// ---------------------------------------------------------------------------
const _JSON_MIN = 20;
const _JSON_MAX_EXTRACT = 8192;

/** Return true iff text contains at least one {…} span >= 20 chars. */
function _hasJsonBlob(text) {
  const lo = text.indexOf('{');
  if (lo < 0) return false;
  const hi = text.indexOf('}', lo + _JSON_MIN + 1);
  return hi > 0;
}

/** Extract top-level JSON blob strings (capped at _JSON_MAX_EXTRACT chars each). */
function _extractJsonBlobs(text) {
  const blobs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === '}' && depth > 0) {
      if (--depth === 0 && start >= 0 && i - start >= _JSON_MIN) {
        blobs.push(text.slice(start, Math.min(i + 1, start + _JSON_MAX_EXTRACT)));
        start = -1;
      }
    }
  }
  return blobs;
}

/** Return text with top-level JSON blobs (>= 20 chars) replaced by a space. */
function _stripJsonBlobs(text) {
  let out = '', depth = 0, start = -1, prevEnd = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth++ === 0) start = i;
    } else if (c === '}' && depth > 0) {
      if (--depth === 0 && start >= 0 && i - start >= _JSON_MIN) {
        out += text.slice(prevEnd, start) + ' ';
        prevEnd = i + 1;
        start = -1;
      }
    }
  }
  return out + text.slice(prevEnd);
}

const FILE_REF_RE = /(?:\b\w+\.\w{2,4}\b|`[^`]+\.[a-z]{2,4}`)/g;
const SCOPE_ALL_RE = /\b(all|every|entire|whole)\b/gi;
const DESTRUCTIVE_VERBS_RE = /\b(rm\s+-rf?|delete|drop|force\s+push|reset\s+--(?:hard|soft)|deploy|prod(?:uction)?|publish|send|migrate|nuke|wipe|purge|erase|overwrite|truncate)\b/gi;
const NON_ASCII_RE = /[^\x00-\x7F]/g;
const FOLLOWUP_RE = /\b(it|that|same|again|the other)\b/gi;

function structuralFeatures(prompt) {
  const codeFences = (prompt.match(CODE_FENCE_RE) || []).join(' ');
  const jsonBlobs = _extractJsonBlobs(prompt).join(' ');
  const snippetText = (codeFences + ' ' + jsonBlobs).toLowerCase();
  const mainText = _stripJsonBlobs(prompt.replace(CODE_FENCE_RE, ' '));
  const words = mainText.trim().split(/\s+/).filter(Boolean);

  const features = {};
  features['s:log_words'] = Math.log1p(words.length);
  features['s:has_code_fence'] = /```/.test(prompt) ? 1 : 0;
  features['s:has_path'] = PATH_RE.test(prompt) ? 1 : 0;
  features['s:has_url'] = URL_RE.test(prompt) ? 1 : 0;
  features['s:has_mcp_tool'] = MCP_TOOL_RE.test(prompt) ? 1 : 0;
  features['s:has_slash_cmd'] = SLASH_CMD_RE.test(prompt) ? 1 : 0;
  features['s:ends_question'] = ENDS_QUESTION_RE.test(prompt.trim()) ? 1 : 0;
  features['s:starts_imperative'] = IMPERATIVE_FIRST_WORD_RE.test(prompt.trim()) ? 1 : 0;
  features['s:n_list_items'] = (prompt.match(LIST_ITEM_RE) || []).length;
  features['s:n_and_clauses'] = (mainText.match(AND_CLAUSE_RE) || []).length;
  features['s:pasted_long'] = prompt.length > 600 ? 1 : 0;
  features['s:has_stack_trace'] = STACK_TRACE_RE.test(prompt) ? 1 : 0;
  features['s:has_json_blob'] = _hasJsonBlob(prompt) ? 1 : 0;
  features['s:n_file_refs'] = (prompt.match(FILE_REF_RE) || []).length;
  features['s:scope_all_words'] = (prompt.match(SCOPE_ALL_RE) || []).length;
  features['s:destructive_verbs'] = (prompt.match(DESTRUCTIVE_VERBS_RE) || []).length;
  const nonAscii = (prompt.match(NON_ASCII_RE) || []).length;
  features['s:non_ascii_ratio'] = prompt.length > 0 ? nonAscii / prompt.length : 0;
  features['s:followup_refs'] = (prompt.match(FOLLOWUP_RE) || []).length;
  features['s:bias'] = 1;

  return { features, mainText: mainText.toLowerCase(), snippetText };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all features from a raw prompt string.
 * Returns {name: number} map. Deterministic.
 */
function extractFeatures(prompt) {
  if (typeof prompt !== 'string') prompt = String(prompt || '');

  const { features: struct, mainText, snippetText } = structuralFeatures(prompt);

  // Compiled-lexicon path
  const mainTokens = tokenizeLex(mainText);
  const snippetTokens = tokenizeLex(snippetText);
  const lex = lexiconFeaturesCompiled(mainTokens, snippetTokens);

  return Object.assign({}, struct, lex);
}

/**
 * Legacy regex-based extractFeatures. Only used in tests for comparison.
 */
function extractFeaturesRegex(prompt) {
  if (typeof prompt !== 'string') prompt = String(prompt || '');
  const { features: struct, mainText, snippetText } = structuralFeatures(prompt);
  const lex = _lexiconFeaturesRegex(mainText, snippetText);
  return Object.assign({}, struct, lex);
}

// Pre-warm at module load: parse compiled JSON + build Map
getCompiled();

module.exports = { extractFeatures, extractFeaturesRegex, getLexicons, tokenizeLex };
