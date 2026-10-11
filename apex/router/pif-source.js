'use strict';

const path = require('path');
const fs = require('fs');

// ─── Magic byte signatures ─────────────────────────────────────────────────────
const MAGIC_ENTRIES = [
  // PDF
  { magic: Buffer.from('%PDF'), source: 'pdf' },
  // OLE2 compound document (legacy .doc)
  { magic: Buffer.from([0xD0, 0xCF, 0x11, 0xE0]), source: 'word_doc' },
  // PNG
  { magic: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), source: 'image_via_ocr' },
  // JPEG (FF D8)
  { magic: Buffer.from([0xFF, 0xD8]), source: 'image_via_ocr' },
  // GIF87a or GIF89a
  { magic: Buffer.from('GIF8'), source: 'image_via_ocr' },
  // BMP
  { magic: Buffer.from('BM'), source: 'image_via_ocr' },
  // TIFF little-endian
  { magic: Buffer.from([0x49, 0x49, 0x2A, 0x00]), source: 'image_via_ocr' },
  // TIFF big-endian
  { magic: Buffer.from([0x4D, 0x4D, 0x00, 0x2A]), source: 'image_via_ocr' },
  // ZIP (PK\x03\x04) — handled separately to check for DOCX
  { magic: Buffer.from([0x50, 0x4B, 0x03, 0x04]), source: '_zip' },
];

function isWebp(buf) {
  if (!buf || buf.length < 12) return false;
  return buf.slice(0, 4).toString('ascii') === 'RIFF' &&
         buf.slice(8, 12).toString('ascii') === 'WEBP';
}

function matchMagic(buf) {
  if (!buf || buf.length === 0) return null;
  if (isWebp(buf)) return 'image_via_ocr';
  for (var i = 0; i < MAGIC_ENTRIES.length; i++) {
    var entry = MAGIC_ENTRIES[i];
    if (buf.length < entry.magic.length) continue;
    if (buf.slice(0, entry.magic.length).equals(entry.magic)) {
      if (entry.source === '_zip') {
        // DOCX is a ZIP containing word/document.xml
        try {
          var str = buf.toString('binary');
          if (str.indexOf('word/document.xml') !== -1) return 'word_doc';
        } catch (e) {}
        return null; // generic ZIP, not word_doc
      }
      return entry.source;
    }
  }
  return null;
}

// ─── Extension map ────────────────────────────────────────────────────────────
var CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.sql', '.lua', '.swift',
  '.scala', '.pl', '.r'
]);

// Exported for tests
var SOURCE_BY_EXT = {
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.eml': 'email',
  '.json': 'api_response', '.jsonl': 'api_response', '.ndjson': 'api_response',
  '.txt': 'markdown', '.log': 'markdown',
};

function sourceByExtension(filePath) {
  var base = path.basename(filePath);
  // ocr.txt special case (must check before normal ext)
  if (base.endsWith('.ocr.txt')) return 'ocr_text';

  var ext = path.extname(filePath.toLowerCase());
  if (SOURCE_BY_EXT[ext]) return SOURCE_BY_EXT[ext];
  if (CODE_EXTS.has(ext)) return 'source_code';
  return 'markdown';
}

// ─── Content sniffers ─────────────────────────────────────────────────────────
var RFC822_HEADER_RE = /^(From|Received|Return-Path|Subject|To|Date|Message-ID|MIME-Version):\s/i;

function sniffEmail(text) {
  if (!text) return false;
  var lines = text.slice(0, 2000).split('\n');
  var hdrCount = 0;
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      return hdrCount >= 2; // blank line after headers
    }
    if (RFC822_HEADER_RE.test(lines[i])) hdrCount++;
  }
  return false;
}

function sniffHtml(text) {
  if (!text) return false;
  var s = text.slice(0, 1000);
  return /<html[\s>]/i.test(s) || /<!doctype\s+html/i.test(s) ||
         /<head[\s>]/i.test(s) || /<body[\s>]/i.test(s);
}

function sniffText(text) {
  if (!text) return null;
  try {
    JSON.parse(text.trim());
    return 'api_response';
  } catch (e) {}
  if (sniffHtml(text)) return 'html';
  if (sniffEmail(text)) return 'email';
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * inferSource({ path, buffer, text, tool_name, tool_input }) -> source id string
 *
 * Priority: tool identity (WebFetch/WebSearch first) > magic bytes > file
 * extension > content sniffing > tool type fallback.
 */
function inferSource(opts) {
  opts = opts || {};
  var filePath = opts.path || null;
  var buf = (opts.buffer && Buffer.isBuffer(opts.buffer) && opts.buffer.length > 0)
    ? opts.buffer : null;
  var text = opts.text || null;
  var toolName = opts.tool_name || '';
  var toolInput = opts.tool_input || {};

  // ── Tool identity (highest priority) ──────────────────────────────────────
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return 'web_page';

  // ── Bash: inspect command ─────────────────────────────────────────────────
  if (toolName === 'Bash') {
    var cmd = (typeof toolInput === 'string'
      ? toolInput
      : (toolInput.command || '')).toString();

    // curl/wget or http(s) URL in command
    if (/\bcurl\b|\bwget\b/i.test(cmd) || /https?:\/\//i.test(cmd)) {
      if (text) {
        try {
          JSON.parse(text.trim());
          return 'api_response';
        } catch (e) {}
      }
      return 'web_page';
    }

    // "cat <file>" -> infer from that filename
    var catM = cmd.match(/\bcat\s+["']?([^\s"'>|&;]+)["']?/);
    if (catM) return sourceByExtension(catM[1]);

    // Other Bash -> sniff, then markdown
    var sniffed = text ? sniffText(text) : null;
    return sniffed || 'markdown';
  }

  // ── Magic bytes ───────────────────────────────────────────────────────────
  if (buf) {
    var magic = matchMagic(buf);
    if (magic) return magic;
  }

  // ── Path-based ────────────────────────────────────────────────────────────
  if (filePath) {
    // Try reading magic bytes when no buffer provided
    if (!buf) {
      try {
        var stat = fs.statSync(filePath);
        if (stat.isFile() && stat.size > 0) {
          var fd = fs.openSync(filePath, 'r');
          var head = Buffer.alloc(Math.min(512, stat.size));
          var bytesRead = fs.readSync(fd, head, 0, head.length, 0);
          fs.closeSync(fd);
          if (bytesRead > 0) {
            var m = matchMagic(head.slice(0, bytesRead));
            if (m) return m;
          }
        }
      } catch (e) {
        // Fall through to extension
      }
    }
    return sourceByExtension(filePath);
  }

  // ── MCP: sniff then default api_response ─────────────────────────────────
  if (/^mcp__/.test(toolName)) {
    var s2 = text ? sniffText(text) : null;
    return s2 || 'api_response';
  }

  // ── Text sniffing as last resort ─────────────────────────────────────────
  if (text) {
    var s3 = sniffText(text);
    if (s3) return s3;
  }

  return 'markdown';
}

module.exports = { inferSource, SOURCE_BY_EXT };
