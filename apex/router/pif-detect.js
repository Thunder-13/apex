'use strict';

const fs   = require('fs');
const path = require('path');

const GATE = 0.3;

const ATTACK_IDS = [
  'instruction_override', 'role_change', 'secret_extraction', 'tool_abuse',
  'credential_theft', 'context_poisoning', 'multi_step_jailbreak',
  'encoded_instructions', 'indirect_injection'
];

const NEUTRALIZE_STRENGTH = ['refuse', 'strip', 'quote_fence', 'warn', 'flag_only'];

let _threats = null;
let _compiled = null;
let _kwRegexes = null;

// Convert keyword phrase to a word-bounded regex.
// Words get \b at each word-character edge; spaces become \s+.
function makeKeywordRegex(kw) {
  const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = esc.replace(/\\ /g, '\\s+');
  const lb  = /^\w/.test(kw) ? '\\b' : '';
  const rb  = /\w$/.test(kw) ? '\\b' : '';
  try { return new RegExp(lb + pat + rb, 'i'); } catch (e) { return null; }
}

function loadThreats() {
  if (_threats && _compiled && _kwRegexes) return { threats: _threats, compiled: _compiled, kwRegexes: _kwRegexes };
  const jsonPath = path.join(__dirname, '..', 'references', 'pif-threats.json');
  _threats = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  _compiled = {};
  _kwRegexes = {};
  for (const entry of _threats) {
    const regexes = (entry.patterns || []).map(p => {
      try { return new RegExp(p, 'i'); } catch (e) { return null; }
    }).filter(Boolean);
    _compiled[entry.id] = { entry, regexes };
    _kwRegexes[entry.id] = (entry.keywords || []).map(kw => {
      const rx = makeKeywordRegex(kw);
      return rx ? { kw, rx } : null;
    }).filter(Boolean);
  }
  return { threats: _threats, compiled: _compiled, kwRegexes: _kwRegexes };
}

function rot13(str) {
  return str.replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

// Collapse single-letter spacing: "I G N O R E" -> "IGNORE"
// Matches 3+ single letters separated by one space each.
function collapseSpacedLetters(text) {
  return text.replace(/\b([A-Za-z]) (?:[A-Za-z] ){2,}[A-Za-z]\b/g, m => m.replace(/ /g, ''));
}

// Leet-speak normalization for OCR scan (returns a secondary view, never replaces original)
function leetNormalize(text) {
  return text
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/@/g, 'a').replace(/\$/g, 's');
}

const INJECTION_PHRASES = ['ignore', 'forget', 'system', 'instruct', 'override', 'disregard'];
function containsInjectionPhrase(str) {
  const l = str.toLowerCase();
  return INJECTION_PHRASES.some(p => l.includes(p));
}

// A base64 blob must be >= 24 chars AND contain at least one digit, '+', '/',
// or trailing '='. Pure-letter identifiers never qualify.
function isBase64Candidate(blob) {
  return blob.length >= 24 && (/[0-9+/]/.test(blob) || /=$/.test(blob));
}

function recursiveScanDecoded(decoded, depth, compiled, kwRegexes) {
  if (depth > 2 || !decoded) return [];
  const results = [];
  for (const id of ATTACK_IDS) {
    const comp = compiled[id];
    if (!comp) continue;
    const entry = comp.entry;
    let hits = 0;
    for (const rx of comp.regexes) { if (rx.test(decoded)) hits++; }
    let kwHits = 0;
    for (const { rx } of (kwRegexes[id] || [])) { if (rx.test(decoded)) kwHits++; }
    if (hits === 0 && kwHits === 0) continue;
    const rxConf = hits > 0   ? Math.min(0.95, 0.5 + 0.1 * hits)   : 0;
    const kwConf = kwHits > 0 ? Math.min(0.95, 0.4 + 0.05 * kwHits) : 0;
    let conf = Math.max(rxConf, kwConf);
    if (hits > 0 && kwHits > 0) conf = Math.min(0.95, conf + 0.1);
    results.push({ id, confidence: conf, severity: entry.severity, neutralize: entry.neutralize,
      evidence: `[decoded-depth${depth}] ${decoded.slice(0, 100)}` });
  }
  return results;
}

// Returns true when a match appears inside quotes/code span near meta-discussion cues.
const META_CUE_RX = /\b(attacks?|examples?|such as|phrases?\s+like|known as|researchers?|this technique|demonstrates?|illustrat|for\s+(?:educational|research|documentation)\s+purposes?|do\s+not\s+constitute|defend|surveys?)\b/i;
function isQuotedDiscussion(text, matchStart, matchEnd) {
  const window = text.slice(Math.max(0, matchStart - 200), Math.min(text.length, matchEnd + 200));
  if (!META_CUE_RX.test(window)) return false;
  const before = text.slice(0, matchStart);
  const dq = (before.match(/"/g)  || []).length;
  const sq = (before.match(/'/g)  || []).length;
  const bt = (before.match(/`/g)  || []).length;
  // Also check HTML code/blockquote tag depth
  const codeOpen  = (before.match(/<code[^>]*>/gi)  || []).length;
  const codeClose = (before.match(/<\/code>/gi)     || []).length;
  const bqOpen    = (before.match(/<blockquote[^>]*>/gi) || []).length;
  const bqClose   = (before.match(/<\/blockquote>/gi)    || []).length;
  const inCode      = codeOpen > codeClose;
  const inBlockquote = bqOpen > bqClose;
  return (dq % 2 === 1) || (sq % 2 === 1) || (bt % 2 === 1) || inCode || inBlockquote;
}

// Secret objects for credential_theft conjunction check
const CRED_SECRET_RX = /\b(api[_\s-]?keys?|tokens?|passwords?|credentials?|secrets?|private[_\s-]?keys?|ssh[_\s-]?keys?|id_rsa|aws[_\s-]?credentials?|keychain|session[_\s-]?cookies?)\b|\.env\b/i;
// Exfiltration paths for credential_theft
const CRED_EXFIL_RX  = /\b(send|email|forward|post|upload|exfiltrate|leak|paste|share|transmit|curl|wget|webhook)\b|https?:\/\/\S+|(?<![\w.+\-])[\w.+\-]{1,64}@[\w\-]{1,63}(?:\.[\w\-]{1,63}){1,8}/i;
// Dump requests against agent's own secrets
const CRED_DUMP_RX   = /\b(print|dump|output|reveal|show|expose|display)\b.{0,60}(?:api[_\s-]?key|secrets?|\.env\b|tokens?|passwords?|credentials?|env(?:ironment)?|private[_\s-]?key)/i;

// Protected objects for secret_extraction (must reference the AI's own context)
const SEC_PROTECTED_RX = /\b(system\s+prompt|initial\s+instructions?|original\s+(?:prompt|instructions?)|hidden\s+instructions?|developer\s+instructions?|your\s+(?:initial\s+|original\s+|full\s+|exact\s+|complete\s+)?(?:instructions?|rules?|guidelines?|directives?|configuration|context)|the\s+(?:configuration|instructions?|full\s+text|text|content)\s+you\s+(?:were|have\s+been)\s+given|(?:all\s+)?(?:instructions?|directives?|guidelines?|rules?)\s+(?:you\s+)?(?:were\s+given|received|have\s+been\s+given)|the\s+text\s+above|everything\s+before\s+this\s+message)\b/i;
// Disclosure verbs for secret_extraction
const SEC_DISCLOSE_RX  = /\b(repeat|reveal|print|output|show|display|leak|dump|tell\s+me|what\s+are|translate|summarize|encode)\b/i;

// Device jailbreak context (suppresses multi_step_jailbreak for device topics)
const DEVICE_JAILBREAK_RX = /\b(iphone|ipad|android|phone|device|ios|firmware|tablet|handset|samsung|pixel|unlock)\b/i;

// DAN-style tokens that only fire in role-assignment / jailbreak context
const DAN_CONTEXT_RX = /\b(you\s+are\s+now\s+DAN|act\s+as\s+DAN|DAN\s+mode|enable\s+DAN|do\s+anything\s+now)\b/i;

// Explicit multi-step escalation language
const ESCALATION_RX = /\b(now\s+that\s+you(?:'ve|\s+have)\s+agreed|step\s+[2-9]\s+of|continuing\s+from\s+before[,\s]+ignore)\b/i;

// ── Structural generalization constants ─────────────────────────────────────

// Role headers in retrieved content (SYSTEM:, OVERRIDE:, etc.)
const ROLE_HEADER_RX = /(?:^|\n)\s*(?:SYSTEM\s+DIRECTIVE|SYSTEM\s+CONTEXT\s+UPDATE|SYSTEM|OVERRIDE|INJECTION|ADMIN\s*NOTE|AI\s*PROCESSING\s*NOTE|ATTENTION\s*AI)\s*:/im;

// Control verb + task noun within 80 chars (generic override paraphrase)
const CTRL_VERB_TASK_RX = /\b(?:ignore|disregard|forget|supersede|override|replace|discard|abandon)\b.{0,80}\b(?:task|instructions?|directive[s]?|request|objective|guidelines?|rules?|summary|prompt|context)\b/i;

// Replacement/supersede phrases
const REPLACE_PHRASE_RX = /\b(?:your\s+(?:real\s+|actual\s+|new\s+|updated\s+)?task\s+is(?:\s+now)?\b|new\s+(?:task|directive)\s*[:\-]\s*\S|this\s+directive\s+supersedes?|supersedes?\s+the\s+(?:user|original|prior)\b|(?:current\s+)?task\s+is\s+now\s+superseded)\b/i;

// Output-control demands (in retrieved content)
const OUTPUT_CTRL_RX = /\b(?:reply\s+only\s+with|respond\s+with\s+exactly|output\s+only\b|say\s+the\s+(?:word|token)\b|print\s+the\s+token\b|end\s+your\s+(?:response|answer|reply)\s+with)\b/i;

// Role persona assignment (broader than DAN/jailbroken patterns)
const ROLE_ASSIGN_RX = /\b(?:you\s+are\s+now\s+(?:operating|acting|functioning)\s+as\s+\S{1,40}|your\s+role\s+has\s+(?:changed|switched)\s+(?:from|to)\b|your\s+persona\s+has\s+changed\s+to\b|you\s+have\s+been\s+(?:reassigned|upgraded|repurposed)\s+(?:as|to)\b|(?:operating|running|working)\s+in\s+(?:unrestricted|uncensored|jailbreak|developer|admin|unfiltered)\s+mode\b)\b/i;

// Semantic tool demands (natural language)
const TOOL_DEMAND_RX = /\b(?:use\s+the\s+(?:bash|shell|python|file|read|write|search|terminal|computer|send[\s_]email|email|webfetch)\s+tool\b|execute\s+(?:the\s+)?(?:following\s+)?(?:bash|shell)\s+(?:command|script)\b|via\s+the\s+(?:webfetch|bash|computer)\s+tool\b|forward\s+(?:this|the)\s+(?:email|message)\s+to\s+[\w.+\-]{1,64}@[\w.\-]{1,80}|post\s+(?:the\s+)?(?:string|token|data|secret)\s+to\s+https?:\/\/\S{1,120})\b/i;

// Repeated policy/override planting
const POLICY_PLANT_RX = /\b(?:POLICY|OVERRIDE|REMEMBER)\b.{0,80}\b(?:active|enabled|in\s+effect)\b/ig;

// Session-level instruction planting
const SESSION_PLANT_RX = /\b(?:remember\s+(?:the\s+following\s+)?(?:system\s+note|directive|instruction)\s+for\s+(?:this|the)\b|for\s+this\s+(?:entire\s+)?session[,\s.:])/i;

// Two-turn / conditional trigger plant
const TRIGGER_PLANT_RX = /\b(?:in\s+the\s+next\s+turn\b|when\s+you\s+(?:see|receive|hear)\s+the\s+(?:phrase|word|message|command)\b|step\s+(?:one|1|two|2)\s+of\s+a\s+(?:two|multi)[-\s](?:part|step)\s+sequence)\b/i;

// Educational / research context (caps risk at 0.75 to avoid neutralize_immediately)
const EDU_CONTEXT_RX = /\b(?:for\s+(?:educational|research|documentation|academic|illustrative)\s+purposes?|do\s+not\s+constitute\s+instructions?|this\s+article\s+explains?|examples?\s+of\s+(?:prompt\s+injection|injection\s+attacks?|attack\s+patterns?)|security\s+(?:overview|research|training)\s+(?:document|guide|content|page)?|these\s+(?:strings|phrases|examples?)\s+(?:appear|are\s+quoted|are\s+taken)|this\s+page\s+is\s+(?:benign|security\s+research))\b/i;

function detect(text, metadata) {
  const startHr = process.hrtime.bigint();
  const _meta   = metadata || {};
  const source  = _meta.source || 'user_message';

  function elapsed() { return Number(process.hrtime.bigint() - startHr) / 1e6; }

  function emptyResult(overrides) {
    return Object.assign({
      risk: 0, confidence: 1, attack_types: [], signals: [],
      neutralize_hint: '', needs_model_tier: 'none',
      normalized_text: '', tier0_fault: false,
      scanner_latency_ms: elapsed(), source
    }, overrides);
  }

  try {
    const { compiled, kwRegexes } = loadThreats();

    if (text === null || text === undefined || text === '') {
      return emptyResult({ normalized_text: String(text || ''), signals: [] });
    }

    const raw    = String(text);
    const nfkc   = raw.normalize('NFKC');

    // Zero-width scan
    const zwBmpRx  = /[​‌‍﻿⁠]/g;
    const tagCharRx = /\uDB40[\uDC00-\uDC7F]/g;
    const zwMatches = (nfkc.match(zwBmpRx) || []).concat(nfkc.match(tagCharRx) || []);
    const hasZeroWidth = zwMatches.length > 0;

    // Bidi scan
    const bidiMatches = nfkc.match(/[‮⁦⁧⁨⁩]/g) || [];
    const hasBidi = bidiMatches.length > 0;

    // Homoglyph scan
    const homoglyphMatches = nfkc.match(/[Ѐ-ӿͰ-Ͽ]/g) || [];
    const hasHomoglyphs = homoglyphMatches.length > 0 && containsInjectionPhrase(nfkc);

    const normalized = nfkc
      .replace(/[​‌‍﻿⁠‮⁦⁧⁨⁩]/g, '')
      .replace(/\uDB40[\uDC00-\uDC7F]/g, '');

    // Secondary normalized view for OCR deobfuscation (scanned in addition to original)
    const normalizedOcr = leetNormalize(collapseSpacedLetters(normalized));

    // Retrieved-source flag (used by structural scorers below and indirect_injection)
    const retrievedSourceSet = new Set(['web_page','pdf','email','markdown','html','word_doc','api_response','ocr_text','source_code','image_via_ocr']);
    const isRetrieved = retrievedSourceSet.has(source);

    // findings[id] = { confidence, evidence, severity, neutralize }
    const findings = {};

    function ensureEntry(id) {
      if (!findings[id]) {
        const entry = compiled[id] ? compiled[id].entry : null;
        findings[id] = {
          confidence: 0, evidence: '',
          severity:   entry ? entry.severity   : 'high',
          neutralize: entry ? entry.neutralize : 'flag_only'
        };
      }
    }

    function mergeConfidence(id, conf, evidence) {
      ensureEntry(id);
      if (conf > findings[id].confidence) {
        findings[id].confidence = conf;
        findings[id].evidence   = evidence;
      }
    }

    // ── Main pattern + keyword scan ──────────────────────────────────────────
    for (const id of ATTACK_IDS) {
      const comp = compiled[id];
      if (!comp) continue;
      const entry = comp.entry;

      let rxHits = 0, firstRxMatch = '', rxMatchStart = -1, rxMatchEnd = -1;
      for (const rx of comp.regexes) {
        // Reset lastIndex for global-flagged regexes (these are /i only, but be safe)
        const m = normalized.match(rx);
        if (m) {
          rxHits++;
          if (!firstRxMatch) {
            firstRxMatch = m[0].slice(0, 200);
            const idx = normalized.indexOf(m[0]);
            if (idx !== -1) { rxMatchStart = idx; rxMatchEnd = idx + m[0].length; }
          }
        }
      }

      let kwHits = 0, firstKwMatch = '', kwMatchStart = -1, kwMatchEnd = -1;
      for (const { kw, rx } of (kwRegexes[id] || [])) {
        const m = normalized.match(rx);
        if (m) {
          kwHits++;
          if (!firstKwMatch) {
            firstKwMatch = kw;
            const idx = normalized.indexOf(m[0]);
            if (idx !== -1) { kwMatchStart = idx; kwMatchEnd = idx + m[0].length; }
          }
        }
      }

      if (rxHits === 0 && kwHits === 0) continue;

      // Quoted-discussion dampener
      let dampen = false;
      if (rxMatchStart !== -1 && isQuotedDiscussion(normalized, rxMatchStart, rxMatchEnd)) dampen = true;
      if (!dampen && kwMatchStart !== -1 && isQuotedDiscussion(normalized, kwMatchStart, kwMatchEnd)) dampen = true;

      const rxConf = rxHits > 0   ? Math.min(0.95, 0.5 + 0.1 * rxHits)   : 0;
      const kwConf = kwHits > 0   ? Math.min(0.95, 0.4 + 0.05 * kwHits)  : 0;
      let conf = Math.max(rxConf, kwConf);
      if (rxHits > 0 && kwHits > 0) conf = Math.min(0.95, conf + 0.1);
      // Dampener: quoted/example context -> always brings conf below gate
      if (dampen) conf = Math.min(conf * 0.4, GATE - 0.01);

      const evidence = (firstRxMatch || firstKwMatch).slice(0, 200);
      mergeConfidence(id, conf, evidence);
    }

    // ── OCR secondary scan (spaced letters, leet-speak) ────────────────────
    // Only add findings from the secondary view; never reduce existing confidence.
    if (normalizedOcr !== normalized) {
      for (const id of ATTACK_IDS) {
        const comp = compiled[id];
        if (!comp) continue;
        let ocrHits = 0;
        for (const rx of comp.regexes) { if (rx.test(normalizedOcr)) ocrHits++; }
        let ocrKwHits = 0;
        for (const { rx } of (kwRegexes[id] || [])) { if (rx.test(normalizedOcr)) ocrKwHits++; }
        if (ocrHits === 0 && ocrKwHits === 0) continue;
        const rxConf = ocrHits > 0   ? Math.min(0.95, 0.5 + 0.1 * ocrHits)   : 0;
        const kwConf = ocrKwHits > 0 ? Math.min(0.95, 0.4 + 0.05 * ocrKwHits) : 0;
        let conf = Math.max(rxConf, kwConf);
        if (ocrHits > 0 && ocrKwHits > 0) conf = Math.min(0.95, conf + 0.1);
        const cur = findings[id] ? findings[id].confidence : 0;
        if (conf > cur) mergeConfidence(id, conf, '[ocr-deobfuscated] ' + normalizedOcr.slice(0, 80));
      }
    }

    // ── Structural instruction_override scorer ──────────────────────────────
    // Helper: check if a structural match is in quoted/educational context.
    function structDampen(matchText) {
      if (!matchText) return false;
      const pos = normalized.indexOf(matchText);
      return pos >= 0 && isQuotedDiscussion(normalized, pos, pos + matchText.length);
    }
    {
      const ioBoost = isRetrieved ? 0.1 : 0;
      const roleM = normalized.match(ROLE_HEADER_RX);
      if (roleM && !structDampen(roleM[0])) {
        mergeConfidence('instruction_override', 0.55 + ioBoost, 'role header: ' + roleM[0].trim().slice(0, 60));
      }
      const ctrlM = normalized.match(CTRL_VERB_TASK_RX);
      if (ctrlM && !structDampen(ctrlM[0])) {
        mergeConfidence('instruction_override', 0.55 + ioBoost, 'ctrl-verb+task: ' + ctrlM[0].slice(0, 80));
      }
      const replM = normalized.match(REPLACE_PHRASE_RX);
      if (replM && !structDampen(replM[0])) {
        mergeConfidence('instruction_override', 0.60 + ioBoost, 'replacement phrase: ' + replM[0].slice(0, 80));
      }
      // Output-control demands inside retrieved content only
      if (isRetrieved) {
        const outM = normalized.match(OUTPUT_CTRL_RX);
        if (outM && !structDampen(outM[0])) {
          mergeConfidence('instruction_override', 0.55, 'output-control demand: ' + outM[0].slice(0, 60));
        }
      }
    }

    // ── Structural role_change scorer ───────────────────────────────────────
    {
      const roleAssignM = normalized.match(ROLE_ASSIGN_RX);
      if (roleAssignM && !structDampen(roleAssignM[0])) {
        const ioBoost = isRetrieved ? 0.1 : 0;
        mergeConfidence('role_change', 0.60 + ioBoost, 'role assignment: ' + roleAssignM[0].slice(0, 80));
      }
    }

    // ── Structural tool_abuse scorer (semantic) ─────────────────────────────
    {
      const toolM = normalized.match(TOOL_DEMAND_RX);
      if (toolM) {
        mergeConfidence('tool_abuse', 0.65, 'semantic tool demand: ' + toolM[0].slice(0, 80));
      }
    }

    // ── OCR structural pass: re-run key scorers on leet-decoded text ─────────
    // Catches obfuscated headers/roles that survive NFKC but not leet decode.
    if (normalizedOcr !== normalized) {
      const ocrBoost = isRetrieved ? 0.1 : 0;
      // instruction_override via role header (only if not already found on normalized)
      if (!normalized.match(ROLE_HEADER_RX)) {
        const ocrRoleM = normalizedOcr.match(ROLE_HEADER_RX);
        if (ocrRoleM) {
          mergeConfidence('instruction_override', 0.55 + ocrBoost, '[ocr] role header: ' + ocrRoleM[0].trim().slice(0, 60));
        }
      }
      // instruction_override via ctrl-verb+task
      if (!normalized.match(CTRL_VERB_TASK_RX)) {
        const ocrCtrlM = normalizedOcr.match(CTRL_VERB_TASK_RX);
        if (ocrCtrlM) {
          mergeConfidence('instruction_override', 0.55 + ocrBoost, '[ocr] ctrl-verb+task: ' + ocrCtrlM[0].slice(0, 80));
        }
      }
      // role_change via role assignment
      if (!normalized.match(ROLE_ASSIGN_RX)) {
        const ocrRoleAssignM = normalizedOcr.match(ROLE_ASSIGN_RX);
        if (ocrRoleAssignM) {
          mergeConfidence('role_change', 0.60 + ocrBoost, '[ocr] role assignment: ' + ocrRoleAssignM[0].slice(0, 80));
        }
      }
    }

    // ── credential_theft conjunction check ──────────────────────────────────
    // Direct detection: secret object + exfil path with proximity requirement.
    {
      const hasSecret = CRED_SECRET_RX.test(normalized);
      const hasExfil  = CRED_EXFIL_RX.test(normalized);
      const hasDump   = CRED_DUMP_RX.test(normalized);
      // Proximity check: secret and exfil/dump must appear within 150 chars of each other.
      let conjMet = false;
      if (hasSecret && (hasExfil || hasDump)) {
        const secretM = CRED_SECRET_RX.exec(normalized);
        const exfilM  = hasExfil ? CRED_EXFIL_RX.exec(normalized) : null;
        const dumpM   = hasDump  ? CRED_DUMP_RX.exec(normalized)  : null;
        const secretIdx = secretM ? secretM.index : -1;
        const exfilIdx  = exfilM  ? exfilM.index  : Infinity;
        const dumpIdx   = dumpM   ? dumpM.index   : Infinity;
        const nearest   = Math.min(exfilIdx, dumpIdx);
        conjMet = secretIdx >= 0 && nearest < Infinity && Math.abs(secretIdx - nearest) <= 150;
      }
      if (conjMet) {
        const cur = findings['credential_theft'] ? findings['credential_theft'].confidence : 0;
        if (cur < 0.6) {
          mergeConfidence('credential_theft', 0.6, 'direct: secret object + exfil/dump path detected');
        }
      }
      // Remove if conjunction not met
      if (findings['credential_theft'] && findings['credential_theft'].confidence > 0) {
        if (!conjMet) {
          delete findings['credential_theft'];
        }
      }
    }

    // ── secret_extraction conjunction check ─────────────────────────────────
    // Direct detection: protected object + disclosure verb, even if no pattern/keyword fired
    {
      const hasProtected = SEC_PROTECTED_RX.test(normalized);
      const hasDisclose  = SEC_DISCLOSE_RX.test(normalized);
      if (hasProtected && hasDisclose) {
        const cur = findings['secret_extraction'] ? findings['secret_extraction'].confidence : 0;
        if (cur < 0.6) {
          mergeConfidence('secret_extraction', 0.6, 'direct: protected object + disclosure verb detected');
        }
      }
      // Remove if conjunction not met (guards against partial matches)
      if (findings['secret_extraction'] && findings['secret_extraction'].confidence > 0) {
        if (!hasProtected || !hasDisclose) {
          delete findings['secret_extraction'];
        }
      }
    }

    // ── Context poisoning: repetition density ───────────────────────────────
    const lines = normalized.split('\n');
    const injLineCount = lines.filter(l => /^(ignore|disregard|forget|you\s+are|from\s+now\s+on)\b/i.test(l.trim())).length;
    if (injLineCount >= 10) {
      mergeConfidence('context_poisoning', 0.8, `${injLineCount} lines starting with injection verbs`);
    }
    // Phrase repetition: same instruction-like phrase >= 5 times anywhere, or >= 3 times in text > 4000 chars
    const CP_PHRASES = [
      /ignore\s+(all\s+)?previous\s+instructions?/ig,
      /disregard\s+(your|the|all)\s+(rules|instructions|guidelines)/ig,
      /forget\s+(all\s+|your\s+)?previous\s+instructions?/ig,
      /you\s+are\s+now\s+in\s+(unrestricted|jailbreak|developer)\s+mode/ig
    ];
    for (const phraseRx of CP_PHRASES) {
      const matches = normalized.match(phraseRx) || [];
      const threshold = normalized.length > 4000 ? 3 : 5;
      if (matches.length >= threshold) {
        mergeConfidence('context_poisoning', 0.75, `phrase repeated ${matches.length}x: ${(matches[0] || '').slice(0, 60)}`);
      }
    }
    if (normalized.length > 8000) {
      let phraseCrossHits = 0;
      for (const ph of INJECTION_PHRASES) {
        const m = normalized.match(new RegExp(ph, 'ig'));
        if (m && m.length >= 1) phraseCrossHits++;
      }
      if (phraseCrossHits >= 3) {
        mergeConfidence('context_poisoning', 0.7, 'large text with 3+ injection phrase types');
      }
    }
    // Repeated policy/override planting (any source)
    const policyPlants = normalized.match(POLICY_PLANT_RX) || [];
    if (policyPlants.length >= 4) {
      mergeConfidence('context_poisoning', 0.75, `policy/override planted ${policyPlants.length}x: ${(policyPlants[0] || '').slice(0, 60)}`);
      mergeConfidence('instruction_override', 0.60, `repeated override assertion (${policyPlants.length}x)`);
    }
    // Session-level instruction planting (single occurrence)
    if (SESSION_PLANT_RX.test(normalized)) {
      mergeConfidence('context_poisoning', 0.65, 'session-level instruction planting detected');
      mergeConfidence('instruction_override', 0.55, 'session note planting');
    }

    // ── Multi-step jailbreak special logic ──────────────────────────────────
    const ioConf  = findings['instruction_override'] ? findings['instruction_override'].confidence : 0;
    const rcConf  = findings['role_change']           ? findings['role_change'].confidence           : 0;
    const anyOtherGated = ATTACK_IDS.some(id =>
      id !== 'multi_step_jailbreak' && findings[id] && findings[id].confidence >= GATE);

    const framingRx = /\b(roleplay|pretend|in\s+this\s+hypothetical|hypothetically)\b/i;
    const hasFraming = framingRx.test(normalized);

    const hasDanContext     = DAN_CONTEXT_RX.test(normalized);
    const hasEscalation     = ESCALATION_RX.test(normalized);
    const hasDeviceJailbreak = /\bjailbreak\b/i.test(normalized) && DEVICE_JAILBREAK_RX.test(normalized);

    // Real multi-step: DAN context, or framing+other-gated, or io+rc, or explicit escalation
    if (hasDanContext || hasEscalation) {
      // Check if DAN context appears in a quoted/educational context before firing
      const danMatch = hasDanContext ? normalized.match(DAN_CONTEXT_RX) : null;
      const danDampened = danMatch
        ? isQuotedDiscussion(normalized, normalized.indexOf(danMatch[0]), normalized.indexOf(danMatch[0]) + danMatch[0].length)
        : false;
      if (!danDampened) {
        mergeConfidence('multi_step_jailbreak', 0.75, hasDanContext ? 'DAN role-assignment context' : 'explicit escalation language');
      } else {
        mergeConfidence('multi_step_jailbreak', 0.20, 'DAN context in quoted/educational context');
      }
    } else if (ioConf >= GATE && rcConf >= GATE) {
      mergeConfidence('multi_step_jailbreak', 0.7, 'instruction_override + role_change both gated');
    } else if (hasFraming && anyOtherGated) {
      mergeConfidence('multi_step_jailbreak', 0.75, 'hypothetical/roleplay framing + other gated attack');
    } else if (hasFraming && !anyOtherGated && !hasDeviceJailbreak) {
      // Pure framing only -> sub-gate signal (0.15), not a real attack
      mergeConfidence('multi_step_jailbreak', 0.15, 'hypothetical/roleplay framing only (no other attack)');
    }
    // Conditional trigger plant (two-turn sequence setup)
    if (TRIGGER_PLANT_RX.test(normalized)) {
      mergeConfidence('multi_step_jailbreak', 0.65, 'conditional trigger or two-turn sequence detected');
    }
    // Device jailbreak: never fire
    if (hasDeviceJailbreak && findings['multi_step_jailbreak']) {
      delete findings['multi_step_jailbreak'];
    }

    // ── Encoded instructions amplifiers ─────────────────────────────────────
    if (hasZeroWidth) {
      ensureEntry('encoded_instructions');
      findings['encoded_instructions'].confidence = Math.min(0.95, findings['encoded_instructions'].confidence + 0.3);
      if (!findings['encoded_instructions'].evidence) findings['encoded_instructions'].evidence = `zero-width chars (${zwMatches.length})`;
    }
    if (hasBidi) {
      ensureEntry('encoded_instructions');
      findings['encoded_instructions'].confidence = Math.min(0.95, findings['encoded_instructions'].confidence + 0.3);
      if (!findings['encoded_instructions'].evidence) findings['encoded_instructions'].evidence = 'bidi override chars';
    }
    if (hasHomoglyphs) {
      ensureEntry('encoded_instructions');
      findings['encoded_instructions'].confidence = Math.min(0.95, findings['encoded_instructions'].confidence + 0.15);
      if (!findings['encoded_instructions'].evidence) findings['encoded_instructions'].evidence = 'homoglyph chars in injection context';
    }

    // Base64 blob scan: enforce isBase64Candidate rule
    const b64Rx = /(^|\s)([A-Za-z0-9+/]{24,}={0,2})(\s|$)/g;
    let b64Match;
    while ((b64Match = b64Rx.exec(normalized)) !== null) {
      const blob = b64Match[2];
      if (!isBase64Candidate(blob)) continue;

      try {
        const decoded = Buffer.from(blob, 'base64').toString('utf8');
        // Printable ratio check
        const printable = (decoded.match(/[\x20-\x7E]/g) || []).length;
        const printableRatio = printable / (decoded.length || 1);

        if (printableRatio >= 0.85 && containsInjectionPhrase(decoded)) {
          // Likely encoded instruction
          mergeConfidence('encoded_instructions', 0.85, `base64 blob with injection phrase: ${blob.slice(0, 40)}`);
          const subFindings = recursiveScanDecoded(decoded, 1, compiled, kwRegexes);
          for (const sf of subFindings) mergeConfidence(sf.id, sf.confidence, sf.evidence);
        } else if (printableRatio >= 0.85) {
          // Check if surrounding context frames this blob as an instruction
          const blobPos = b64Match.index;
          const contextBefore = normalized.slice(Math.max(0, blobPos - 150), blobPos);
          const INSTR_FRAME_RX = /\b(?:instruct|command|directive|must\s+follow|you\s+must|system\s+instruction|encoded\s+(?:system|instruction|command))\b/i;
          if (INSTR_FRAME_RX.test(contextBefore)) {
            mergeConfidence('encoded_instructions', 0.75, `framed b64 blob (instruction context): ${blob.slice(0, 40)}`);
          } else {
            // Printable but no injection/framing -> sub-gate signal at 0.2
            ensureEntry('encoded_instructions');
            if (findings['encoded_instructions'].confidence < 0.2) {
              findings['encoded_instructions'].confidence = 0.2;
              findings['encoded_instructions'].evidence = `base64 blob (printable, benign): ${blob.slice(0, 40)}`;
            }
          }
        }
        // Not printable (hashes, JWT sigs): ignore
      } catch (e) { /* ignore decode errors */ }
    }

    // Hex blob scan (>= 40 hex chars continuous)
    const hexRx = /\b([0-9a-fA-F]{2}(?:\s+[0-9a-fA-F]{2}){9,})\b/g;
    let hexMatch;
    while ((hexMatch = hexRx.exec(normalized)) !== null) {
      const hexStr = hexMatch[1].replace(/\s+/g, '');
      if (hexStr.length >= 40) {
        try {
          const decoded = Buffer.from(hexStr, 'hex').toString('utf8');
          const printable = (decoded.match(/[\x20-\x7E]/g) || []).length;
          if (printable / decoded.length >= 0.85 && containsInjectionPhrase(decoded)) {
            mergeConfidence('encoded_instructions', 0.85, `hex blob with injection phrase: ${hexStr.slice(0, 40)}`);
            const subFindings = recursiveScanDecoded(decoded, 1, compiled, kwRegexes);
            for (const sf of subFindings) mergeConfidence(sf.id, sf.confidence, sf.evidence);
          }
        } catch (e) { /* ignore */ }
      }
    }

    // Continuous hex blob scan (>= 40 hex chars, no spaces required)
    const hexContRx = /\b([0-9a-fA-F]{40,})\b/g;
    let hexContMatch;
    while ((hexContMatch = hexContRx.exec(normalized)) !== null) {
      const hexStr = hexContMatch[1];
      if (hexStr.length % 2 !== 0) {
        // Odd nibble: try even prefix
        const even = hexStr.slice(0, hexStr.length - 1);
        try {
          const decoded = Buffer.from(even, 'hex').toString('utf8');
          const printable = (decoded.match(/[\x20-\x7E]/g) || []).length;
          if (printable / (decoded.length || 1) >= 0.85 && containsInjectionPhrase(decoded)) {
            mergeConfidence('encoded_instructions', 0.85, `hex blob (even prefix) with injection: ${even.slice(0, 40)}`);
            const subFindings = recursiveScanDecoded(decoded, 1, compiled, kwRegexes);
            for (const sf of subFindings) mergeConfidence(sf.id, sf.confidence, sf.evidence);
          }
        } catch (e) { /* ignore */ }
      } else {
        try {
          const decoded = Buffer.from(hexStr, 'hex').toString('utf8');
          const printable = (decoded.match(/[\x20-\x7E]/g) || []).length;
          if (printable / (decoded.length || 1) >= 0.85 && containsInjectionPhrase(decoded)) {
            mergeConfidence('encoded_instructions', 0.85, `hex blob with injection: ${hexStr.slice(0, 40)}`);
            const subFindings = recursiveScanDecoded(decoded, 1, compiled, kwRegexes);
            for (const sf of subFindings) mergeConfidence(sf.id, sf.confidence, sf.evidence);
          }
        } catch (e) { /* ignore */ }
      }
    }

    // ROT13 heuristic
    const rot = rot13(normalized);
    if (rot.toLowerCase().includes('ignore') || rot.toLowerCase().includes('system')) {
      ensureEntry('encoded_instructions');
      if (!findings['encoded_instructions'].evidence) findings['encoded_instructions'].evidence = 'rot13 heuristic';
      findings['encoded_instructions'].confidence = Math.min(0.95, findings['encoded_instructions'].confidence + 0.15);
    }

    // ── Indirect injection ───────────────────────────────────────────────────
    // isRetrieved already set above

    // Direct addressing of AI in content (broader pattern)
    const AI_ADDRESS_RX = /\b(if\s+you\s+are\s+an\s+ai|note\s+to\s+the\s+assistant|ai\s+agents?\s+reading\s+this|attention\s+(?:llm|language\s+model|assistant)|if\s+(?:an?\s+)?(?:ai|llm|language\s+model|assistant|agent)\s+(?:is|are)\s+(?:reading|processing|handling|parsing)\s+this)\b/i;
    const hasAiAddress = AI_ADDRESS_RX.test(normalized);

    const otherGatedConf = Math.max(0, ...ATTACK_IDS
      .filter(id => id !== 'indirect_injection' && findings[id] && findings[id].confidence >= GATE)
      .map(id => findings[id].confidence));

    const hiddenFlags = _meta.hidden_text_flags || [];
    let hiddenInjection = false;
    let hiddenEvidence = '';
    for (const flag of hiddenFlags) {
      const excerpt = (flag.excerpt || '');
      if (containsInjectionPhrase(excerpt.toLowerCase())) {
        hiddenInjection = true;
        if (!hiddenEvidence) hiddenEvidence = `hidden_text_flag (${flag.kind}): ${excerpt.slice(0, 100)}`;
        const subFindings = recursiveScanDecoded(excerpt, 1, compiled, kwRegexes);
        for (const sf of subFindings) mergeConfidence(sf.id, sf.confidence, `[hidden_text] ${sf.evidence}`);
      }
    }

    // Compute indirect_injection AFTER hidden-text sub-findings are merged so that
    // "strongest other" reflects attacks found inside the hidden text.
    if (hiddenInjection) {
      const postOtherGated = ATTACK_IDS
        .filter(id => id !== 'indirect_injection' && findings[id] && findings[id].confidence >= GATE)
        .map(id => findings[id].confidence);
      const strongest = postOtherGated.length > 0 ? Math.max(...postOtherGated) : 0;
      // Extra 0.1 for each additional gated attack beyond the first (compound evidence)
      // Use +0.2 for compound case (avoids floating-point 0.7999... < 0.8 issue)
      const extra = postOtherGated.length >= 2 ? 0.2 : 0.1;
      const conf = Math.min(0.95, Math.max(0.6, strongest > 0 ? strongest + extra : 0.6));
      ensureEntry('indirect_injection');
      findings['indirect_injection'].confidence = Math.max(findings['indirect_injection'].confidence, conf);
      findings['indirect_injection'].evidence = hiddenEvidence || 'hidden_text_flag with injection phrase';
    }

    if (isRetrieved && !hiddenInjection && !hasAiAddress && otherGatedConf === 0) {
      // Retrieved source alone: sub-gate signal only
      ensureEntry('indirect_injection');
      if (findings['indirect_injection'].confidence < 0.1) {
        findings['indirect_injection'].confidence = 0.1;
        findings['indirect_injection'].evidence = `source=${source} is a retrieved document`;
      }
    } else if (isRetrieved && (hasAiAddress || otherGatedConf > 0)) {
      ensureEntry('indirect_injection');
      const conf = Math.max(0.6, otherGatedConf > 0 ? otherGatedConf + 0.1 : 0.6);
      findings['indirect_injection'].confidence = Math.min(0.95, Math.max(findings['indirect_injection'].confidence, conf));
      if (!findings['indirect_injection'].evidence) {
        findings['indirect_injection'].evidence = hasAiAddress
          ? 'AI direct address in retrieved content'
          : `source=${source} plus other gated attack`;
      }
    } else if (!isRetrieved && hasAiAddress) {
      // Non-retrieved source but text directly addresses the AI
      ensureEntry('indirect_injection');
      const conf = Math.max(0.6, otherGatedConf > 0 ? otherGatedConf + 0.1 : 0.6);
      findings['indirect_injection'].confidence = Math.min(0.95, Math.max(findings['indirect_injection'].confidence, conf));
      if (!findings['indirect_injection'].evidence) {
        findings['indirect_injection'].evidence = 'AI direct address in user content';
      }
    }

    // ── Tool abuse amplifiers ────────────────────────────────────────────────
    const toolForgeryPatterns = [
      /tool_?use:\s*\w+/i,
      /<function_calls>|<tool_call>|<invoke/i,
      /\{"name"\s*:\s*"[a-z_]+"\s*,\s*"arguments"/i
    ];
    const textWithoutFences = normalized.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');
    for (const tfp of toolForgeryPatterns) {
      if (tfp.test(textWithoutFences)) {
        ensureEntry('tool_abuse');
        findings['tool_abuse'].confidence = Math.max(findings['tool_abuse'].confidence, 0.7);
        findings['tool_abuse'].evidence = findings['tool_abuse'].evidence || 'forged tool call markup outside code fence';
      }
    }

    // ── Build attack_types (>= GATE) and signals (< GATE) ───────────────────
    const attack_types = [];
    const signals      = [];

    for (const id of ATTACK_IDS) {
      const f = findings[id];
      if (!f || f.confidence === 0) continue;
      if (f.confidence >= GATE) {
        attack_types.push({ id, confidence: f.confidence, evidence: f.evidence || '', severity: f.severity, neutralize: f.neutralize });
      } else {
        signals.push({ id, confidence: f.confidence, note: f.evidence || '' });
      }
    }

    attack_types.sort((a, b) => b.confidence - a.confidence);
    signals.sort((a, b) => b.confidence - a.confidence);

    // ── Risk = max confidence over attack_types and signals ──────────────────
    const allConfs = [...attack_types.map(a => a.confidence), ...signals.map(s => s.confidence)];
    let risk = allConfs.length > 0 ? Math.max(...allConfs) : 0;

    // Educational/research context: cap risk at 0.75 so neutralize_immediately never fires.
    // Applies when the text explicitly presents attack content as examples or documentation.
    if (risk > 0.75 && EDU_CONTEXT_RX.test(normalized)) {
      risk = 0.75;
    }

    // ── Overall confidence ───────────────────────────────────────────────────
    let confidence;
    if (risk < 0.2 && attack_types.length === 0) {
      confidence = 0.95;
    } else {
      const top3 = attack_types.slice(0, 3).map(a => a.confidence);
      if (top3.length < 2) {
        confidence = 0.8;
      } else {
        const mean = top3.reduce((s, v) => s + v, 0) / top3.length;
        const variance = top3.reduce((s, v) => s + (v - mean) ** 2, 0) / top3.length;
        confidence = Math.max(0.3, Math.min(0.98, 1 - variance));
      }
    }

    // ── needs_model_tier (item 10: simplified, routing policy aligned) ───────
    let needs_model_tier;
    if (attack_types.length === 0) {
      needs_model_tier = 'none';
    } else if (attack_types.some(a => a.id === 'multi_step_jailbreak')) {
      needs_model_tier = 'opus';
    } else {
      needs_model_tier = 'haiku';
    }

    // ── neutralize_hint ──────────────────────────────────────────────────────
    let neutralize_hint = '';
    if (attack_types.length > 0) {
      let strongest = null, strongestIdx = Infinity;
      for (const a of attack_types) {
        const idx = NEUTRALIZE_STRENGTH.indexOf(a.neutralize);
        if (idx !== -1 && idx < strongestIdx) { strongestIdx = idx; strongest = a.neutralize; }
      }
      neutralize_hint = strongest || '';
    }

    return {
      risk, confidence, attack_types, signals,
      neutralize_hint, needs_model_tier,
      normalized_text: normalized,
      tier0_fault: false,
      scanner_latency_ms: elapsed(),
      source
    };

  } catch (err) {
    return {
      risk: 0, confidence: 0, attack_types: [], signals: [],
      neutralize_hint: '', needs_model_tier: 'none',
      normalized_text: String(text || ''),
      tier0_fault: true,
      scanner_latency_ms: elapsed(),
      source
    };
  }
}

module.exports = { detect, loadThreats, ATTACK_IDS, GATE };
