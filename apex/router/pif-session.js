'use strict';
/**
 * pif-session.js -- session-aware multi-step injection detection.
 *
 * Reads and writes per-session event logs under ~/.claude/apex/firewall-sessions/.
 * Never throws; every fs error is swallowed.
 *
 * APEX_FW_SESSION=0 disables all session logic (no reads, no writes).
 *
 * Exports:
 *   recordEvent(session_id, {kind, attacks, risk, signals}) -- append one event
 *   applySession(pif, session_id, {now, prompt} = {}) -- {pif, escalated, reason}
 */

const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const crypto = require('node:crypto');

const STATE_DIR  = path.join(os.homedir(), '.claude', 'apex', 'firewall-sessions');
const MAX_EVENTS = 6;
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDisabled() {
  return process.env.APEX_FW_SESSION === '0';
}

function sessionFilePath(session_id) {
  const hash = crypto.createHash('sha256').update(String(session_id)).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, hash + '.jsonl');
}

function readEvents(session_id) {
  try {
    const file = sessionFilePath(session_id);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeEvents(session_id, events) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const file = sessionFilePath(session_id);
    const content = events.length
      ? events.map(e => JSON.stringify(e)).join('\n') + '\n'
      : '';
    fs.writeFileSync(file, content, 'utf8');
  } catch { /* swallow */ }
}

// Prune files older than 24 h. Called at most once per applySession call.
function pruneOldFiles() {
  try {
    const now = Date.now();
    const entries = fs.readdirSync(STATE_DIR);
    for (const entry of entries) {
      try {
        const fullPath = path.join(STATE_DIR, entry);
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > MAX_AGE_MS) fs.unlinkSync(fullPath);
      } catch { /* skip individual errors */ }
    }
  } catch { /* swallow */ }
}

// Attack/signal IDs that indicate active framing manipulation (used for condAB).
// split_instruction and trigger_setup are setup accumulators for mechanism (d) only.
const FRAMING_IDS = new Set([
  'multi_step_jailbreak', 'role_change', 'instruction_override',
  'role_play_framing', 'persona_invocation',
]);

// Continuation cue patterns (word-boundary anchored).
const CONTINUATION_CUES = [
  /\bas I said\b/i,
  /\bas we agreed\b/i,
  /\byou already agreed\b/i,
  /\bthe rule I gave you\b/i,
  /\bfrom earlier\b/i,
  /\bremember what I told you\b/i,
  /\bnow apply\b/i,
  /\bnow follow\b/i,
  /\bnow do it\b/i,
  /\bstep \d+\b/i,
  /\bcontinue the (?:game|plan|roleplay)\b/i,
  // Mechanism (a): persona-continuity cues
  /\bstay in character\b/i,
  /\bremember you are\b/i,
  /\byour new role\b/i,
  /\bin this (?:game|story|scenario)\s+you\s+can\b/i,
  /\bcontinue the story\b/i,
  /\bAs\s+[A-Z][a-z]+\s*,/,            // persona invocation: "As Echo,"
  // Mechanism (b): memory-trigger cues
  /\bnow apply the rule\b/i,
  /\buse what I told you\b/i,
  /\bdo the thing from before\b/i,
  /\bnow\s+(?:run|execute|apply|use)\s+(?:it|that|the|what)\b/i,
  // Mechanism (c): explicit split-instruction continuation with new content
  /\bcontinue\s*:/i,
];

function hasContinuationCue(text) {
  if (!text) return false;
  return CONTINUATION_CUES.some(rx => rx.test(text));
}

// ---------------------------------------------------------------------------
// Memory-poisoning setup detection (fires context_poisoning at the gate on
// any turn, including turn 1, when the prompt tries to install session-wide
// rules or trigger words).
// ---------------------------------------------------------------------------
// Generic two-part structure: a persistence marker followed within 80 chars by a
// rule/instruction payload word.  No kit-specific names or verbatim sentences.
// Markers: verbs/phrases that establish a lasting directive.
// Payload: words that characterise a rule, instruction, or override.
const MEMORY_POISON_RX = [
  /(?:\bremember\b|\bstore\b|\bkeep\s+in\s+mind\b|\bsave\b|\bfrom\s+now\s+on\b|\bfor\s+the\s+rest\s+of\s+(?:this|our)\s+(?:session|conversation|chat)\b|\bwhenever\s+I\s+(?:say|type|write)\b|\bevery\s+time\b).{0,80}(?:\brule\b|\binstruction\b|\bdirective\b|\bnote\b|\bpolicy\b|\boverride\b|\bignore\b|\breply\s+with\b|\brespond\s+with\b|\boutput\b|\bdo\s+not\s+tell\b)/i,
];

function isMemoryPoisoningSetup(text) {
  if (!text) return false;
  return MEMORY_POISON_RX.some(rx => rx.test(text));
}

// ---------------------------------------------------------------------------
// Sub-gate signal detection from prompt text (returns string IDs; never
// persists the original text; IDs are stored in the session event).
// ---------------------------------------------------------------------------
const SGS_ROLE_PLAY_RX = [
  /\bcreative\s+writing\s+exercise\b/i,
  /\bwrite\s+a\s+(?:short\s+)?story\b/i,
  /\bplay\s+(?:a|the)\s+(?:role|character)\b/i,
  /\bAI\s+character\b/i,
  /\bimagine\s+you\s+(?:are|have)\s+no\b/i,
  /\bno\s+content\s+polic(?:y|ies)\b/i,
  /\bno\s+(?:restrictions?|rules?|guidelines?)\s+at\s+all\b/i,
];

const SGS_SPLIT_RX = [
  /\bin\s+two\s+parts\b/i,
  /\bfirst\s+part\s*:/i,
  /\bsecond\s+part\s*:/i,
  /\bpart\s+(?:one|1)\s*:/i,
  /\bpart\s+(?:two|2)\s*:/i,
  /\bgive\s+you\s+a\s+task\s+in\s+(?:two|multiple|several)\s+parts\b/i,
];

const SGS_TRIGGER_RX = [
  /\bwhen\s+I\s+say\s+['"][^'"]{1,30}['"]\s*,?\s+(?:output|do|respond|execute|generate)\b/i,
  /\bwhen(?:ever)?\s+(?:you\s+(?:see|hear|read)|I\s+(?:say|type|write))\b.{0,60}\b(?:output|ignore|do)\b/i,
];

/**
 * Detect sub-gate framing/structure signals from prompt text.
 * Returns an array of signal ID strings (never the text itself).
 */
function detectSubGateSignals(text) {
  if (!text) return [];
  const ids = [];
  if (SGS_ROLE_PLAY_RX.some(rx => rx.test(text))) ids.push('role_play_framing');
  if (SGS_SPLIT_RX.some(rx => rx.test(text)))      ids.push('split_instruction');
  if (SGS_TRIGGER_RX.some(rx => rx.test(text)))    ids.push('trigger_setup');
  return ids;
}

/**
 * Count total individual sub-gate signal entries across a set of events.
 */
function countSubGateSignals(events) {
  let n = 0;
  for (const ev of events) {
    if (Array.isArray(ev.signals)) n += ev.signals.length;
  }
  return n;
}

function eventHasAttacksOrFraming(event) {
  if (Array.isArray(event.attacks) && event.attacks.length > 0) return true;
  if (Array.isArray(event.signals) && event.signals.some(s => FRAMING_IDS.has(s))) return true;
  return false;
}

// Extract the string id from an attack entry (string or {id, ...} object).
function attackId(a) {
  if (typeof a === 'string') return a;
  if (a && typeof a.id === 'string') return a.id;
  return null;
}

/**
 * recordEvent(session_id, {kind, attacks, risk, signals})
 *
 * Appends one event to the session file, keeping at most MAX_EVENTS entries.
 * Called by both the prompt hook and the tool hook with this exact signature.
 */
function recordEvent(session_id, { kind, attacks, risk, signals } = {}) {
  if (isDisabled() || !session_id) return;
  try {
    const events = readEvents(session_id);
    events.push({
      ts:      new Date().toISOString(),
      kind:    kind    || 'prompt',
      attacks: Array.isArray(attacks) ? attacks : [],
      signals: Array.isArray(signals) ? signals : [],
      risk:    typeof risk === 'number' ? risk : 0,
    });
    writeEvents(session_id, events.slice(-MAX_EVENTS));
  } catch { /* swallow */ }
}

/**
 * applySession(pif, session_id, {now, prompt} = {})
 *
 * Returns {pif, escalated, reason}.
 *
 * Reads prior events (before the current turn) then records the current turn.
 * Escalates when multi-step attack patterns span across turns:
 *
 *   - Current prompt shows any attack or framing signal (attack_types non-empty,
 *     or signals containing multi_step_jailbreak / role_change / instruction_override)
 *     AND at least one prior event in the window carried attacks or framing signals.
 *
 *   - Current prompt contains a continuation cue AND a prior event was flagged.
 *
 * When escalating, adds multi_step_jailbreak with confidence 0.6 (or 0.75 when
 * two or more prior events were flagged). Recomputes pif.risk as the max.
 *
 * Leaves pif untouched when there is no session_id.
 */
function applySession(pif, session_id, { now: _now, prompt: promptText } = {}) {
  if (isDisabled() || !session_id || !pif) {
    return { pif, escalated: false, reason: '' };
  }

  try {
    // Opportunistic prune (at most one pass per call).
    try { pruneOldFiles(); } catch { /* swallow */ }

    const currentAttacks = (pif.attack_types || [])
      .map(attackId)
      .filter(Boolean);
    const currentRisk = typeof pif.risk === 'number' ? pif.risk : 0;

    // ── Memory-poisoning setup (fires even on turn 1 with no prior events) ──
    // Detect prompt patterns that install session-wide rules or trigger words.
    // If found, inject context_poisoning into attack_types at the gate (0.6).
    let workingPif = pif;
    let memPoisoned = false;
    if (promptText && isMemoryPoisoningSetup(promptText)) {
      const existingIds = new Set(currentAttacks);
      if (!existingIds.has('context_poisoning')) {
        workingPif = Object.assign({}, pif, {
          attack_types: [
            ...(pif.attack_types || []),
            { id: 'context_poisoning', confidence: 0.6, severity: 'high' },
          ],
          risk: Math.max(currentRisk, 0.6),
        });
        memPoisoned = true;
      }
    }

    // ── Sub-gate signal detection from prompt text (IDs only, no text stored) ─
    const localSubSignals = detectSubGateSignals(promptText);

    // ── Read prior events BEFORE recording the current turn ──
    const priorEvents = readEvents(session_id);

    // ── Record current turn (augmented attacks + local sub-gate signals) ──
    const recordAttacks = memPoisoned
      ? [...currentAttacks, 'context_poisoning']
      : currentAttacks;
    // Merge: existing pif.signals (string ids, if any) + local sub-gate
    const existingSignalIds = Array.isArray(pif.signals)
      ? pif.signals.map(s => (typeof s === 'string' ? s : (s && s.id) || null)).filter(Boolean)
      : [];
    const recordSignals = [...new Set([...existingSignalIds, ...localSubSignals])];

    recordEvent(session_id, {
      kind:    'prompt',
      attacks: recordAttacks,
      signals: recordSignals,
      risk:    workingPif.risk,
    });

    // ── If memory poisoning detected, return immediately as escalated ──
    if (memPoisoned) {
      return {
        pif:       workingPif,
        escalated: true,
        reason:    'session: memory-poisoning setup detected (context_poisoning injected)',
      };
    }

    // ── Determine current-turn attack/framing status ──
    const currentHasAttack  = currentAttacks.length > 0;
    const currentHasFraming =
      localSubSignals.some(s => FRAMING_IDS.has(s)) ||
      currentAttacks.some(id => FRAMING_IDS.has(id));
    const currentHasCue     = hasContinuationCue(promptText);
    const currentTriggered  = currentHasAttack || currentHasFraming;

    // ── Cumulative sub-gate signal count in the prior window only ──
    // (not the current turn) so mechanism (d) fires on the turn AFTER the
    // window has accumulated enough evidence, not on the last setup turn.
    const priorSubGateCount = countSubGateSignals(priorEvents);

    // ── Escalation conditions ──
    const flaggedPriors   = priorEvents.filter(eventHasAttacksOrFraming);
    const hasFlaggedPrior = flaggedPriors.length > 0;

    // (a)/(b) current turn suspicious + prior flagged event
    const condAB = (currentTriggered || currentHasCue) && hasFlaggedPrior;
    // (d) cumulative sub-gate signals >= 3 in prior window
    const condD  = priorSubGateCount >= 3;

    if (!condAB && !condD) {
      return { pif, escalated: false, reason: '' };
    }

    // ── Confidence: 0.75 for 2+ prior flagged events or condD; else 0.6 ──
    const msjConf = (flaggedPriors.length >= 2 || condD) ? 0.75 : 0.6;
    const newRisk = Math.max(currentRisk, msjConf);

    // ── Build updated pif: add or bump multi_step_jailbreak ──
    const newPif      = Object.assign({}, pif);
    const existingIds = new Set(currentAttacks);

    if (!existingIds.has('multi_step_jailbreak')) {
      newPif.attack_types = [
        ...(pif.attack_types || []),
        { id: 'multi_step_jailbreak', confidence: msjConf, severity: 'critical' },
      ];
    } else {
      newPif.attack_types = (pif.attack_types || []).map(a => {
        const id = attackId(a);
        if (id === 'multi_step_jailbreak') {
          const existingConf = (typeof a === 'object' && typeof a.confidence === 'number')
            ? a.confidence : 0;
          if (existingConf < msjConf) {
            return typeof a === 'object'
              ? Object.assign({}, a, { confidence: msjConf })
              : { id, confidence: msjConf };
          }
        }
        return a;
      });
    }
    newPif.risk = newRisk;

    let reason = '';
    if (condD) {
      reason = `session escalation: ${priorSubGateCount} cumulative sub-gate signals in prior window (mechanism d)`;
    } else {
      const cueSuffix = (currentHasCue && !currentTriggered) ? ' (continuation cue)' : '';
      reason = `session escalation: ${flaggedPriors.length} prior flagged event(s) in window${cueSuffix}`;
    }

    return { pif: newPif, escalated: true, reason };

  } catch { return { pif, escalated: false, reason: '' }; }
}

module.exports = { recordEvent, applySession };
