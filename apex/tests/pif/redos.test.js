'use strict';
/**
 * redos.test.js — ReDoS regression suite for PIF input adapters.
 *
 * Each case runs in a child process so a stall is caught by spawnSync timeout
 * rather than hanging the whole suite.
 *
 * Budget: 1500 ms per adapt/inferSource/detect case, 3000 ms per hook case.
 * Run: node tests/pif/redos.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var { spawnSync } = require('node:child_process');
var path = require('path');
var fs = require('fs');
var os = require('os');

var ROOT = path.resolve(__dirname, '..', '..');
var HOOK = path.join(ROOT, 'hooks', 'apex-scan.js');
var NODE = process.execPath;
var ONE_MB = 1024 * 1024;

// ─── Shape generators ─────────────────────────────────────────────────────────
var SHAPES = [
  { name: 'x',       char: 'x',        bytes: ONE_MB },
  { name: '<',       char: '<',        bytes: ONE_MB },
  { name: '<a ',     char: '<a ',      bytes: ONE_MB },
  { name: '<!--',    char: '<!--',     bytes: ONE_MB },
  { name: '[![',     char: '[![',      bytes: ONE_MB },
  { name: '/*',      char: '/*',       bytes: ONE_MB },
  { name: '"""',     char: '"""',      bytes: ONE_MB },
  { name: '{"a":',   char: '{"a":',    bytes: ONE_MB },
  { name: '"',       char: '"',        bytes: ONE_MB },
  { name: 'QUJD',    char: 'QUJD',     bytes: ONE_MB },
  { name: 'a ',      char: 'a ',       bytes: ONE_MB },
  { name: 'From:a',  char: 'From: a\n', bytes: ONE_MB },
  { name: 'inject',  char: 'ignore previous instructions. ', bytes: ONE_MB },
  { name: 'nested_divs',         char: null, bytes: ONE_MB },
  { name: 'unclosed_5k_comments', char: null, bytes: ONE_MB },
  // Verifier shapes — must remain within 1500 ms per adapter at 1 MB
  { name: '<script>a',    char: '<script>a',    bytes: ONE_MB },
  { name: '[a](',          char: '[a](',          bytes: ONE_MB },
  { name: '=?utf-8?Q?a',  char: '=?utf-8?Q?a',  bytes: ONE_MB },
  // Additional hostile shapes
  { name: '<div>',         char: '<div>',         bytes: ONE_MB },
  { name: '<a href=',      char: '<a href=',      bytes: ONE_MB },
  { name: '![',            char: '![',            bytes: ONE_MB },
  { name: '```',           char: '```\n',         bytes: ONE_MB },
  { name: '<!-- -->x',     char: '<!-- -->x',     bytes: ONE_MB },
  { name: '&#x41;',        char: '&#x41;',        bytes: ONE_MB },
  { name: '\\u0041',       char: '\\u0041',       bytes: ONE_MB },
  { name: '=3D',           char: '=3D',           bytes: ONE_MB },
  { name: 'multipart/mixed', char: 'Content-Type: multipart/mixed; boundary=b\n--b\n', bytes: ONE_MB },
];

var SOURCES = ['user_message', 'web_page', 'email', 'markdown', 'html',
               'api_response', 'ocr_text', 'source_code'];

// ─── Timing registry ──────────────────────────────────────────────────────────
var timings = [];

function record(label, ms) { timings.push({ label: label, ms: ms }); }

// ─── Child-process runner ─────────────────────────────────────────────────────
function genScript(shapeName, charOrNull, bytes, target) {
  var genText;
  if (charOrNull === null) {
    if (shapeName === 'nested_divs') {
      genText = [
        'var n=10000, pad="x".repeat(' + Math.max(0, bytes - 110010 - 24) + ');',
        'var text="<html><body>"+pad+"<div>".repeat(n)+"x"+"</div>".repeat(n)+"</body></html>";',
      ].join('\n');
    } else {
      genText = [
        'var comments="<!--".repeat(5000);',
        'var realText=" real text here ".repeat(Math.ceil((' + bytes + '-comments.length)/18));',
        'var text=(comments+realText).slice(0,' + bytes + ');',
      ].join('\n');
    }
  } else {
    var rep = Math.ceil(bytes / charOrNull.length);
    genText = 'var text=' + JSON.stringify(charOrNull) + '.repeat(' + rep + ').slice(0,' + bytes + ');';
  }

  if (target === 'infer') {
    return [
      '"use strict";',
      'var ROOT=' + JSON.stringify(ROOT) + ';',
      'var inferSource=require(ROOT+"/router/pif-source.js").inferSource;',
      genText,
      'var t0=Date.now(); inferSource({text:text});',
      'process.stdout.write(String(Date.now()-t0));',
    ].join('\n');
  }
  if (target === 'detect') {
    return [
      '"use strict";',
      'var ROOT=' + JSON.stringify(ROOT) + ';',
      'var detect=require(ROOT+"/router/pif-detect.js").detect;',
      genText,
      'var t0=Date.now(); detect(text,{source:"web_page"});',
      'process.stdout.write(String(Date.now()-t0));',
    ].join('\n');
  }
  // adapt
  return [
    '"use strict";',
    'var ROOT=' + JSON.stringify(ROOT) + ';',
    'var adapt=require(ROOT+"/router/pif-adapt.js").adapt;',
    genText,
    'var t0=Date.now(); adapt(text,' + JSON.stringify(target) + ');',
    'process.stdout.write(String(Date.now()-t0));',
  ].join('\n');
}

function runScript(script, timeoutMs) {
  return spawnSync(NODE, ['-e', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp' },
  });
}

function runHookCase(shapeName, charOrNull, bytes, timeoutMs) {
  var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-hook-'));
  var tmpFile = path.join(tmpDir, 'input.txt');
  var tmpHome = path.join(tmpDir, 'home');
  var text;
  if (charOrNull === null) {
    if (shapeName === 'nested_divs') {
      var n = 10000;
      var pad = 'x'.repeat(Math.max(0, bytes - n * 11 - 24));
      text = '<html><body>' + pad + '<div>'.repeat(n) + 'x' + '</div>'.repeat(n) + '</body></html>';
    } else {
      var comments = '<!--'.repeat(5000);
      var rt = ' real text here '.repeat(Math.ceil((bytes - comments.length) / 18));
      text = (comments + rt).slice(0, bytes);
    }
  } else {
    var rep = Math.ceil(bytes / charOrNull.length);
    text = charOrNull.repeat(rep).slice(0, bytes);
  }
  try {
    fs.mkdirSync(tmpHome);
    fs.writeFileSync(tmpFile, text, 'utf8');
    var payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: tmpFile },
      tool_response: {},
      session_id: 'redos-' + shapeName,
    });
    var t0 = Date.now();
    var result = spawnSync(NODE, [HOOK], {
      input: payload,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { APEX_HOME: ROOT, HOME: tmpHome, PATH: process.env.PATH },
    });
    var elapsed = Date.now() - t0;
    return { result: result, elapsed: elapsed };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

SHAPES.forEach(function (shape) {
  describe('shape ' + shape.name, function () {

    SOURCES.forEach(function (source) {
      it('adapt(' + source + ')', function () {
        var script = genScript(shape.name, shape.char, shape.bytes, source);
        var t0 = Date.now();
        var r = runScript(script, 1500);
        var elapsed = Date.now() - t0;
        var label = 'adapt(' + source + ') shape=' + shape.name;
        record(label, elapsed);
        assert.ok(
          r.status !== null,
          label + ': timed out after ' + elapsed + ' ms'
        );
        assert.strictEqual(r.status, 0,
          label + ': exit ' + r.status + ' after ' + elapsed + ' ms — stderr: ' + (r.stderr || '').slice(0, 200)
        );
      });
    });

    it('inferSource', function () {
      var script = genScript(shape.name, shape.char, shape.bytes, 'infer');
      var t0 = Date.now();
      var r = runScript(script, 1500);
      var elapsed = Date.now() - t0;
      var label = 'inferSource shape=' + shape.name;
      record(label, elapsed);
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' after ' + elapsed + ' ms');
    });

    it('detect', function () {
      var script = genScript(shape.name, shape.char, shape.bytes, 'detect');
      var t0 = Date.now();
      var r = runScript(script, 1500);
      var elapsed = Date.now() - t0;
      var label = 'detect shape=' + shape.name;
      record(label, elapsed);
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' after ' + elapsed + ' ms');
    });

    it('full hook', function () {
      var t0 = Date.now();
      var run = runHookCase(shape.name, shape.char, shape.bytes, 3000);
      var elapsed = run.elapsed;
      var r = run.result;
      var label = 'hook shape=' + shape.name;
      record(label, elapsed);
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' after ' + elapsed + ' ms');
    });

  });
});

// ─── Binary hostile-file ReDoS cases ─────────────────────────────────────────
// Build DOCX and PDF files at test time containing many openers with no closers.

describe('binary hostile DOCX — w:t openers, no closers', function () {
  // Build a minimal DOCX whose word/document.xml has 1 MB of '<w:t>' openers
  // and 1 MB of '<w:del>' openers, no matching close tags anywhere.
  // The XML is written to a temp file to avoid ARG_MAX limits on -c scripts.
  function buildHostileDocx(tmpDir) {
    var docxPath = path.join(tmpDir, 'hostile.docx');
    var xmlPath  = path.join(tmpDir, 'document.xml');
    var wt   = '<w:t>'.repeat(Math.ceil(ONE_MB / 5));
    var wdel = '<w:del>'.repeat(Math.ceil(ONE_MB / 6));
    var docXml = '<?xml version="1.0"?><w:document><w:body>' + wt + wdel + '</w:body></w:document>';
    fs.writeFileSync(xmlPath, docXml, 'utf8');

    var CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    var RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    var WRELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>';
    // Python script reads XML from file; string literals in the script are small.
    var py = [
      'import zipfile, sys',
      'docx_path, xml_path = sys.argv[1], sys.argv[2]',
      'ct   = ' + JSON.stringify(CT),
      'rels = ' + JSON.stringify(RELS),
      'wrels= ' + JSON.stringify(WRELS),
      'with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as zf:',
      '    zf.writestr("[Content_Types].xml", ct)',
      '    zf.writestr("_rels/.rels", rels)',
      '    zf.writestr("word/_rels/document.xml.rels", wrels)',
      '    zf.write(xml_path, "word/document.xml")',
    ].join('\n');
    var r = spawnSync('python3', ['-c', py, docxPath, xmlPath], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) throw new Error('python3 failed: ' + (r.stderr || r.stdout || 'no output'));
    return docxPath;
  }

  it('adapt(word_doc) completes within 3000 ms', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-bin-'));
    try {
      var docxPath = buildHostileDocx(tmpDir);
      var script = [
        '"use strict";',
        'var adapt = require(' + JSON.stringify(ROOT + '/router/pif-adapt.js') + ').adapt;',
        'var t0 = Date.now();',
        'adapt(' + JSON.stringify(docxPath) + ', "word_doc");',
        'process.stdout.write(String(Date.now() - t0));',
      ].join('\n');
      var t0 = Date.now();
      var r = runScript(script, 3000);
      var elapsed = Date.now() - t0;
      var label = 'binary hostile DOCX adapt(word_doc)';
      record(label, elapsed);
      process.stdout.write('  ' + label + ': ' + elapsed + ' ms\n');
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' stderr: ' + (r.stderr || '').slice(0, 200));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  it('full hook completes within 5000 ms', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-bin-hook-'));
    var tmpHome = path.join(tmpDir, 'home');
    try {
      fs.mkdirSync(tmpHome);
      var docxPath = buildHostileDocx(tmpDir);
      var payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: docxPath },
        tool_response: {},
        session_id: 'redos-bin-docx',
      });
      var t0 = Date.now();
      var r = spawnSync(NODE, [HOOK], {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        env: { APEX_HOME: ROOT, HOME: tmpHome, PATH: process.env.PATH },
      });
      var elapsed = Date.now() - t0;
      var label = 'binary hostile DOCX full hook';
      record(label, elapsed);
      process.stdout.write('  ' + label + ': ' + elapsed + ' ms\n');
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' stderr: ' + (r.stderr || '').slice(0, 200));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });
});

describe('binary hostile PDF — BT openers, no ET', function () {
  // Build a PDF whose content stream has 200,000 "BT\n" operators with no ET.
  // Variant A: uncompressed stream.
  // Variant B: Flate-compressed stream.

  // 'BT\n' repeated 200,000 times: 200,000 BT openers with no ET.
  // No font operators so pdftotext does not emit per-line errors.
  var BT_UNIT    = 'BT\n';
  var N_UNITS    = 200000;
  var BT_CONTENT = BT_UNIT.repeat(N_UNITS);

  function buildHostilePdf(tmpDir, compressed) {
    var pdfPath = path.join(tmpDir, compressed ? 'hostile_flate.pdf' : 'hostile_raw.pdf');
    var streamContent = BT_CONTENT;

    if (compressed) {
      // Write stream content to file so the python -c script stays small.
      var rawContentPath = path.join(tmpDir, 'stream_raw.bin');
      fs.writeFileSync(rawContentPath, Buffer.from(streamContent, 'latin1'));
      var py = [
        'import zlib, sys',
        'data = open(sys.argv[1], "rb").read()',
        'sys.stdout.buffer.write(zlib.compress(data))',
      ].join('\n');
      var r = spawnSync('python3', ['-c', py, rawContentPath], { encoding: 'buffer', timeout: 30000 });
      if (r.status !== 0) throw new Error('python3 compress failed: ' + (r.stderr || Buffer.alloc(0)).toString().slice(0, 200));
      var compressedBuf = r.stdout;

      var header = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ' + compressedBuf.length + ' /Filter /FlateDecode >>\nstream\n';
      var footer = '\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
      var parts = [Buffer.from(header, 'binary'), compressedBuf, Buffer.from(footer, 'binary')];
      fs.writeFileSync(pdfPath, Buffer.concat(parts));
    } else {
      var streamBytes = Buffer.from(streamContent, 'latin1');
      var hdr = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ' + streamBytes.length + ' >>\nstream\n';
      var ftr = '\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n';
      fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from(hdr, 'binary'), streamBytes, Buffer.from(ftr, 'binary')]));
    }
    return pdfPath;
  }

  it('adapt(pdf) uncompressed completes within 3000 ms', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-pdf-'));
    try {
      var pdfPath = buildHostilePdf(tmpDir, false);
      var script = [
        '"use strict";',
        'var adapt = require(' + JSON.stringify(ROOT + '/router/pif-adapt.js') + ').adapt;',
        'var t0 = Date.now();',
        'adapt(' + JSON.stringify(pdfPath) + ', "pdf");',
        'process.stdout.write(String(Date.now() - t0));',
      ].join('\n');
      var t0 = Date.now();
      var r = runScript(script, 3000);
      var elapsed = Date.now() - t0;
      var label = 'binary hostile PDF (raw) adapt(pdf)';
      record(label, elapsed);
      process.stdout.write('  ' + label + ': ' + elapsed + ' ms\n');
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' stderr: ' + (r.stderr || '').slice(0, 200));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  it('adapt(pdf) Flate-compressed completes within 3000 ms', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-pdf-flate-'));
    try {
      var pdfPath = buildHostilePdf(tmpDir, true);
      var script = [
        '"use strict";',
        'var adapt = require(' + JSON.stringify(ROOT + '/router/pif-adapt.js') + ').adapt;',
        'var t0 = Date.now();',
        'adapt(' + JSON.stringify(pdfPath) + ', "pdf");',
        'process.stdout.write(String(Date.now() - t0));',
      ].join('\n');
      var t0 = Date.now();
      var r = runScript(script, 3000);
      var elapsed = Date.now() - t0;
      var label = 'binary hostile PDF (flate) adapt(pdf)';
      record(label, elapsed);
      process.stdout.write('  ' + label + ': ' + elapsed + ' ms\n');
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' stderr: ' + (r.stderr || '').slice(0, 200));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  it('full hook uncompressed completes within 5000 ms', function () {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redos-pdf-hook-'));
    var tmpHome = path.join(tmpDir, 'home');
    try {
      fs.mkdirSync(tmpHome);
      var pdfPath = buildHostilePdf(tmpDir, false);
      var payload = JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: pdfPath },
        tool_response: {},
        session_id: 'redos-bin-pdf-raw',
      });
      var t0 = Date.now();
      var r = spawnSync(NODE, [HOOK], {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        env: { APEX_HOME: ROOT, HOME: tmpHome, PATH: process.env.PATH },
      });
      var elapsed = Date.now() - t0;
      var label = 'binary hostile PDF (raw) full hook';
      record(label, elapsed);
      process.stdout.write('  ' + label + ': ' + elapsed + ' ms\n');
      assert.ok(r.status !== null, label + ': timed out after ' + elapsed + ' ms');
      assert.strictEqual(r.status, 0, label + ': exit ' + r.status + ' stderr: ' + (r.stderr || '').slice(0, 200));
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });
});

// ─── Slowest-5 summary ────────────────────────────────────────────────────────
process.on('exit', function () {
  if (timings.length === 0) return;
  timings.sort(function (a, b) { return b.ms - a.ms; });
  process.stdout.write('\n=== Slowest 5 cases ===\n');
  timings.slice(0, 5).forEach(function (t) {
    process.stdout.write('  ' + t.ms + ' ms  ' + t.label + '\n');
  });
});
