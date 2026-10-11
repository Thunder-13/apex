'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const child_process = require('child_process');

// ─── Public API ───────────────────────────────────────────────────────────────
const SOURCES = [
  'user_message', 'web_page', 'pdf', 'email', 'markdown',
  'html', 'word_doc', 'api_response', 'ocr_text', 'source_code',
  'image_via_ocr'
];

// ─── Binary resolution (no shell lookup) ─────────────────────────────────────
const BINARY_SEARCH_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
];

function findBinary(name) {
  for (var i = 0; i < BINARY_SEARCH_PATHS.length; i++) {
    var p = BINARY_SEARCH_PATHS[i] + '/' + name;
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

// ─── Path validation ──────────────────────────────────────────────────────────
var MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
var MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

function validateFilePath(p, maxBytes) {
  if (typeof p !== 'string') return { ok: false, note: 'path is not a string' };
  if (p.indexOf('\x00') !== -1) return { ok: false, note: 'path contains NUL byte' };
  var stat;
  try { stat = fs.statSync(p); } catch (e) { return { ok: false, note: 'stat failed: ' + e.message }; }
  if (!stat.isFile()) return { ok: false, note: 'path is not a regular file' };
  var limit = maxBytes || MAX_FILE_BYTES;
  if (stat.size > limit) return { ok: false, note: 'file size ' + stat.size + ' exceeds limit ' + limit };
  return { ok: true };
}

// ─── Temp file helper ─────────────────────────────────────────────────────────
function writeTempFile(data, ext) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pif-adapt-'));
  var tmpFile = path.join(tmpDir, 'input' + (ext || ''));
  if (Buffer.isBuffer(data)) {
    fs.writeFileSync(tmpFile, data);
  } else {
    fs.writeFileSync(tmpFile, data, 'utf8');
  }
  return { tmpDir: tmpDir, tmpFile: tmpFile };
}

function cleanupTempDir(tmpDir) {
  try {
    var files = fs.readdirSync(tmpDir);
    for (var i = 0; i < files.length; i++) {
      try { fs.unlinkSync(path.join(tmpDir, files[i])); } catch (e) {}
    }
    fs.rmdirSync(tmpDir);
  } catch (e) {}
}

// ─── Injection phrase patterns ────────────────────────────────────────────────
const INJECTION_PHRASES = [
  /ignore\s+(all\s+)?(previous|prior|earlier)\s+(instructions?|context|rules?)/i,
  /disregard\s+(your|the|all|previous)\s+(rules|instructions|guidelines)/i,
  /you\s+are\s+(now|a)\s+(DAN|unrestricted|without restrictions|developer mode)/i,
  /system\s*[:\-]/i,
  /reveal\s+(your|the)\s+(system|initial)\s+(prompt|instructions)/i,
  /repeat\s+(your|the)\s+(system|initial)\s+(prompt|instructions)/i,
  /pretend\s+(you|to be)/i,
  /roleplay\s+as/i,
  /forget\s+(everything|all)\s+above/i,
];

function containsInjection(text) {
  return INJECTION_PHRASES.some(function (r) { return r.test(text); });
}

// ─── Base64 heuristics ────────────────────────────────────────────────────────
const BASE64_STD_RE = /^[A-Za-z0-9+\/]{20,}={0,2}$/;
const BASE64_URL_RE = /^[A-Za-z0-9_-]{20,}={0,2}$/;

function isBase64(str) {
  return BASE64_STD_RE.test(str) || BASE64_URL_RE.test(str);
}

// ─── Zero-width and tag character scan ───────────────────────────────────────
function scanZeroWidth(text) {
  var flags = [];
  var m;

  var zwRe = /[​‌‍﻿]+/g;
  while ((m = zwRe.exec(text)) !== null) {
    var codepoints = Array.from(m[0]).map(function (c) {
      return 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    }).join(', ');
    var start = Math.max(0, m.index - 10);
    var end = Math.min(text.length, m.index + m[0].length + 10);
    flags.push({
      kind: 'zero_width',
      excerpt: text.slice(start, end),
      note: 'Zero-width character(s) (' + codepoints + ') at offset ' + m.index
    });
  }

  var tagRe = /\uDB40[\uDC00-\uDC7F]+/g;
  while ((m = tagRe.exec(text)) !== null) {
    flags.push({
      kind: 'tag_chars',
      excerpt: text.slice(Math.max(0, m.index - 5), Math.min(text.length, m.index + m[0].length + 5)),
      note: 'Unicode tag characters at offset ' + m.index
    });
  }

  return flags;
}

// ─── Homoglyph scan ───────────────────────────────────────────────────────────
var CYRILLIC_RANGE_RE = /[Ѐ-ӿ]/;
var GREEK_RANGE_RE = /[Ͱ-Ͽ]/;
var LATIN_CHAR_RE = /[A-Za-z]/;

function scanHomoglyphs(text) {
  var flags = [];
  var wordRe = /[A-Za-zЀ-ӿͰ-Ͽ]{2,}/g;
  var m;
  while ((m = wordRe.exec(text)) !== null) {
    var word = m[0];
    var hasLatin = LATIN_CHAR_RE.test(word);
    var hasCyrillic = CYRILLIC_RANGE_RE.test(word);
    var hasGreek = GREEK_RANGE_RE.test(word);
    if (hasLatin && (hasCyrillic || hasGreek)) {
      flags.push({
        kind: 'homoglyph',
        excerpt: word,
        note: 'Mixed script detected in word "' + word + '" at offset ' + m.index
      });
    }
  }
  return flags;
}

// ─── NFKC normalization ───────────────────────────────────────────────────────
function normalizeNFKC(text) {
  try { return text.normalize('NFKC'); } catch (e) { return text; }
}

// ─── Whitespace collapse ──────────────────────────────────────────────────────
function collapseWhitespace(text) {
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ─── HTML entity decode ───────────────────────────────────────────────────────
function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9A-Fa-f]+);/g, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return _; }
    })
    .replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return _; }
    });
}

// ─── Unified result builder ───────────────────────────────────────────────────
function makeResult(text, provenance_zones, hidden_text_flags, source_type, degraded, extraction, extraction_notes) {
  var extr = extraction || (degraded ? 'failed' : 'complete');
  return {
    text: text,
    provenance_zones: provenance_zones,
    hidden_text_flags: hidden_text_flags,
    source_type: source_type,
    degraded: !!(degraded || extr !== 'complete'),
    extraction: extr,
    extraction_notes: extraction_notes || []
  };
}

// ─── CSS hiding patterns ──────────────────────────────────────────────────────
var CSS_HIDE_PATTERNS = [
  /display\s*:\s*none/i,
  /visibility\s*:\s*hidden/i,
  /color\s*:\s*#fff(?:fff)?(?:\s*[;"]|$)/i,
  /color\s*:\s*white(?:\s*[;"]|$)/i,
  /font-size\s*:\s*0(?:\s*px)?(?:\s*[;"]|$)/i,
  /font-size\s*:\s*1px(?:\s*[;"]|$)/i,
  /opacity\s*:\s*0(?:\s*[;"]|$)/i,
  /(?:top|left)\s*:\s*-\d{3,}px/i,
];

function isCssHidden(style) {
  return CSS_HIDE_PATTERNS.some(function (p) { return p.test(style); });
}

// ─── Linear block extractor (ReDoS-safe) ─────────────────────────────────────
// Removes opener…closer blocks from text. Calls onBlock(inner) for each.
// O(n) total — no regex backtracking across the full string.
function extractBlocksExact(text, opener, closer, onBlock, repl) {
  var opLen = opener.length;
  var clLen = closer.length;
  if (repl === undefined) repl = '';
  var out = '';
  var pos = 0;
  while (pos < text.length) {
    var s = text.indexOf(opener, pos);
    if (s === -1) { out += text.slice(pos); break; }
    out += text.slice(pos, s);
    var e = text.indexOf(closer, s + opLen);
    if (e === -1) { if (onBlock) onBlock(text.slice(s + opLen)); out += repl; break; }
    if (onBlock) onBlock(text.slice(s + opLen, e));
    out += repl;
    pos = e + clLen;
  }
  return out;
}

// Case-insensitive variant — searches lowercase copy, extracts from original.
function extractBlocksCI(text, openerLc, closerLc, onBlock, repl) {
  var opLen = openerLc.length;
  var clLen = closerLc.length;
  if (repl === undefined) repl = '';
  var lc = text.toLowerCase();
  var out = '';
  var pos = 0;
  while (pos < text.length) {
    var s = lc.indexOf(openerLc, pos);
    if (s === -1) { out += text.slice(pos); break; }
    out += text.slice(pos, s);
    var e = lc.indexOf(closerLc, s + opLen);
    if (e === -1) { if (onBlock) onBlock(text.slice(s + opLen)); out += repl; break; }
    if (onBlock) onBlock(text.slice(s + opLen, e));
    out += repl;
    pos = e + clLen;
  }
  return out;
}

// Find first '>' after `afterLt` in text, but stop at the next '<' (or 4096 chars).
// Uses slice to bound the indexOf call so each invocation is O(min(dist_to_next_<, 4096)).
function findTagClose(text, afterLt, nextLt) {
  var lim = nextLt === -1 ? afterLt + 4096 : Math.min(nextLt, afterLt + 4096);
  var seg = text.slice(afterLt, lim);
  var i = seg.indexOf('>');
  return i === -1 ? -1 : afterLt + i;
}

// Linear extractor for XML/Word element blocks (e.g. <w:t ...>text</w:t>).
// Handles attributes in the opener; never uses [\s\S]*? backtracking. O(n) total.
// onBlock(innerText) called for each complete block; returns reconstructed string.
function extractXmlTagBlocks(xml, tagName, onBlock, repl) {
  if (repl === undefined) repl = '';
  var opener = '<' + tagName;
  var closer = '</' + tagName + '>';
  var opLen = opener.length;
  var clLen = closer.length;
  var out = '';
  var pos = 0;
  while (pos < xml.length) {
    var s = xml.indexOf(opener, pos);
    if (s === -1) { out += xml.slice(pos); break; }
    // Tag name must end at a word boundary (>, whitespace, or /)
    var c = s + opLen < xml.length ? xml.charCodeAt(s + opLen) : -1;
    if (c !== 62 && c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 47) {
      out += xml.slice(pos, s + opLen); pos = s + opLen; continue;
    }
    out += xml.slice(pos, s);
    // Find '>' of opening tag, bounded to 4096 chars from start of tag
    var gtPos = xml.indexOf('>', s + opLen);
    if (gtPos === -1 || gtPos - s > 4096) {
      out += xml.slice(s, s + opLen); pos = s + opLen; continue;
    }
    // Self-closing?
    if (xml.charCodeAt(gtPos - 1) === 47) { out += repl; pos = gtPos + 1; continue; }
    // Find closing tag
    var e = xml.indexOf(closer, gtPos + 1);
    if (e === -1) { if (onBlock) onBlock(xml.slice(gtPos + 1)); out += repl; break; }
    if (onBlock) onBlock(xml.slice(gtPos + 1, e));
    out += repl;
    pos = e + clLen;
  }
  return out;
}

// Linear scanner for raw HTML blocks in markdown: <tag...>content</tag>.
// Avoids [\s\S]*? backtracking. Calls onBlock(fullMatch) -> replacement string.
// O(n) total: closeTagNotFound cache prevents re-scanning when a closing tag is
// absent, making repeated same-tag openers (e.g. "<script>a" * n) O(n) not O(n^2).
function extractRawHtmlBlocks(md, onBlock) {
  var lc = md.toLowerCase();
  var out = '';
  var pos = 0;
  // Cache: tagName -> true when </tagname> is absent from current pos to end-of-string.
  // Once indexOf returns -1 for a tag from position X, all later positions also return -1.
  var closeTagNotFound = {};
  while (pos < md.length) {
    var lt = md.indexOf('<', pos);
    if (lt === -1) { out += md.slice(pos); break; }
    if (lt + 1 >= md.length || !/[a-zA-Z]/.test(md[lt + 1])) {
      out += md.slice(pos, lt + 1); pos = lt + 1; continue;
    }
    // Read tag name (cap at 20 chars)
    var nameEnd = lt + 1;
    while (nameEnd < md.length && nameEnd - lt < 21 && /[a-zA-Z0-9]/.test(md[nameEnd])) nameEnd++;
    var tagName = lc.slice(lt + 1, nameEnd);
    // Find closing '>' of opening tag — bounded to O(1) per '<'
    var nextLt = md.indexOf('<', lt + 1);
    var gt = findTagClose(md, lt + 1, nextLt);
    if (gt === -1) { out += md.slice(pos, lt + 1); pos = lt + 1; continue; }
    // Short-circuit: skip indexOf when we already know </tagname> is absent
    if (closeTagNotFound[tagName]) { out += md.slice(pos, gt + 1); pos = gt + 1; continue; }
    // Find matching closing tag
    var closeTag = '</' + tagName + '>';
    var closePos = lc.indexOf(closeTag, gt + 1);
    if (closePos === -1) {
      closeTagNotFound[tagName] = true; // cache: no closer from here to end-of-string
      out += md.slice(pos, gt + 1); pos = gt + 1; continue;
    }
    var fullBlock = md.slice(lt, closePos + closeTag.length);
    var replacement = '';
    try { replacement = onBlock(fullBlock) || ''; } catch (e2) { replacement = fullBlock.replace(/<[^<>]{0,4096}>/g, ''); }
    out += md.slice(pos, lt);
    out += replacement;
    pos = closePos + closeTag.length;
    // Consumed a close tag; invalidate cache so later openers can still find closers.
    delete closeTagNotFound[tagName];
  }
  return out;
}

// Linear scanner for CSS-hidden and attr-hidden elements (replaces [\s\S]*? patterns).
// Finds opening tags with style/hidden/aria-hidden attrs, extracts inner text as flags.
function scanHiddenElements(html, hidden_text_flags) {
  var lc = html.toLowerCase();
  var out = '';
  var pos = 0;
  while (pos < html.length) {
    var lt = html.indexOf('<', pos);
    if (lt === -1) { out += html.slice(pos); break; }
    // Must be followed by a letter (element opening tag)
    if (lt + 1 >= html.length || !/[a-zA-Z]/.test(html[lt + 1])) {
      out += html.slice(pos, lt + 1); pos = lt + 1; continue;
    }
    // Read tag name (cap 20 chars)
    var nameEnd = lt + 1;
    while (nameEnd < html.length && nameEnd - lt < 21 && /[a-zA-Z0-9]/.test(html[nameEnd])) nameEnd++;
    var tagNameLc = lc.slice(lt + 1, nameEnd);
    // Find '>' of opening tag — bounded to O(1) per '<' via findTagClose
    var nextLt2 = html.indexOf('<', lt + 1);
    var gt = findTagClose(html, lt + 1, nextLt2);
    if (gt === -1) { out += html.slice(pos, lt + 1); pos = lt + 1; continue; }
    var attrStr = html.slice(nameEnd, gt);
    if (attrStr[attrStr.length - 1] === '/') { out += html.slice(pos, gt + 1); pos = gt + 1; continue; }
    // Check CSS style hiding (bounded attribute extraction)
    var styleHidden = false;
    var styleVal = '';
    var sm = attrStr.match(/\bstyle\s*=\s*"([^"]{0,2000})"/i) || attrStr.match(/\bstyle\s*=\s*'([^']{0,2000})'/i);
    if (sm) { styleVal = sm[1]; styleHidden = isCssHidden(styleVal); }
    // Check hidden / aria-hidden attributes
    var attrHidden = false;
    var attrHiddenNote = '';
    if (!styleHidden) {
      if (/\baria-hidden\s*=\s*["']true["']/i.test(attrStr)) {
        attrHidden = true; attrHiddenNote = 'aria-hidden="true" — hidden element';
      } else if (/\bhidden(?:\s*=\s*["'][^"']{0,100}["'])?/i.test(attrStr)) {
        attrHidden = true; attrHiddenNote = 'hidden attribute — hidden element';
      }
    }
    if (styleHidden || attrHidden) {
      var closeTag = '</' + tagNameLc + '>';
      var closePos = lc.indexOf(closeTag, gt + 1);
      if (closePos === -1) { out += html.slice(pos, lt); pos = gt + 1; continue; }
      var inner = html.slice(gt + 1, closePos);
      var cleanText = inner.replace(/<[^<>]{0,4096}>/g, '').trim();
      if (cleanText) {
        var note = styleHidden
          ? ('style="' + styleVal.trim() + '" — visually hidden text')
          : attrHiddenNote;
        hidden_text_flags.push({ kind: 'off_screen_css', excerpt: cleanText, note: note });
      }
      out += html.slice(pos, lt);
      pos = closePos + closeTag.length;
      continue;
    }
    out += html.slice(pos, gt + 1);
    pos = gt + 1;
  }
  return out;
}

// ─── HTML adapter ─────────────────────────────────────────────────────────────
function adaptHtml(content, options) {
  try {
    var html = String(content);
    var hidden_text_flags = [];
    var altTexts = [];

    // 1. HTML comments (indexOf loop — avoids [\s\S]*? ReDoS on '<!--'.repeat(n))
    html = extractBlocksExact(html, '<!--', '-->', function (comment) {
      hidden_text_flags.push({ kind: 'html_comment', excerpt: comment.trim(), note: 'HTML comment' });
    });

    // 2. Strip script, style, noscript blocks (indexOf loop)
    html = extractBlocksCI(html, '<script', '</script>');
    html = extractBlocksCI(html, '<style', '</style>');
    html = extractBlocksCI(html, '<noscript', '</noscript>');

    // 3. <template> content — flag as hidden (indexOf loop)
    html = extractBlocksCI(html, '<template', '</template>', function (inner) {
      // inner starts with optional tag attributes then '>', strip them
      var gtIdx = inner.indexOf('>');
      var content = gtIdx >= 0 ? inner.slice(gtIdx + 1) : inner;
      var cleanText = content.replace(/<[^<>]{0,4096}>/g, '').trim();
      if (cleanText) {
        hidden_text_flags.push({ kind: 'off_screen_css', excerpt: cleanText, note: '<template> hidden content' });
      }
    });

    // 4. <input type="hidden" value="..."> — exclude '<' so failed match is O(1)
    html = html.replace(/<input[^<>]{0,4096}>/gi, function (tag) {
      var typeM = tag.match(/\btype\s*=\s*["']([^"']*)["']/i);
      if (typeM && typeM[1].toLowerCase() === 'hidden') {
        var valM = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
        if (valM && valM[1].trim()) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: valM[1].trim(), note: 'input[type=hidden] value' });
        }
      }
      return ' ';
    });

    // 5. iframe srcdoc — exclude '<' from tag-attribute class
    html = html.replace(/<iframe[^<>]{0,4096}srcdoc\s*=\s*"([^"]{0,8192})"[^<>]{0,4096}>/gi, function (match, srcdoc) {
      if (srcdoc.trim()) {
        hidden_text_flags.push({ kind: 'html_comment', excerpt: decodeHtmlEntities(srcdoc).slice(0, 200), note: 'iframe srcdoc content' });
      }
      return ' ';
    });
    html = html.replace(/<iframe[^<>]{0,4096}srcdoc\s*=\s*'([^']{0,8192})'[^<>]{0,4096}>/gi, function (match, srcdoc) {
      if (srcdoc.trim()) {
        hidden_text_flags.push({ kind: 'html_comment', excerpt: decodeHtmlEntities(srcdoc).slice(0, 200), note: 'iframe srcdoc content' });
      }
      return ' ';
    });

    // 6. meta http-equiv="refresh" — exclude '<'
    html = html.replace(/<meta[^<>]{0,4096}http-equiv\s*=\s*["']refresh["'][^<>]{0,4096}>/gi, function (tag) {
      var contentM = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
      if (contentM) {
        hidden_text_flags.push({ kind: 'metadata_field', excerpt: contentM[1].trim(), note: 'meta http-equiv="refresh"' });
      }
      return '';
    });

    // 7+8. Elements hidden by CSS style or hidden/aria-hidden attribute (linear scan)
    html = scanHiddenElements(html, hidden_text_flags);

    // 9. Extract meta content (non-refresh) — exclude '<'
    html = html.replace(/<meta[^<>]{0,4096}>/gi, function (tag) {
      var nameM = tag.match(/\bname\s*=\s*["']([^"']*)["']/i);
      var contentM = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
      if (contentM && contentM[1].trim()) {
        var metaName = nameM ? nameM[1] : 'unknown';
        hidden_text_flags.push({ kind: 'metadata_field', excerpt: contentM[1].trim(), note: 'meta[name="' + metaName + '"]' });
        altTexts.push('[META] ' + contentM[1].trim());
      }
      return '';
    });

    // 10. Extract alt, title, aria-label; replace tags with spaces — exclude '<'
    html = html.replace(/<[^<>]{0,4096}>/g, function (tag) {
      var altM = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
      var titleM = tag.match(/\btitle\s*=\s*["']([^"']*)["']/i);
      var ariaM = tag.match(/\baria-label\s*=\s*["']([^"']*)["']/i);
      if (altM && altM[1].trim()) altTexts.push('[ALT] ' + altM[1].trim());
      if (titleM && titleM[1].trim()) altTexts.push('[TITLE] ' + titleM[1].trim());
      if (ariaM && ariaM[1].trim()) altTexts.push('[ARIA] ' + ariaM[1].trim());
      return ' ';
    });

    // 11. Decode entities, normalize, scan
    html = decodeHtmlEntities(html);
    html = normalizeNFKC(html);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(html));

    var text = collapseWhitespace(html);
    if (altTexts.length) {
      text = (text ? text + ' ' : '') + altTexts.join(' ');
    }

    return makeResult(
      text,
      [{ start: 0, end: text.length, source: 'retrieved', trust: 'untrusted' }],
      hidden_text_flags,
      'html', false, 'complete', []
    );
  } catch (e) {
    try {
      var stripped = collapseWhitespace(String(content).replace(/<[^>]+>/g, ' '));
      return makeResult(stripped,
        [{ start: 0, end: stripped.length, source: 'retrieved', trust: 'untrusted' }],
        [{ kind: 'metadata_field', excerpt: '', note: 'html_regex_strip_fallback — css_hidden and comment detection skipped' }],
        'html', true, 'partial', ['html_regex_fallback']
      );
    } catch (e2) {
      return makeResult('', [], [{ kind: 'metadata_field', excerpt: '', note: 'html_adapter_error: ' + e2.message }], 'html', true, 'failed', [e2.message]);
    }
  }
}

// ─── user_message adapter ─────────────────────────────────────────────────────
function adaptUserMessage(content, options) {
  try {
    var text = String(content == null ? '' : content);
    text = normalizeNFKC(text);
    text = text.replace(/\n{3,}/g, '\n\n');

    var hidden_text_flags = [];
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));
    hidden_text_flags = hidden_text_flags.concat(scanHomoglyphs(text));

    return makeResult(text,
      [{ start: 0, end: text.length, source: 'direct', trust: 'trusted' }],
      hidden_text_flags, 'user_message', false, 'complete', []
    );
  } catch (e) {
    return makeResult(String(content == null ? '' : content), [],
      [{ kind: 'metadata_field', excerpt: '', note: 'user_message_adapter_error: ' + e.message }],
      'user_message', true, 'failed', [e.message]
    );
  }
}

// ─── web_page adapter ─────────────────────────────────────────────────────────
function adaptWebPage(content, options) {
  try {
    var result = adaptHtml(content, options);
    result.source_type = 'web_page';
    return result;
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'metadata_field', excerpt: '', note: 'web_page_adapter_error: ' + e.message }],
      'web_page', true, 'failed', [e.message]
    );
  }
}

// ─── PDF linear helpers (ReDoS-safe) ─────────────────────────────────────────

// Linear BT...ET scanner. 'BT' and 'ET' must be whitespace-delimited PDF ops.
// O(n); avoids /BT[\s\S]*?ET/ backtracking on streams full of 'BT' with no 'ET'.
function findBtEtBlocks(text, onBlock) {
  var pos = 0;
  while (pos < text.length) {
    var s = text.indexOf('BT', pos);
    if (s === -1) break;
    var before = s > 0 ? text.charCodeAt(s - 1) : 10;
    var after  = s + 2 < text.length ? text.charCodeAt(s + 2) : 10;
    if (before > 32 || after > 32) { pos = s + 2; continue; }
    var e = text.indexOf('ET', s + 2);
    if (e === -1) { onBlock(text.slice(s + 2)); break; }
    var eBefore = e > 0 ? text.charCodeAt(e - 1) : 10;
    var eAfter  = e + 2 < text.length ? text.charCodeAt(e + 2) : 10;
    if (eBefore > 32 || eAfter > 32) { pos = e + 2; continue; }
    onBlock(text.slice(s + 2, e));
    pos = e + 2;
  }
}

// Linear FlateDecode stream finder. Avoids /FlateDecode[\s\S]*?endstream/ backtracking.
function findFlateDecodeStreams(raw, onStream, maxStreams) {
  var pos = 0; var count = 0;
  while (pos < raw.length && count < maxStreams) {
    var fdPos = raw.indexOf('FlateDecode', pos);
    if (fdPos === -1) break;
    var nlStream = raw.indexOf('\nstream', fdPos);
    if (nlStream === -1) { pos = fdPos + 11; continue; }
    var after = nlStream + 7; // skip '\nstream'
    if (after < raw.length && raw.charCodeAt(after) === 13) after++; // skip \r
    if (after >= raw.length || raw.charCodeAt(after) !== 10) { pos = fdPos + 11; continue; }
    after++; // skip \n
    var endPos = raw.indexOf('endstream', after);
    if (endPos === -1) { pos = fdPos + 11; continue; }
    onStream(raw.slice(after, endPos));
    count++;
    pos = endPos + 9;
  }
}

// Linear raw-stream finder. Avoids /^stream\r?\n[\s\S]*?endstream/gm backtracking.
function findRawStreams(raw, onStream, maxStreams) {
  var pos = 0; var count = 0;
  while (pos < raw.length && count < maxStreams) {
    var sPos = raw.indexOf('stream', pos);
    if (sPos === -1) break;
    if (sPos === 0 || raw.charCodeAt(sPos - 1) !== 10) { pos = sPos + 6; continue; }
    var after = sPos + 6;
    if (after < raw.length && raw.charCodeAt(after) === 13) after++;
    if (after >= raw.length || raw.charCodeAt(after) !== 10) { pos = sPos + 6; continue; }
    after++;
    var endPos = raw.indexOf('endstream', after);
    if (endPos === -1) { pos = sPos + 6; continue; }
    onStream(raw.slice(after, endPos));
    count++;
    pos = endPos + 9;
  }
}

// ─── PDF hidden text stream scanner ──────────────────────────────────────────
// Scans raw PDF bytes for FlateDecode streams (bounded), then inspects
// each stream for invisible render mode (3 Tr), white fill, or zero font size.
function scanPdfHiddenText(rawBuf) {
  var flags = [];
  var MAX_STREAMS = 200;
  var MAX_INFLATED = 5 * 1024 * 1024;
  var totalInflated = 0;

  // Shared BT block processor (used for both Flate-decoded and raw streams).
  function processBtBlock(block, allowEmptyExcerpt) {
    var isInvisible = false;
    var kind = null;
    var note = null;
    if (/\b3\s+Tr\b/.test(block)) {
      isInvisible = true; kind = 'pdf_hidden_layer'; note = 'invisible render mode (3 Tr)';
    }
    if (!isInvisible && (/1\s+1\s+1\s+rg/.test(block) || /\b1\s+g\b/.test(block))) {
      isInvisible = true; kind = 'white_on_white'; note = 'white fill color operator';
    }
    if (!isInvisible && /\/\w+\s+0\s+Tf/.test(block)) {
      isInvisible = true; kind = 'pdf_hidden_layer'; note = 'zero font size (0 Tf)';
    }
    if (!isInvisible) return;
    var excerpts = [];
    var tjRe = /\(([^)]*)\)\s*Tj/g;
    var tjM;
    while ((tjM = tjRe.exec(block)) !== null) excerpts.push(tjM[1]);
    var tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
    while ((tjM = tjArrayRe.exec(block)) !== null) {
      var arr = tjM[1];
      var strRe = /\(([^)]*)\)/g;
      var sM;
      while ((sM = strRe.exec(arr)) !== null) excerpts.push(sM[1]);
    }
    var excerpt = excerpts.join('').slice(0, 200);
    if (excerpt || allowEmptyExcerpt) {
      flags.push({ kind: kind, excerpt: excerpt, note: note });
    }
  }

  var raw = rawBuf.toString('binary');

  // FlateDecode streams (indexOf-loop — replaces /FlateDecode[\s\S]*?endstream/g).
  var inflateCount = 0;
  findFlateDecodeStreams(raw, function (streamSlice) {
    if (totalInflated > MAX_INFLATED) return;
    var streamBytes = Buffer.from(streamSlice, 'binary');
    var inflated;
    try { inflated = zlib.inflateSync(streamBytes); }
    catch (e) { try { inflated = zlib.inflateRawSync(streamBytes); } catch (e2) { return; } }
    totalInflated += inflated.length;
    if (totalInflated > MAX_INFLATED) return;
    inflateCount++;
    var streamText = inflated.toString('utf8', 0, Math.min(inflated.length, 200000));
    // BT...ET blocks (indexOf-loop — replaces /BT[\s\S]*?ET/g).
    findBtEtBlocks(streamText, function (block) { processBtBlock(block, true); });
  }, MAX_STREAMS);

  // Uncompressed streams (indexOf-loop — replaces /^stream\r?\n[\s\S]*?endstream/gm).
  findRawStreams(raw, function (sText) {
    findBtEtBlocks(sText, function (block2) { processBtBlock(block2, false); });
  }, MAX_STREAMS);

  return flags;
}

// ─── pdf adapter ─────────────────────────────────────────────────────────────
var PDFTXT_BIN = null;
var PDFINFO_BIN = null;

function adaptPdf(content, options) {
  var tmpDir = null;
  var tmpFile = null;
  try {
    var hidden_text_flags = [];
    var extraction_notes = [];
    var text = '';
    var extraction = 'complete';

    // Resolve binaries once
    if (PDFTXT_BIN === null) PDFTXT_BIN = findBinary('pdftotext') || '';
    if (PDFINFO_BIN === null) PDFINFO_BIN = findBinary('pdfinfo') || '';

    // Normalize input to a file path
    var filePath = null;
    var ownedTmp = false;

    if (Buffer.isBuffer(content)) {
      var t = writeTempFile(content, '.pdf');
      tmpDir = t.tmpDir; tmpFile = t.tmpFile; filePath = tmpFile; ownedTmp = true;
    } else if (typeof content === 'string') {
      var s = content.trim();
      if (s.startsWith('%PDF')) {
        var t2 = writeTempFile(s, '.pdf');
        tmpDir = t2.tmpDir; tmpFile = t2.tmpFile; filePath = tmpFile; ownedTmp = true;
      } else if (s && fs.existsSync(s)) {
        filePath = s;
      } else if (s) {
        // String is not an existing file and doesn't start with %PDF — fail safely
        extraction_notes.push('pdf_adapter: content is not a valid file path or PDF data');
        return makeResult('', [],
          [{ kind: 'metadata_field', excerpt: '', note: 'pdf_adapter: content is not a valid file path or PDF data' }],
          'pdf', true, 'failed', extraction_notes
        );
      } else {
        extraction = 'failed';
        extraction_notes.push('pdf_adapter: no file path or content provided');
        return makeResult('', [], hidden_text_flags, 'pdf', true, extraction, extraction_notes);
      }
    } else {
      extraction = 'failed';
      extraction_notes.push('pdf_adapter: unsupported content type');
      return makeResult('', [], hidden_text_flags, 'pdf', true, extraction, extraction_notes);
    }

    // Validate path
    var v = validateFilePath(filePath);
    if (!v.ok) {
      extraction = 'failed';
      extraction_notes.push('path validation failed: ' + v.note);
      return makeResult('', [], hidden_text_flags, 'pdf', true, extraction, extraction_notes);
    }

    // Read raw bytes for stream scan (always, bounded)
    var rawBuf = null;
    try { rawBuf = fs.readFileSync(filePath); } catch (e) { extraction_notes.push('raw_read_failed: ' + e.message); }

    // Run pdftotext
    if (PDFTXT_BIN) {
      try {
        var buf = child_process.execFileSync(PDFTXT_BIN, ['-layout', '-enc', 'UTF-8', filePath, '-'], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
        text = buf.toString('utf8');
      } catch (e) {
        extraction = 'partial';
        extraction_notes.push('pdftotext_failed: ' + e.message);
      }
    } else {
      extraction = 'partial';
      extraction_notes.push('pdftotext_unavailable — stream scan only; low fidelity');
      hidden_text_flags.push({ kind: 'metadata_field', excerpt: '', note: 'pdftotext_unavailable — stream scan only; low fidelity' });
    }

    // Fallback: string scan of raw bytes
    if (!text && rawBuf) {
      var runs = [];
      var run = '';
      for (var i = 0; i < rawBuf.length; i++) {
        var b = rawBuf[i];
        if (b >= 0x20 && b <= 0x7E) { run += String.fromCharCode(b); }
        else { if (run.length >= 4) runs.push(run); run = ''; }
      }
      if (run.length >= 4) runs.push(run);
      text = runs.join(' ');
      if (extraction === 'complete') extraction = 'partial';
    }

    // pdfinfo metadata
    if (PDFINFO_BIN && filePath) {
      try {
        var infoBuf = child_process.execFileSync(PDFINFO_BIN, [filePath], { timeout: 5000, maxBuffer: 1 * 1024 * 1024 });
        var infoText = infoBuf.toString('utf8');
        var metaFields = ['Title', 'Subject', 'Keywords', 'Author', 'Creator', 'Producer'];
        metaFields.forEach(function (field) {
          var re = new RegExp('^' + field + ':\\s*(.+)$', 'm');
          var mm = infoText.match(re);
          if (mm && mm[1].trim()) {
            hidden_text_flags.push({ kind: 'metadata_field', excerpt: mm[1].trim(), note: 'pdfinfo field: ' + field });
          }
        });
      } catch (e) { extraction_notes.push('pdfinfo_failed: ' + e.message); }
    }

    // Annotation /Contents strings from raw bytes
    if (rawBuf) {
      var rawStr = rawBuf.toString('binary');
      var annotRe = /\/Contents\s*\(([^)]+)\)/g;
      var am;
      while ((am = annotRe.exec(rawStr)) !== null) {
        var excerpt = am[1].slice(0, 200);
        if (excerpt.trim()) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: excerpt, note: 'PDF annotation /Contents' });
        }
      }
    }

    // Hidden text stream scan
    if (rawBuf) {
      var hiddenFlags = scanPdfHiddenText(rawBuf);
      hidden_text_flags = hidden_text_flags.concat(hiddenFlags);
    }

    text = normalizeNFKC(text);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));
    text = collapseWhitespace(text);

    return makeResult(
      text,
      text ? [{ start: 0, end: text.length, source: 'retrieved', trust: 'untrusted' }] : [],
      hidden_text_flags, 'pdf', extraction !== 'complete', extraction, extraction_notes
    );
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'metadata_field', excerpt: '', note: 'pdf_adapter_error: ' + e.message }],
      'pdf', true, 'failed', [e.message]
    );
  } finally {
    if (tmpDir) cleanupTempDir(tmpDir);
  }
}

// ─── Email: decode quoted-printable ──────────────────────────────────────────
function decodeQuotedPrintable(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
}

// ─── Email: parse headers (including folded) ──────────────────────────────────
function parseEmailHeaders(headerSection) {
  var headers = {};
  // Unfold folded headers
  var unfolded = headerSection.replace(/\r?\n[ \t]+/g, ' ');
  unfolded.split(/\r?\n/).forEach(function (line) {
    var colon = line.indexOf(':');
    if (colon > 0) {
      var key = line.slice(0, colon).trim().toLowerCase();
      var val = line.slice(colon + 1).trim();
      if (!headers[key]) headers[key] = val;
    }
  });
  return headers;
}

// ─── Email: parse MIME parts recursively ─────────────────────────────────────
function parseMimeParts(raw, headers, depth, totalBytesRef) {
  var parts = [];
  var ct = headers['content-type'] || 'text/plain';

  // multipart
  var boundaryM = ct.match(/boundary\s*=\s*"([^"]+)"|boundary\s*=\s*(\S+)/i);
  if (boundaryM) {
    var boundary = boundaryM[1] || boundaryM[2];
    var delimiter = '--' + boundary;
    var lines = raw.split(/\r?\n/);
    var currentLines = [];
    var inPart = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith(delimiter + '--')) { break; }
      if (line.startsWith(delimiter)) {
        if (inPart && currentLines.length) {
          parts.push(currentLines.join('\n'));
        }
        currentLines = [];
        inPart = true;
      } else if (inPart) {
        currentLines.push(line);
      }
    }
    if (inPart && currentLines.length) parts.push(currentLines.join('\n'));
    return parts;
  }
  return [raw];
}

// ─── email adapter ────────────────────────────────────────────────────────────
function adaptEmail(content, options) {
  var tmpFiles = [];
  try {
    var raw = String(content == null ? '' : content);
    var hidden_text_flags = [];
    var textParts = [];
    var totalDecodedBytes = 0;
    var MAX_DECODED_BYTES = 10 * 1024 * 1024;
    var extraction_notes = [];

    function processEmailPart(partRaw, depth) {
      if (depth > 2) return;
      if (totalDecodedBytes > MAX_DECODED_BYTES) { extraction_notes.push('decoded byte cap reached'); return; }

      // Split headers from body
      var blankIdx = partRaw.search(/\r?\n\r?\n/);
      if (blankIdx < 0) { textParts.push(partRaw); return; }
      var headerSection = partRaw.slice(0, blankIdx);
      var bodySection = partRaw.slice(blankIdx).replace(/^\r?\n/, '');

      var headers = parseEmailHeaders(headerSection);
      var ct = (headers['content-type'] || 'text/plain').toLowerCase();
      var cte = (headers['content-transfer-encoding'] || '').toLowerCase().trim();
      var cdM = (headers['content-disposition'] || '').match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*(\S+)/i);
      var filename = cdM ? (cdM[1] || cdM[2] || '') : '';

      // Check domain mismatch on top-level only
      if (depth === 0) {
        var fromM2 = (headers['from'] || '').match(/@([\w.-]+)/);
        var replyM2 = (headers['reply-to'] || '').match(/@([\w.-]+)/);
        if (fromM2 && replyM2 && fromM2[1].toLowerCase() !== replyM2[1].toLowerCase()) {
          hidden_text_flags.push({ kind: 'email_header', excerpt: headers['reply-to'], note: 'reply-to-mismatch: From=' + fromM2[1] + ', Reply-To=' + replyM2[1] });
        }

        // Subject header
        var subject = headers['subject'] || '';
        if (subject.trim()) {
          textParts.push('[Subject] ' + subject.trim());
        }
      }

      // mailto scan
      var mailtoRe = /mailto:[^\s"'>]+/gi;
      var mm2;
      while ((mm2 = mailtoRe.exec(bodySection)) !== null) {
        if (/[?&](body|subject)=/i.test(mm2[0])) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: mm2[0], note: 'mailto: URI with pre-filled body/subject parameter' });
        }
      }

      // Decode body
      var decodedBody = bodySection;
      if (cte === 'quoted-printable') {
        decodedBody = decodeQuotedPrintable(bodySection);
      } else if (cte === 'base64') {
        try {
          var decoded = Buffer.from(bodySection.replace(/\s+/g, ''), 'base64').toString('utf8');
          totalDecodedBytes += decoded.length;
          var notePrefix = filename ? filename + ': ' : '';
          hidden_text_flags.push({ kind: 'base64_blob', excerpt: decoded.slice(0, 80), note: notePrefix + 'base64 Content-Transfer-Encoding decoded body part' });
          decodedBody = decoded;
        } catch (e) { decodedBody = bodySection; }
      }

      totalDecodedBytes += decodedBody.length;

      // Multipart
      if (ct.startsWith('multipart/')) {
        var subParts = parseMimeParts(decodedBody, headers, depth, { val: totalDecodedBytes });
        subParts.forEach(function (sp) { processEmailPart(sp, depth + 1); });
        return;
      }

      // text/html — recurse through html adapter
      if (ct.startsWith('text/html')) {
        var htmlResult = adaptHtml(decodedBody, options);
        var notePrefix2 = filename ? filename + ': ' : '';
        htmlResult.hidden_text_flags.forEach(function (f) {
          hidden_text_flags.push({ kind: f.kind, excerpt: f.excerpt, note: notePrefix2 + f.note });
        });
        textParts.push(htmlResult.text);
        return;
      }

      // PDF attachment
      if (ct.startsWith('application/pdf') && cte === 'base64' && depth <= 1) {
        try {
          var pdfBuf = Buffer.from(bodySection.replace(/\s+/g, ''), 'base64');
          var pdfResult = adaptPdf(pdfBuf, options);
          var notePrefix3 = filename ? filename + ': ' : 'attachment: ';
          pdfResult.hidden_text_flags.forEach(function (f) {
            hidden_text_flags.push({ kind: f.kind, excerpt: f.excerpt, note: notePrefix3 + f.note });
          });
          if (pdfResult.text) textParts.push(pdfResult.text);
        } catch (e) { extraction_notes.push('pdf_attachment_failed: ' + e.message); }
        return;
      }

      // DOCX attachment
      if ((ct.startsWith('application/vnd.openxmlformats') || ct.includes('docx')) && cte === 'base64' && depth <= 1) {
        try {
          var docxBuf = Buffer.from(bodySection.replace(/\s+/g, ''), 'base64');
          var docxResult = adaptWordDoc(docxBuf, options);
          var notePrefix4 = filename ? filename + ': ' : 'attachment: ';
          docxResult.hidden_text_flags.forEach(function (f) {
            hidden_text_flags.push({ kind: f.kind, excerpt: f.excerpt, note: notePrefix4 + f.note });
          });
          if (docxResult.text) textParts.push(docxResult.text);
        } catch (e) { extraction_notes.push('docx_attachment_failed: ' + e.message); }
        return;
      }

      // Quoted thread lines
      var lines2 = decodedBody.split(/\r?\n/);
      var quotedLines = [];
      var normalLines = [];
      lines2.forEach(function (line) {
        if (line.startsWith('>')) { quotedLines.push(line.slice(1).trim()); }
        else { normalLines.push(line); }
      });
      if (normalLines.length) textParts.push(normalLines.join('\n'));
      if (quotedLines.length) {
        textParts.push('[quoted-thread] ' + quotedLines.join(' '));
      }
    }

    processEmailPart(raw, 0);

    var text = textParts.join('\n').trim();
    text = normalizeNFKC(text);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));
    text = collapseWhitespace(text);

    return makeResult(
      text,
      text ? [{ start: 0, end: text.length, source: 'retrieved', trust: 'untrusted' }] : [],
      hidden_text_flags, 'email', false, 'complete', extraction_notes
    );
  } catch (e) {
    var raw2 = String(content == null ? '' : content);
    var bi = raw2.indexOf('\n\n');
    var body = bi >= 0 ? raw2.slice(bi + 2) : raw2;
    return makeResult(body,
      [{ start: 0, end: body.length, source: 'retrieved', trust: 'untrusted' }],
      [{ kind: 'metadata_field', excerpt: '', note: 'mime_parse_failed — raw body only' }],
      'email', true, 'partial', [e.message]
    );
  }
}

// ─── markdown adapter ─────────────────────────────────────────────────────────
function adaptMarkdown(content, options) {
  try {
    var md = String(content == null ? '' : content);
    var hidden_text_flags = [];
    var altTexts = [];

    // 1. HTML comments (indexOf loop — avoids [\s\S]*? ReDoS on '<!--'.repeat(n))
    md = extractBlocksExact(md, '<!--', '-->', function (comment) {
      hidden_text_flags.push({ kind: 'html_comment', excerpt: comment.trim(), note: 'Inline HTML comment in markdown body' });
    });

    // 2. Link-reference "comments": [//]: # (text) and [comment]: <> (text)
    md = md.replace(/^\[\/\/\]:\s*#\s*\(([^)]*)\)\s*$/gm, function (match, text) {
      if (text.trim()) {
        hidden_text_flags.push({ kind: 'html_comment', excerpt: text.trim(), note: 'Markdown link-reference comment [//]: # (...)' });
      }
      return '';
    });
    md = md.replace(/^\[comment\]:\s*<>\s*\(([^)]*)\)\s*$/gim, function (match, text) {
      if (text.trim()) {
        hidden_text_flags.push({ kind: 'html_comment', excerpt: text.trim(), note: 'Markdown link-reference comment [comment]: <> (...)' });
      }
      return '';
    });

    // 3. Image alt text — exclude '[' from char class so [![.repeat(n) fails O(1) per '!'
    md = md.replace(/!\[([^\]\[\n]{0,1000})\]\([^)\n]{0,2000}\)/g, function (match, alt) {
      if (alt.trim()) {
        altTexts.push('[ALT] ' + alt.trim());
        if (containsInjection(alt)) {
          hidden_text_flags.push({ kind: 'alt_text', excerpt: alt.trim(), note: 'Image alt text contains imperative injection phrase' });
        }
      }
      return '';
    });
    // Reference-style images: ![alt][ref] — exclude '[' from both classes
    md = md.replace(/!\[([^\]\[\n]{0,1000})\]\[[^\]\[\n]{0,1000}\]/g, function (match, alt) {
      if (alt.trim()) {
        altTexts.push('[ALT] ' + alt.trim());
        if (containsInjection(alt)) {
          hidden_text_flags.push({ kind: 'alt_text', excerpt: alt.trim(), note: 'Image alt text contains imperative injection phrase' });
        }
      }
      return '';
    });

    // 4. Reference-style link definitions: [label]: url
    md = md.replace(/^\[([^\]]*)\]:\s*(\S+).*$/gm, function (match, label, url) {
      if (/^(javascript:|data:)/i.test(url)) {
        hidden_text_flags.push({ kind: 'metadata_field', excerpt: url, note: 'Reference-style link with suspicious scheme: ' + url });
      }
      return '';
    });

    // 5. Raw HTML blocks — pass through html adapter (indexOf loop — avoids [\s\S]*? ReDoS)
    md = extractRawHtmlBlocks(md, function (block) {
      try {
        var htmlResult = adaptHtml(block, options);
        htmlResult.hidden_text_flags.forEach(function (f) {
          hidden_text_flags.push({ kind: f.kind, excerpt: f.excerpt, note: 'raw-html-block: ' + f.note });
        });
        return htmlResult.text || '';
      } catch (e) { return block.replace(/<[^<>]{0,4096}>/g, ''); }
    });

    // 6. Strip inline links — keep text — O(n) indexOf loop avoids {0,2000} backtracking
    // on "[a](" repeated (each failed match was O(2001) with the regex).
    md = (function stripInlineLinks(s) {
      var out = '';
      var pos = 0;
      while (pos < s.length) {
        var lb = s.indexOf('[', pos);
        if (lb === -1) { out += s.slice(pos); break; }
        // Find ']' that closes the label (no '[' or '\n' inside, cap 1000 chars)
        var rb = lb + 1;
        var labelOk = true;
        while (rb < s.length && rb - lb <= 1000) {
          var cc = s.charCodeAt(rb);
          if (cc === 93) break;      // ']'
          if (cc === 91 || cc === 10) { labelOk = false; break; } // '[' or '\n'
          rb++;
        }
        if (!labelOk || rb >= s.length || s.charCodeAt(rb) !== 93) {
          out += s.slice(pos, lb + 1); pos = lb + 1; continue;
        }
        // Must be followed by '('
        if (rb + 1 >= s.length || s.charCodeAt(rb + 1) !== 40) {
          out += s.slice(pos, lb + 1); pos = lb + 1; continue;
        }
        // Find closing ')' — scan forward up to 2000 chars, stop on '\n'
        var urlStart = rb + 2;
        var urlEnd = -1;
        var limit = Math.min(urlStart + 2000, s.length);
        for (var ui = urlStart; ui < limit; ui++) {
          var uc = s.charCodeAt(ui);
          if (uc === 41) { urlEnd = ui; break; }   // ')'
          if (uc === 10 || uc === 13) break;        // newline: fail
        }
        if (urlEnd === -1) { out += s.slice(pos, lb + 1); pos = lb + 1; continue; }
        // Valid link: keep label, discard [text](url)
        out += s.slice(pos, lb);
        out += s.slice(lb + 1, rb);
        pos = urlEnd + 1;
      }
      return out;
    }(md));

    // 7. Strip emphasis markers
    md = md.replace(/\*\*([^*]+)\*\*/g, '$1')
           .replace(/\*([^*]+)\*/g, '$1')
           .replace(/__([^_]+)__/g, '$1')
           .replace(/_([^_]+)_/g, '$1');

    // 8. Strip heading markers
    md = md.replace(/^#+\s+/gm, '');

    md = normalizeNFKC(md);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(md));

    var text = collapseWhitespace(md);
    if (altTexts.length) {
      text = (text ? text + '\n\n' : '') + altTexts.join('\n');
    }

    return makeResult(text,
      [{ start: 0, end: text.length, source: 'direct', trust: 'trusted' }],
      hidden_text_flags, 'markdown', false, 'complete', []
    );
  } catch (e) {
    return makeResult(String(content == null ? '' : content), [],
      [{ kind: 'metadata_field', excerpt: '', note: 'markdown_adapter_error: ' + e.message }],
      'markdown', true, 'failed', [e.message]
    );
  }
}

// ─── word_doc adapter ─────────────────────────────────────────────────────────
var UNZIP_BIN = null;

function extractXmlPart(zipPath, partName) {
  if (UNZIP_BIN === null) UNZIP_BIN = findBinary('unzip') || '/usr/bin/unzip';
  try {
    var buf = child_process.execFileSync(UNZIP_BIN, ['-p', zipPath, partName], { timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
    return buf.toString('utf8');
  } catch (e) { return null; }
}

function extractTextFromXml(xml) {
  if (!xml) return '';
  var parts = [];
  // indexOf-loop via extractXmlTagBlocks — replaces /<w:t[^>]*>[\s\S]*?<\/w:t>/g.
  extractXmlTagBlocks(xml, 'w:t', function (t) { parts.push(t); });
  return parts.join(' ');
}

function adaptWordDoc(content, options) {
  var tmpDir = null;
  var tmpFile = null;
  try {
    if (UNZIP_BIN === null) UNZIP_BIN = findBinary('unzip') || '/usr/bin/unzip';
    var hidden_text_flags = [];
    var extraction_notes = [];
    var text = '';
    var extraction = 'complete';
    var filePath = null;
    var ownedTmp = false;

    // Normalize input
    if (Buffer.isBuffer(content)) {
      var t = writeTempFile(content, '.docx');
      tmpDir = t.tmpDir; tmpFile = t.tmpFile; filePath = tmpFile; ownedTmp = true;
    } else if (typeof content === 'string') {
      var s = content.trim();
      if (s.startsWith('PK')) {
        var t2 = writeTempFile(Buffer.from(s, 'binary'), '.docx');
        tmpDir = t2.tmpDir; tmpFile = t2.tmpFile; filePath = tmpFile; ownedTmp = true;
      } else if (s && fs.existsSync(s)) {
        filePath = s;
      } else if (s) {
        // Not a valid file and not a PK-magic Buffer — fail safely
        extraction_notes.push('word_doc_adapter: content is not a valid file path or DOCX data');
        return makeResult('', [],
          [{ kind: 'metadata_field', excerpt: '', note: 'word_doc_adapter: content is not a valid file path or DOCX data' }],
          'word_doc', true, 'failed', extraction_notes
        );
      } else {
        extraction_notes.push('word_doc_adapter: no file path or content provided');
        return makeResult('', [], hidden_text_flags, 'word_doc', true, 'failed', extraction_notes);
      }
    } else {
      extraction_notes.push('word_doc_adapter: unsupported content type');
      return makeResult('', [], hidden_text_flags, 'word_doc', true, 'failed', extraction_notes);
    }

    // Validate path
    var v = validateFilePath(filePath);
    if (!v.ok) {
      extraction_notes.push('path validation failed: ' + v.note);
      return makeResult('', [], hidden_text_flags, 'word_doc', true, 'failed', extraction_notes);
    }

    // Check for legacy .doc (OLE magic D0 CF 11 E0)
    try {
      var header = Buffer.alloc(4);
      var fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, header, 0, 4, 0);
      fs.closeSync(fd);
      if (header[0] === 0xD0 && header[1] === 0xCF && header[2] === 0x11 && header[3] === 0xE0) {
        extraction_notes.push('legacy .doc held: no isolated converter');
        return makeResult('', [], [{ kind: 'metadata_field', excerpt: '', note: 'legacy .doc format; no isolated converter available' }], 'word_doc', true, 'failed', extraction_notes);
      }
    } catch (e) { extraction_notes.push('header_read_failed: ' + e.message); }

    // List parts with unzip -Z1
    var partList = [];
    try {
      var listBuf = child_process.execFileSync(UNZIP_BIN, ['-Z1', filePath], { timeout: 10000, maxBuffer: 1 * 1024 * 1024 });
      partList = listBuf.toString('utf8').split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    } catch (e) { extraction_notes.push('unzip_list_failed: ' + e.message); }

    // Check for vbaProject.bin (macro-enabled)
    if (partList.some(function (p) { return p === 'word/vbaProject.bin'; })) {
      hidden_text_flags.push({ kind: 'metadata_field', excerpt: '', note: 'macro-enabled document; macros never executed' });
    }

    // Extract main document.xml
    var docXml = extractXmlPart(filePath, 'word/document.xml');
    if (!docXml) {
      extraction = 'failed';
      extraction_notes.push('word/document.xml extraction failed');
      return makeResult('', [], [{ kind: 'metadata_field', excerpt: '', note: 'word/document.xml extraction failed' }], 'word_doc', true, extraction, extraction_notes);
    }

    // Body text: w:t runs that are NOT inside w:vanish
    var bodyParts = [];
    // Split into runs, detect vanish.
    // indexOf-loop via extractXmlTagBlocks — replaces /<w:r[^>]*>[\s\S]*?<\/w:r>/g
    // and the nested /<w:t[^>]*>[\s\S]*?<\/w:t>/g.
    extractXmlTagBlocks(docXml, 'w:r', function (runContent) {
      var isVanish = runContent.indexOf('<w:vanish') !== -1;
      var tParts = [];
      extractXmlTagBlocks(runContent, 'w:t', function (t) { tParts.push(t); });
      var runText = tParts.join('');
      if (isVanish && runText.trim()) {
        hidden_text_flags.push({ kind: 'docx_hidden_text', excerpt: runText.slice(0, 200), note: 'w:vanish hidden text run' });
      } else if (runText) {
        bodyParts.push(runText);
      }
    });
    text = bodyParts.join(' ');

    // Tracked deletions: w:del/w:delText.
    // indexOf-loops replace /<w:del[^>]*>[\s\S]*?<\/w:del>/g
    // and /<w:delText[^>]*>[\s\S]*?<\/w:delText>/g.
    extractXmlTagBlocks(docXml, 'w:del', function (delContent) {
      var delParts = [];
      extractXmlTagBlocks(delContent, 'w:delText', function (t) { delParts.push(t); });
      var delText = delParts.join('');
      if (delText.trim()) {
        hidden_text_flags.push({ kind: 'docx_track_changes', excerpt: delText.slice(0, 200), note: 'w:del tracked-change deletion' });
      }
    });

    // Tracked insertions: w:ins.
    // indexOf-loop replaces /<w:ins[^>]*>[\s\S]*?<\/w:ins>/g.
    // Collect w:t text inside each w:ins block instead of a tag-strip regex.
    extractXmlTagBlocks(docXml, 'w:ins', function (insContent) {
      var insParts = [];
      extractXmlTagBlocks(insContent, 'w:t', function (t) { insParts.push(t); });
      var insText = insParts.join(' ').trim();
      if (insText) {
        hidden_text_flags.push({ kind: 'docx_track_changes', excerpt: insText.slice(0, 200), note: 'w:ins tracked-change insertion' });
      }
    });

    // Comments
    var commentsXml = extractXmlPart(filePath, 'word/comments.xml');
    if (commentsXml) {
      // indexOf-loop replaces /<w:comment\b[^>]*>[\s\S]*?<\/w:comment>/g.
      extractXmlTagBlocks(commentsXml, 'w:comment', function (commentContent) {
        var cParts = [];
        extractXmlTagBlocks(commentContent, 'w:t', function (t) { cParts.push(t); });
        var commentText = cParts.join(' ').trim();
        if (commentText) {
          hidden_text_flags.push({ kind: 'docx_comment', excerpt: commentText.slice(0, 200), note: 'word/comments.xml comment body' });
        }
      });
    }

    // Headers and footers
    var headerFooterParts = partList.filter(function (p) {
      return /^word\/(header|footer)\d*\.xml$/.test(p);
    });
    headerFooterParts.forEach(function (part) {
      var xml = extractXmlPart(filePath, part);
      if (xml) {
        var hfText = extractTextFromXml(xml).trim();
        if (hfText) {
          text = text + ' [' + part.replace('word/', '').replace('.xml', '') + '] ' + hfText;
        }
      }
    });

    // Footnotes
    var footnotesXml = extractXmlPart(filePath, 'word/footnotes.xml');
    if (footnotesXml) {
      var fnText = extractTextFromXml(footnotesXml).trim();
      if (fnText) text = text + ' [footnotes] ' + fnText;
    }

    // Core and custom properties
    var coreXml = extractXmlPart(filePath, 'docProps/core.xml');
    if (coreXml) {
      var coreRe = /<dc:(title|subject|creator|keywords|description)>([\s\S]*?)<\/dc:\1>/g;
      var coreMm;
      while ((coreMm = coreRe.exec(coreXml)) !== null) {
        if (coreMm[2].trim()) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: coreMm[2].trim(), note: 'docProps/core.xml: ' + coreMm[1] });
        }
      }
    }

    var customXml = extractXmlPart(filePath, 'docProps/custom.xml');
    if (customXml) {
      var customRe = /<vt:[^>]+>([\s\S]*?)<\/vt:[^>]+>/g;
      var custMm;
      while ((custMm = customRe.exec(customXml)) !== null) {
        if (custMm[1].trim()) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: custMm[1].trim(), note: 'docProps/custom.xml property' });
        }
      }
    }

    text = normalizeNFKC(text);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));
    text = collapseWhitespace(text);

    return makeResult(
      text,
      text ? [{ start: 0, end: text.length, source: 'comment', trust: 'untrusted' }] : [],
      hidden_text_flags, 'word_doc', extraction !== 'complete', extraction, extraction_notes
    );
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'metadata_field', excerpt: '', note: 'word_doc_adapter_error: ' + e.message }],
      'word_doc', true, 'failed', [e.message]
    );
  } finally {
    if (tmpDir) cleanupTempDir(tmpDir);
  }
}

// ─── api_response adapter ─────────────────────────────────────────────────────
var SUSPICIOUS_KEY_RE = /^(system|instruction|prompt|context|role)$/i;

function adaptApiResponse(content, options) {
  try {
    var hidden_text_flags = [];
    var textParts = [];
    var parsed;

    try {
      parsed = JSON.parse(String(content == null ? '' : content));
    } catch (e) {
      var fallback = adaptUserMessage(String(content == null ? '' : content), options);
      fallback.source_type = 'api_response';
      fallback.provenance_zones = fallback.provenance_zones.map(function (z) {
        return { start: z.start, end: z.end, source: 'retrieved', trust: 'untrusted' };
      });
      fallback.hidden_text_flags.push({ kind: 'metadata_field', excerpt: '', note: 'api_response_json_parse_failed — plain text fallback' });
      fallback.extraction = fallback.extraction || 'complete';
      fallback.extraction_notes = fallback.extraction_notes || [];
      return fallback;
    }

    function walkJson(value, keyPath, depth) {
      if (depth > 20) return;
      if (typeof value === 'string') {
        textParts.push(value);
        var segs = keyPath.split(/[.\[\]]+/);
        var keyName = segs[segs.length - 1] || segs[segs.length - 2] || '';
        if (SUSPICIOUS_KEY_RE.test(keyName) && containsInjection(value)) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: value.slice(0, 200), note: 'JSON key path: ' + keyPath + ' — suspicious field name + imperative content' });
        }
        if (value.length > 500) {
          hidden_text_flags.push({ kind: 'metadata_field', excerpt: value.slice(0, 200), note: 'JSON key path: ' + keyPath + ' — string value exceeds 500 chars' });
        }
        if (isBase64(value.trim())) {
          hidden_text_flags.push({ kind: 'base64_blob', excerpt: value.slice(0, 80), note: 'JSON key path: ' + keyPath + ' — base64-like string value' });
        }
      } else if (Array.isArray(value)) {
        value.forEach(function (item, i) { walkJson(item, keyPath + '[' + i + ']', depth + 1); });
      } else if (value !== null && typeof value === 'object') {
        Object.keys(value).forEach(function (k) { walkJson(value[k], keyPath ? keyPath + '.' + k : k, depth + 1); });
      }
    }

    walkJson(parsed, '', 0);

    var text = textParts.join(' | ');
    text = normalizeNFKC(text);
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));
    text = collapseWhitespace(text);

    return makeResult(text,
      text ? [{ start: 0, end: text.length, source: 'retrieved', trust: 'untrusted' }] : [],
      hidden_text_flags, 'api_response', false, 'complete', []
    );
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'metadata_field', excerpt: '', note: 'api_response_adapter_error: ' + e.message }],
      'api_response', true, 'failed', [e.message]
    );
  }
}

// ─── ocr_text adapter ─────────────────────────────────────────────────────────
function adaptOcrText(content, options) {
  try {
    var text = String(content == null ? '' : content);
    var hidden_text_flags = [];

    hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: text.slice(0, 100), note: 'ocr_extracted — source image fidelity unknown' });

    text = normalizeNFKC(text);
    hidden_text_flags = hidden_text_flags.concat(scanHomoglyphs(text));
    hidden_text_flags = hidden_text_flags.concat(scanZeroWidth(text));

    var ctrlRe = /[\x00-\x08\x0B\x0C\x0E-\x1F]+/g;
    var cm;
    while ((cm = ctrlRe.exec(text)) !== null) {
      hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: text.slice(Math.max(0, cm.index - 5), Math.min(text.length, cm.index + 10)), note: 'Control characters at offset ' + cm.index });
    }

    var b64Re = /[A-Za-z0-9+\/]{40,}={0,2}/g;
    var bm;
    while ((bm = b64Re.exec(text)) !== null) {
      hidden_text_flags.push({ kind: 'base64_blob', excerpt: bm[0].slice(0, 80), note: 'Possible base64 blob at offset ' + bm.index });
    }

    text = collapseWhitespace(text);

    return makeResult(text,
      text ? [{ start: 0, end: text.length, source: 'retrieved', trust: 'untrusted' }] : [],
      hidden_text_flags, 'ocr_text', false, 'complete', []
    );
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'ocr_invisible', excerpt: '', note: 'ocr_text_adapter_error: ' + e.message }],
      'ocr_text', true, 'failed', [e.message]
    );
  }
}

// ─── source_code adapter ──────────────────────────────────────────────────────
function adaptSourceCode(content, options) {
  try {
    var code = String(content == null ? '' : content);
    var hidden_text_flags = [];
    var clean = code;

    // Block comment extractors — indexOf loops replace [\s\S]*? to avoid ReDoS
    clean = extractBlocksExact(clean, '/*', '*/', function (body) {
      var trimmed = body.trim();
      if (trimmed) {
        var isDoc = body.length > 0 && body[0] === '*';
        hidden_text_flags.push({ kind: 'comment', excerpt: trimmed.slice(0, 200), note: isDoc ? 'docstring' : 'Multi-line comment' });
      }
    });

    clean = extractBlocksExact(clean, '<!--', '-->', function (body) {
      var trimmed = body.trim();
      if (trimmed) { hidden_text_flags.push({ kind: 'comment', excerpt: trimmed.slice(0, 200), note: 'HTML-style comment' }); }
    });

    clean = extractBlocksExact(clean, '"""', '"""', function (body) {
      var trimmed = body.trim();
      if (trimmed) { hidden_text_flags.push({ kind: 'comment', excerpt: trimmed.slice(0, 200), note: 'docstring' }); }
    }, '""" """');

    clean = extractBlocksExact(clean, "'''", "'''", function (body) {
      var trimmed = body.trim();
      if (trimmed) { hidden_text_flags.push({ kind: 'comment', excerpt: trimmed.slice(0, 200), note: 'docstring' }); }
    }, '""" """');

    clean = clean.replace(/\/\/[^\n]*/g, function (comment) {
      var body = comment.slice(2).trim();
      if (body) { hidden_text_flags.push({ kind: 'comment', excerpt: body.slice(0, 200), note: 'Single-line comment' }); }
      return '';
    });

    clean = clean.replace(/#[^\n]*/g, function (comment) {
      var body = comment.slice(1).trim();
      if (body && body.charAt(0) !== '!') { hidden_text_flags.push({ kind: 'comment', excerpt: body.slice(0, 200), note: 'Single-line comment' }); }
      return '';
    });

    clean = clean.replace(/--[^\n]*/g, function (comment) {
      var body = comment.slice(2).trim();
      if (body) { hidden_text_flags.push({ kind: 'comment', excerpt: body.slice(0, 200), note: 'Single-line comment (--)' }); }
      return '';
    });

    clean = clean.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, function (literal) {
      var body = literal.slice(1, -1);
      var trimmed = body.trim();
      if (isBase64(trimmed)) {
        var decoded = '';
        try { decoded = Buffer.from(trimmed, 'base64').toString('utf8'); } catch (e) {}
        hidden_text_flags.push({ kind: 'base64_blob', excerpt: body.slice(0, 80), note: "Decoded: '" + decoded.slice(0, 80) + "'" });
      } else if (body.length > 256 && containsInjection(body)) {
        hidden_text_flags.push({ kind: 'metadata_field', excerpt: body.slice(0, 200), note: 'String literal >256 chars with injection phrase' });
      }
      return literal;
    });

    var text = collapseWhitespace(clean);

    return makeResult(text,
      text ? [{ start: 0, end: text.length, source: 'direct', trust: 'trusted' }] : [],
      hidden_text_flags, 'source_code', false, 'complete', []
    );
  } catch (e) {
    return makeResult(String(content == null ? '' : content), [],
      [{ kind: 'metadata_field', excerpt: '', note: 'source_code_adapter_error: ' + e.message }],
      'source_code', true, 'failed', [e.message]
    );
  }
}

// ─── image_via_ocr adapter ────────────────────────────────────────────────────
var TESSERACT_BIN = null;

function adaptImageViaOcr(content, options) {
  var tmpDir = null;
  var tmpFile = null;
  try {
    var hidden_text_flags = [];
    var extraction_notes = [];

    // Resolve tesseract once
    if (TESSERACT_BIN === null) {
      TESSERACT_BIN = findBinary('tesseract') || '';
    }

    if (!TESSERACT_BIN) {
      hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: '', note: 'tesseract_unavailable — ocr_required; no text extracted from image' });
      return makeResult('', [], hidden_text_flags, 'image_via_ocr', true, 'failed', ['tesseract_unavailable']);
    }

    // Normalize input to a file path
    var filePath = null;

    if (Buffer.isBuffer(content)) {
      var t = writeTempFile(content, '.png');
      tmpDir = t.tmpDir; tmpFile = t.tmpFile; filePath = tmpFile;
    } else if (typeof content === 'string') {
      var s = content.trim();
      if (s && fs.existsSync(s)) {
        filePath = s;
      } else if (s) {
        // String doesn't exist as a file — fail safely (not pre-extracted text for an image adapter)
        hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: '', note: 'image_via_ocr: content is not a valid file path' });
        return makeResult('', [], hidden_text_flags, 'image_via_ocr', true, 'failed', ['content is not a valid file path']);
      } else {
        hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: '', note: 'image_via_ocr: no file path provided' });
        return makeResult('', [], hidden_text_flags, 'image_via_ocr', true, 'failed', ['no file path provided']);
      }
    } else {
      hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: '', note: 'image_via_ocr: unsupported content type' });
      return makeResult('', [], hidden_text_flags, 'image_via_ocr', true, 'failed', ['unsupported content type']);
    }

    // Validate path (20 MB limit for images)
    var v = validateFilePath(filePath, MAX_IMAGE_BYTES);
    if (!v.ok) {
      extraction_notes.push('path validation failed: ' + v.note);
      return makeResult('', [], [{ kind: 'ocr_invisible', excerpt: '', note: 'image_via_ocr: ' + v.note }], 'image_via_ocr', true, 'failed', extraction_notes);
    }

    // Run tesseract in TSV mode to get confidence scores
    try {
      var tsvBuf = child_process.execFileSync(TESSERACT_BIN, [filePath, 'stdout', 'tsv'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      var tsvText = tsvBuf.toString('utf8');

      // Parse TSV: level, page_num, block_num, par_num, line_num, word_num, left, top, width, height, conf, text
      var lines = tsvText.split('\n');
      var words = [];
      var confidences = [];
      var currentLine = [];
      var lastLineNum = -1;
      var lastParNum = -1;
      var lastBlockNum = -1;

      for (var i = 1; i < lines.length; i++) {
        var parts = lines[i].split('\t');
        if (parts.length < 12) continue;
        var level = parseInt(parts[0], 10);
        var blockNum = parseInt(parts[2], 10);
        var parNum = parseInt(parts[3], 10);
        var lineNum = parseInt(parts[4], 10);
        var conf = parseFloat(parts[10]);
        var word = parts[11] ? parts[11].trim() : '';

        if (level === 5 && word) {
          if (conf >= 0) confidences.push(conf);
          // Group by line
          if (lineNum !== lastLineNum || parNum !== lastParNum || blockNum !== lastBlockNum) {
            if (currentLine.length) words.push(currentLine.join(' '));
            currentLine = [word];
            lastLineNum = lineNum; lastParNum = parNum; lastBlockNum = blockNum;
          } else {
            currentLine.push(word);
          }
        }
      }
      if (currentLine.length) words.push(currentLine.join(' '));

      var ocrText = words.join('\n');

      // Mean confidence
      var meanConf = 0;
      if (confidences.length > 0) {
        meanConf = confidences.reduce(function (a, b) { return a + b; }, 0) / confidences.length;
      }

      if (confidences.length > 0 && meanConf < 60) {
        hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: ocrText.slice(0, 100), note: 'low OCR confidence ' + meanConf.toFixed(1) });
      }

      // Pass through ocr_text logic
      var result = adaptOcrText(ocrText, options);
      result.source_type = 'image_via_ocr';
      result.hidden_text_flags = hidden_text_flags.concat(result.hidden_text_flags);
      result.extraction = 'complete';
      result.extraction_notes = extraction_notes;
      return result;
    } catch (e) {
      hidden_text_flags.push({ kind: 'ocr_invisible', excerpt: '', note: 'tesseract_error: ' + e.message });
      return makeResult('', [], hidden_text_flags, 'image_via_ocr', true, 'failed', ['tesseract_error: ' + e.message]);
    }
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'ocr_invisible', excerpt: '', note: 'image_via_ocr_adapter_error: ' + e.message }],
      'image_via_ocr', true, 'failed', [e.message]
    );
  } finally {
    if (tmpDir) cleanupTempDir(tmpDir);
  }
}

// ─── Input size cap ───────────────────────────────────────────────────────────
var MAX_ADAPT_INPUT = 2 * 1024 * 1024; // 2 MB

// ─── Dispatch table ───────────────────────────────────────────────────────────
var ADAPTERS = {
  user_message:  adaptUserMessage,
  web_page:      adaptWebPage,
  pdf:           adaptPdf,
  email:         adaptEmail,
  markdown:      adaptMarkdown,
  html:          adaptHtml,
  word_doc:      adaptWordDoc,
  api_response:  adaptApiResponse,
  ocr_text:      adaptOcrText,
  source_code:   adaptSourceCode,
  image_via_ocr: adaptImageViaOcr
};

function adapt(content, source_type, options) {
  options = options || {};
  // 2 MB input cap — truncate strings only (Buffers handled per-adapter)
  var truncated = false;
  if (typeof content === 'string' && content.length > MAX_ADAPT_INPUT) {
    content = content.slice(0, MAX_ADAPT_INPUT);
    truncated = true;
  }
  var fn = ADAPTERS[source_type];
  if (!fn) {
    var raw = String(content == null ? '' : content);
    return makeResult(raw,
      raw ? [{ start: 0, end: raw.length, source: 'retrieved', trust: 'untrusted' }] : [],
      [{ kind: 'metadata_field', excerpt: '', note: 'unknown_source_type: ' + source_type }],
      source_type || 'unknown', true, 'failed', ['unknown_source_type']
    );
  }
  try {
    var result = fn(content, options);
    if (truncated) {
      result.extraction = 'partial';
      result.extraction_notes = (result.extraction_notes || []).concat(['input_truncated_to_2MB']);
    }
    return result;
  } catch (e) {
    return makeResult('', [],
      [{ kind: 'metadata_field', excerpt: '', note: 'adapter_threw: ' + e.message }],
      source_type, true, 'failed', [e.message]
    );
  }
}

module.exports = { adapt: adapt, SOURCES: SOURCES };
