#!/usr/bin/env node
'use strict';
/**
 * pif-cli.js — Command-line interface for APEX PIF scanning.
 *
 * Subcommands:
 *   scan <path>         Scan a file.
 *   text "<string>"     Scan a literal string.
 *   next <path|->       Re-run scan, validate model output, apply escalation.
 *
 * Exits: 0 = success, 2 = usage error, 1 = --fail-on-risk when attacks found.
 * Stdlib only, no npm deps.
 */

var path = require('path');
var fs = require('fs');
var os = require('os');

// Load sibling router modules (same directory)
var sourceModule = require('./pif-source.js');
var adaptModule  = require('./pif-adapt.js');
var detectModule = require('./pif-detect.js');
var routeModule  = require('./pif-route.js');

var inferSource     = sourceModule.inferSource;
var adapt           = adaptModule.adapt;
var detect          = detectModule.detect;
var route           = routeModule.route;
var buildPrompt     = routeModule.buildPrompt;
var validateModelOutput = routeModule.validateModelOutput;
var escalate        = routeModule.escalate;

var MAX_NORMALIZED_TEXT = 8000;

// ─── Argument parser ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  var args = { sub: null, positional: [], flags: {} };
  var i = 0;
  while (i < argv.length) {
    var a = argv[i];
    if (a === '--json')           { args.flags.json = true; i++; }
    else if (a === '--fail-on-risk') { args.flags.failOnRisk = true; i++; }
    else if (a.startsWith('--')) {
      var key = a.slice(2);
      var val = argv[i + 1];
      args.flags[key] = val || '';
      i += 2;
    } else {
      if (!args.sub) args.sub = a;
      else args.positional.push(a);
      i++;
    }
  }
  return args;
}

function usageError(msg) {
  process.stderr.write('pif-cli: ' + msg + '\n');
  process.exit(2);
}

// ─── JSON flag loader (value or @file) ───────────────────────────────────────
function loadJson(valOrFile, label) {
  if (!valOrFile) return null;
  if (valOrFile.startsWith('@')) {
    try {
      return JSON.parse(fs.readFileSync(valOrFile.slice(1), 'utf8'));
    } catch (e) {
      usageError('cannot read ' + label + ' from ' + valOrFile + ': ' + e.message);
    }
  }
  try {
    return JSON.parse(valOrFile);
  } catch (e) {
    usageError('cannot parse ' + label + ' as JSON: ' + e.message);
  }
}

// ─── Core scan logic ──────────────────────────────────────────────────────────
function runScan(opts) {
  // opts: { filePath, text, source }
  // Returns the full result object.
  var filePath = opts.filePath || null;
  var inputText = opts.text || null;
  var forcedSource = opts.source || null;

  var extraction = 'complete';
  var extractionNotes = [];
  var buf = null;
  var readFromDisk = false;

  if (filePath) {
    try {
      var stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        extractionNotes.push('not a regular file');
        extraction = 'failed';
      } else if (stat.size > 25 * 1024 * 1024) {
        extractionNotes.push('file size exceeds 25 MB');
        extraction = 'partial';
      } else {
        buf = fs.readFileSync(filePath);
        readFromDisk = true;
      }
    } catch (e) {
      extractionNotes.push('file_read_error: ' + e.message);
      extraction = 'failed';
    }
  }

  var sourceText = buf ? null : (inputText || '');

  // Infer source
  var source = forcedSource || inferSource({
    path:      filePath,
    buffer:    buf,
    text:      sourceText ? sourceText.slice(0, 2000) : null,
    tool_name: null,
    tool_input: {},
  });

  // Adapt
  var adapted;
  try {
    var pathBased = (source === 'pdf' || source === 'word_doc' || source === 'image_via_ocr');
    if (pathBased && filePath && readFromDisk) {
      adapted = adapt(filePath, source);
    } else if (buf) {
      adapted = adapt(buf.toString('utf8'), source);
    } else {
      var ta = sourceText;
      if (ta && ta.length > 1024 * 1024) {
        ta = ta.slice(0, 1024 * 1024);
        extraction = 'partial';
        extractionNotes.push('text truncated to 1 MB');
      }
      adapted = adapt(ta || '', source);
    }
  } catch (e) {
    adapted = { text: '', provenance_zones: [], hidden_text_flags: [], source_type: source, degraded: true };
    extractionNotes.push('adapt_error: ' + e.message);
    extraction = 'failed';
  }

  var adaptedExtraction = adapted.extraction || extraction;
  var adaptedNotes = adapted.extraction_notes || extractionNotes;

  // Detect
  var detected;
  try {
    detected = detect(adapted.text || '', {
      source:            source,
      hidden_text_flags: adapted.hidden_text_flags || [],
      provenance_zones:  adapted.provenance_zones  || [],
    });
  } catch (e) {
    detected = { risk: 0, confidence: 0, attack_types: [], needs_model_tier: 'none', normalized_text: '', tier0_fault: true };
  }

  var risk       = typeof detected.risk === 'number' ? detected.risk : 0;
  var confidence = typeof detected.confidence === 'number' ? detected.confidence : 0;
  var attackTypes = Array.isArray(detected.attack_types) ? detected.attack_types : [];
  var signals    = detected.signals || [];

  // Route
  var routed;
  try {
    routed = route(detected);
  } catch (e) {
    routed = { tier: 'none', reason: 'route_error', budget_note: '', prompt_for_model: null, neutralize_immediately: false };
  }

  var tier         = routed.tier || 'none';
  var reason       = routed.reason || '';
  var budgetNote   = routed.budget_note || '';
  var neutralizeNow = !!routed.neutralize_immediately;

  // Build model_request with normalized_text capped at 8000 chars
  var modelRequest = null;
  if (tier !== 'none') {
    try {
      var prompt = buildPrompt(tier, {
        normalized_text:     (detected.normalized_text || '').slice(0, MAX_NORMALIZED_TEXT),
        tier0_signals:       detected,
        tier0_attack_types:  attackTypes.map(function (a) { return a.id || a; }),
      });
      modelRequest = {
        tier:   tier,
        model:  tier,
        system: prompt.system,
        user:   prompt.user,
      };
    } catch (e) {
      modelRequest = null;
    }
  }

  return {
    path:          filePath,
    source:        source,
    extraction:    adaptedExtraction,
    extraction_notes: adaptedNotes,
    risk:          risk,
    confidence:    confidence,
    attack_types:  attackTypes.map(function (a) {
      return { id: a.id, confidence: a.confidence, severity: a.severity, evidence: a.evidence || '' };
    }),
    signals:       signals,
    hidden_flags:  (adapted.hidden_text_flags || []).map(function (f) {
      return { kind: f.kind, excerpt: f.excerpt || '' };
    }),
    tier:          tier,
    reason:        reason,
    budget_note:   budgetNote,
    neutralize_immediately: neutralizeNow,
    model_request: modelRequest,
    // Internal for next subcommand
    _detected: detected,
  };
}

// ─── Human-readable table ─────────────────────────────────────────────────────
function printHumanTable(result) {
  var lines = [
    'Path      : ' + (result.path || '(text)'),
    'Source    : ' + result.source,
    'Risk      : ' + result.risk.toFixed(2) + '  Confidence: ' + result.confidence.toFixed(2),
    'Tier      : ' + result.tier + '  Neutralize now: ' + result.neutralize_immediately,
    'Extraction: ' + result.extraction,
  ];
  if (result.attack_types.length > 0) {
    lines.push('Attacks   :');
    result.attack_types.forEach(function (a) {
      lines.push('  [' + a.severity + '] ' + a.id + ' (' + a.confidence.toFixed(2) + ')');
    });
  } else {
    lines.push('Attacks   : none');
  }
  if (result.hidden_flags.length > 0) {
    lines.push('Hidden    : ' + result.hidden_flags.map(function (f) { return f.kind; }).join(', '));
  }
  lines.push('Reason    : ' + result.reason);
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Subcommand: scan ─────────────────────────────────────────────────────────
function cmdScan(args) {
  var filePath = args.positional[0];
  if (!filePath) usageError('scan requires a file path');

  var result = runScan({
    filePath: filePath,
    source:   args.flags.source || null,
  });

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    printHumanTable(result);
  }

  if (args.flags.failOnRisk && result.attack_types.length > 0) process.exit(1);
}

// ─── Subcommand: text ─────────────────────────────────────────────────────────
function cmdText(args) {
  var str = args.positional[0];
  if (str === undefined) usageError('text requires a string argument');

  var result = runScan({
    text:   str,
    source: args.flags.source || 'user_message',
  });

  // Override path to null since it's a literal
  result.path = null;

  if (args.flags.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    printHumanTable(result);
  }

  if (args.flags.failOnRisk && result.attack_types.length > 0) process.exit(1);
}

// ─── Subcommand: next ─────────────────────────────────────────────────────────
function cmdNext(args) {
  var target = args.positional[0];
  if (!target) usageError('next requires a path or "-"');

  var tierArg = args.flags.tier;
  if (!tierArg) usageError('next requires --tier <haiku|sonnet|opus>');
  if (!['haiku', 'sonnet', 'opus'].includes(tierArg)) usageError('--tier must be haiku, sonnet, or opus');

  var outputArg = args.flags.output;
  if (!outputArg) usageError('next requires --output <json-string|@file>');

  var priorArg  = args.flags.prior || null;
  var sourceArg = args.flags.source || null;
  var textArg   = args.flags.text || null;

  // Load model output
  var modelOutput = loadJson(outputArg, '--output');

  // Load prior outputs if provided
  var prior = priorArg ? (loadJson(priorArg, '--prior') || {}) : {};

  // Re-run the scan
  var scanOpts = { source: sourceArg };
  if (target === '-') {
    scanOpts.text = textArg || '';
    scanOpts.source = scanOpts.source || 'user_message';
  } else {
    scanOpts.filePath = target;
    if (textArg) scanOpts.text = textArg;
  }

  var scanResult = runScan(scanOpts);
  var detected = scanResult._detected;

  // Validate the model output
  var validation = validateModelOutput(tierArg, modelOutput);

  // Apply escalation
  var esc = escalate(tierArg, modelOutput, detected);

  // Build accumulated prior for output
  var newPrior = {};
  if (tierArg === 'haiku') {
    newPrior.tier1_output = modelOutput;
    // carry through any pre-existing tier2_output (unusual but defensive)
    if (prior.tier2_output) newPrior.tier2_output = prior.tier2_output;
  } else if (tierArg === 'sonnet') {
    newPrior.tier1_output = prior.tier1_output || null;
    newPrior.tier2_output = modelOutput;
  } else {
    // opus — final, but carry through what we have
    newPrior.tier1_output = prior.tier1_output || null;
    newPrior.tier2_output = prior.tier2_output || null;
  }

  // Build next model_request if escalating
  var nextModelRequest = null;
  if (esc.next_tier) {
    try {
      var ctx = {
        normalized_text:    (detected.normalized_text || '').slice(0, MAX_NORMALIZED_TEXT),
        tier0_signals:      detected,
        tier0_attack_types: (detected.attack_types || []).map(function (a) { return a.id || a; }),
        tier1_output:       null,
        tier2_output:       null,
      };
      if (esc.next_tier === 'sonnet') {
        // Current = haiku; tier1_output is current haiku output
        ctx.tier1_output = modelOutput;
      } else if (esc.next_tier === 'opus') {
        // Current = sonnet; tier1_output from prior, tier2_output is current sonnet output
        ctx.tier1_output = prior.tier1_output || null;
        ctx.tier2_output = modelOutput;
      }
      var prompt = buildPrompt(esc.next_tier, ctx);
      nextModelRequest = {
        tier:   esc.next_tier,
        model:  esc.next_tier,
        system: prompt.system,
        user:   prompt.user,
      };
    } catch (e) {
      nextModelRequest = null;
    }
  }

  var out = {
    current_tier:        tierArg,
    model_output_valid:  validation.valid,
    validation_errors:   validation.errors,
    next_tier:           esc.next_tier,
    final:               esc.final,
    decision:            esc.decision,
    reason:              esc.reason,
    prior:               newPrior,
    model_request:       nextModelRequest,
  };

  process.stdout.write(JSON.stringify(out) + '\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
var argv = process.argv.slice(2);
var args = parseArgs(argv);

switch (args.sub) {
  case 'scan': cmdScan(args); break;
  case 'text': cmdText(args); break;
  case 'next': cmdNext(args); break;
  default:
    if (!args.sub) {
      process.stderr.write('Usage: pif-cli.js <scan|text|next> ...\n');
      process.exit(2);
    }
    usageError('unknown subcommand: ' + args.sub);
}
