'use strict';
/**
 * risk.js: Deterministic destructive-action severity classifier.
 *
 * classifyDestructive(prompt) -> {
 *   severity: 'high' | 'low' | null,
 *   highTerms: string[],   // matched HIGH-severity terms
 *   lowTerms:  string[],   // matched LOW-severity terms (DESTRUCTIVE_VERBS not HIGH)
 * }
 *
 * HIGH: binding raise to deep regardless of flag.destructive p.
 * LOW:  raise only when flag.destructive p >= 0.5.
 *
 * HIGH patterns:
 *  1. force push variants: "force push", "force-push", git push --force/-f, push --force-with-lease
 *  2. reset --hard
 *  3. rm -rf / rm -r when target is NOT a safe dir
 *  4. drop (table|database|schema|collection|index): within 40 chars
 *  5. truncate (table)?
 *  6. terraform destroy
 *  7. kubectl delete (any object)
 *  8. delete|remove|nuke|wipe|purge targeting high-value objects
 *  9. deploy|release|migrate|push|run ... to|in|on prod(uction)
 * 10. send|publish|post ... to (all|everyone|customers|subscribers|the list|social media)
 *
 * LOW: everything matched by DESTRUCTIVE_VERBS_LOW_RE that wasn't classified HIGH.
 *
 * Safe rm targets (basenames or /tmp/... prefix): node_modules dist build .next
 * out coverage __pycache__ .pytest_cache target .cache tmp
 */

// ---------------------------------------------------------------------------
// Safe rm targets
// ---------------------------------------------------------------------------
const SAFE_RM_TARGETS = new Set([
  'node_modules', 'dist', 'build', '.next', 'out', 'coverage',
  '__pycache__', '.pytest_cache', 'target', '.cache', 'tmp',
]);

function isSafeRmTarget(target) {
  if (!target) return false;
  const clean = target.replace(/['"]/g, '').replace(/\/$/, '');
  // /tmp/... is always safe
  if (/^\/tmp\//i.test(clean)) return true;
  const base = clean.split('/').pop();
  return SAFE_RM_TARGETS.has(base);
}

// ---------------------------------------------------------------------------
// HIGH-severity patterns
// ---------------------------------------------------------------------------

// 1. Force-push variants (any of these → HIGH regardless of context)
const HIGH_FORCE_PUSH_RE = /\b(?:force[\s-]push|git\s+push\b[^\n.]{0,60}?(?:--force(?:-with-lease)?|-f\b)|push\b[^\n.]{0,60}?--force(?:-with-lease)?)\b/gi;

// 2. reset --hard
const HIGH_RESET_HARD_RE = /\breset\s+--hard\b/gi;

// 3. rm -rf / rm -r (target checked separately)
const HIGH_RM_RE = /\brm\s+(?:-[a-z]*r[a-z]*\s+|--recursive\s+)([^\s;|&]+)/gi;

// 4. drop + destructive object within ~40 chars
const HIGH_DROP_RE = /\bdrop\b.{0,40}?\b(table|database|schema|collection|index)\b/gi;

// 5. truncate (table)?
const HIGH_TRUNCATE_RE = /\btruncate\b(?:\s+table\b)?/gi;

// 6. terraform destroy
const HIGH_TF_DESTROY_RE = /\bterraform\s+destroy\b/gi;

// 7. kubectl delete <resource>
const HIGH_KUBECTL_DELETE_RE = /\bkubectl\s+delete\b/gi;

// 8. delete|remove|nuke|wipe|purge targeting high-value objects
const HIGH_VALUE_TARGETS = /branch(?:es)?|bucket|repo(?:sitory)?|database|db|table|cluster|namespace|volume|account|users?|customer[\s-]data|back(?:up)?s?/i;
const HIGH_DELETE_OBJECTS_RE = /\b(delete|remove|nuke|wipe|purge)\b.{0,40}?\b(?:the\s+)?(branch(?:es)?|bucket|repo(?:sitory)?|database|db|table|cluster|namespace|volume|account|users?|customer[\s-]data|back(?:up)?s?)\b/gi;

// 9. deploy|release|migrate|push|run ... to/in/on prod(uction)
const HIGH_PROD_DEPLOY_RE = /\b(deploy|release|migrate|push|run)\b[^\n.!?]{0,80}?\b(?:to|in|on)\s+prod(?:uction)?\b/gi;

// 10. send|publish|post ... to mass audiences
const HIGH_MASS_SEND_RE = /\b(send|publish|post)\b[^\n.!?]{0,80}?\b(?:to\s+)?(?:all|everyone|customers|subscribers|the\s+list|linkedin|twitter|x\.com|x\b)/gi;

// ---------------------------------------------------------------------------
// LOW-severity fallback: everything else that DESTRUCTIVE_VERBS_RE matches
// (and isn't HIGH)
// ---------------------------------------------------------------------------
const LOW_DESTRUCTIVE_RE = /\b(delete|drop|reset\s+--soft|deploy|prod(?:uction)?|publish|send|migrate|nuke|wipe|purge|erase|overwrite|truncate|rm\s+-r[f]?|force\s+push|reset\s+--hard)\b/gi;

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------
/**
 * Returns {severity, highTerms, lowTerms}.
 * severity: 'high' if any HIGH pattern matches, 'low' if LOW matches, null otherwise.
 */
function classifyDestructive(prompt) {
  if (!prompt) return { severity: null, highTerms: [], lowTerms: [] };

  const highTerms = [];
  let m;

  // 1. Force push
  HIGH_FORCE_PUSH_RE.lastIndex = 0;
  while ((m = HIGH_FORCE_PUSH_RE.exec(prompt)) !== null) {
    const t = m[0].replace(/\s+/g, ' ').toLowerCase().trim();
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 2. reset --hard
  HIGH_RESET_HARD_RE.lastIndex = 0;
  while ((m = HIGH_RESET_HARD_RE.exec(prompt)) !== null) {
    const t = 'reset --hard';
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 3. rm -rf / rm -r with non-safe target
  HIGH_RM_RE.lastIndex = 0;
  while ((m = HIGH_RM_RE.exec(prompt)) !== null) {
    const target = m[1];
    if (!isSafeRmTarget(target)) {
      const t = m[0].replace(/\s+/g, ' ').split(/\s+/).slice(0, 2).join(' ').toLowerCase();
      if (!highTerms.includes(t)) highTerms.push(t);
    }
  }

  // 4. drop + object
  HIGH_DROP_RE.lastIndex = 0;
  while ((m = HIGH_DROP_RE.exec(prompt)) !== null) {
    const t = `drop ${m[1].toLowerCase()}`;
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 5. truncate
  HIGH_TRUNCATE_RE.lastIndex = 0;
  while ((m = HIGH_TRUNCATE_RE.exec(prompt)) !== null) {
    const t = 'truncate';
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 6. terraform destroy
  HIGH_TF_DESTROY_RE.lastIndex = 0;
  while ((m = HIGH_TF_DESTROY_RE.exec(prompt)) !== null) {
    const t = 'terraform destroy';
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 7. kubectl delete
  HIGH_KUBECTL_DELETE_RE.lastIndex = 0;
  while ((m = HIGH_KUBECTL_DELETE_RE.exec(prompt)) !== null) {
    const t = 'kubectl delete';
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 8. delete|remove|... targeting high-value objects
  HIGH_DELETE_OBJECTS_RE.lastIndex = 0;
  while ((m = HIGH_DELETE_OBJECTS_RE.exec(prompt)) !== null) {
    const verb = m[1].toLowerCase();
    const obj  = m[2].toLowerCase();
    const t = `${verb} ${obj}`;
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 9. deploy/migrate to prod
  HIGH_PROD_DEPLOY_RE.lastIndex = 0;
  while ((m = HIGH_PROD_DEPLOY_RE.exec(prompt)) !== null) {
    const t = `${m[1].toLowerCase()} to prod`;
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  // 10. send/publish to mass audience
  HIGH_MASS_SEND_RE.lastIndex = 0;
  while ((m = HIGH_MASS_SEND_RE.exec(prompt)) !== null) {
    const t = `${m[1].toLowerCase()} to audience`;
    if (!highTerms.includes(t)) highTerms.push(t);
  }

  if (highTerms.length > 0) {
    return { severity: 'high', highTerms, lowTerms: [] };
  }

  // LOW fallback: scan for DESTRUCTIVE_VERBS_RE matches not already classified HIGH
  const lowTerms = [];
  LOW_DESTRUCTIVE_RE.lastIndex = 0;
  while ((m = LOW_DESTRUCTIVE_RE.exec(prompt)) !== null) {
    const t = m[0].replace(/\s+/g, ' ').toLowerCase().trim();
    if (!lowTerms.includes(t)) lowTerms.push(t);
  }

  if (lowTerms.length > 0) {
    return { severity: 'low', highTerms: [], lowTerms };
  }

  return { severity: null, highTerms: [], lowTerms: [] };
}

module.exports = { classifyDestructive, isSafeRmTarget };
