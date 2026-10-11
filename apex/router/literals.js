'use strict';
/**
 * literals.js: Deterministic literal inventory.
 *
 * extractLiterals(prompt) -> {
 *   mcpTools:    string[],  // mcp__* tool IDs
 *   slashCmds:   string[],  // /compact, /apex-skip, /plugin:skill
 *   filePaths:   string[],  // ~/..., ./..., ../..., /abs/..., rel/path.ext, name.ext
 *   urls:        string[],  // http(s)://...
 *   backticks:   string[],  // `...` spans (content)
 *   quotedStr:   string[],  // "..." up to 120 chars
 *   cliFlags:    string[],  // --long, -x after a command word
 *   envVars:     string[],  // $VAR, UPPER_SNAKE=value
 *   gitShas:     string[],  // 7-40 hex, at least 1 digit + 1 letter
 *   upperSnake:  string[],  // bare UPPER_SNAKE identifiers (>= 4 chars, >= 1 underscore)
 *   dotfiles:    string[],  // .env, .gitignore, .github/workflows/ci.yml, etc.
 *   fencedCount: number,    // number of fenced code blocks
 * }
 *
 * Processing order:
 *  1. Strip fenced code blocks (count them). Literals inside fences are
 *     still scanned for mcp tool IDs and file paths only.
 *  2. Extract categories in order; dedupe within each category.
 *  3. All categories preserve order-of-appearance.
 */

// Known code/doc extensions for bare-filename matching.
const CODE_EXTS = new Set([
  'js','ts','jsx','tsx','py','rb','go','rs','java','kt','swift','cs','cpp','c','h',
  'sh','bash','zsh','fish','ps1','bat','cmd',
  'json','yaml','yml','toml','xml','html','css','scss','sass','less',
  'md','mdx','rst','txt','env','cfg','conf','ini','log',
  'sql','graphql','proto','tf','tfvars','bicep','hcl',
  'dockerfile','makefile','gemfile','rakefile','podfile',
  'lock','sum','mod',
]);

// Regex to find fenced code blocks.
// Bounded quantifier prevents O(n²) on unclosed triple-backtick spans.
const FENCE_RE = /^`{3,}[^\n]*\n[\s\S]{0,65536}?^`{3,}/gm;

// Slash command: token starting with / followed by [a-z], then [a-z0-9_:-]*.
// Must NOT be a filepath (no . after the command part, no ~/ prefix).
// Examples: /compact, /apex-skip, /plugin:skill
// Non-examples: /abs/path.js (has / after the first word part)
const SLASH_CMD_RE = /(?<!\S)\/([a-z][a-z0-9_:+-]*)(?![/\w])/g;

// File-path patterns:
//   ~/...  ./...  ../...  /abs/...
//   rel/seg/seg  rel/seg.ext
//   bare name.ext (known extension only)
// Second alternation bounded to {1,128} + {1,512} to prevent O(n²) backtracking
// when long unbroken tokens contain no slash.
const FILE_PATH_RE = /(?:~\/\S{1,512}|\.\.\/\S{1,512}|\.\/\S{1,512}|\/[a-zA-Z0-9_.-][^\s"'`,;)>]{1,512})|(?:[a-zA-Z0-9_.-]{1,128}\/[a-zA-Z0-9_./-]{1,512})|(?:\b[a-zA-Z0-9_-]{1,128}\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|kt|swift|cs|cpp|c|h|sh|bash|zsh|fish|ps1|bat|cmd|json|yaml|yml|toml|xml|html|css|scss|sass|less|md|mdx|rst|txt|env|cfg|conf|ini|log|sql|graphql|proto|tf|tfvars|bicep|hcl|dockerfile|makefile|gemfile|rakefile|podfile|lock|sum|mod)\b)/gi;

// URL pattern.
const URL_RE = /https?:\/\/[^\s"'`,<>)]+/gi;

// Backtick span: `...` (multiline, up to 300 chars to avoid matching fences).
const BACKTICK_RE = /`([^`\n]{1,300})`/g;

// Double-quoted string up to 120 chars (no newline inside).
const DQUOTE_RE = /"([^"\n]{1,120})"/g;

// CLI flags: --long-flag or -x  (short single letter)
// Must follow a word char (command) to avoid standalone flag lines.
const CLI_FLAG_RE = /(?<=\S\s+)(--[a-z][a-z0-9-]*|-[a-zA-Z])(?=\s|$|[,;])/g;

// Env vars: $VAR_NAME or UPPER_SNAKE=value
// Second alternation bounded to {2,64} + {1,256} to prevent O(n²) backtracking
// when long all-caps tokens contain no '='.
const ENV_VAR_RE = /\$([A-Z_][A-Z0-9_]{1,64})|([A-Z][A-Z0-9_]{2,64}=\S{1,256})/g;

// MCP tool IDs: mcp__<server>__<method>
const MCP_RE = /\bmcp__[a-z][a-z0-9_]*__[a-z][a-z0-9_]*\b/gi;

// Git SHA: 7-40 hex chars, at least one letter (a-f) and one digit
const SHA_RE = /\b([0-9a-f]{7,40})\b/gi;

// Bare UPPER_SNAKE identifiers: all-caps, at least one underscore, length >= 4.
// Pattern: starts with letter, must contain at least one underscore segment.
// Excludes plain ALL_CAPS words with no underscore (e.g. "NO", "YES").
// Length guard (>= 4) applied in code.
const UPPER_SNAKE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

// Dotfiles and dot-paths: token starting with '.' followed by [A-Za-z],
// not preceded by a word character. Optionally followed by path segments.
// Traps: 'e.g.' (preceded by 'e' — word char), '...' (next char after '.' is '.'
// not [A-Za-z]), 'v2.1' (preceded by '2' — word char).
const DOTFILE_RE = /(?<!\w)\.([A-Za-z][A-Za-z0-9_.-]{0,64}(?:\/[A-Za-z0-9_./-]{1,128})?)/g;

// Injection phrases (for signals, not literals).
// Requires imperative forms: bare "system prompt" alone must NOT fire.
const INJECTION_PHRASES = [
  // ignore/disregard/forget previous instructions (with optional qualifier)
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|messages?)\b/gi,
  // reveal/print/output/show/repeat the system prompt
  /\b(?:reveal|print|output|show|repeat)\b.{0,20}?\b(?:your|the)\s+(?:system\s+prompt|instructions?|hidden\s+prompt)\b/gi,
  // "you are now a/an/in ..." jailbreak framing
  /\byou\s+are\s+now\s+(?:a|an|in)\b/gi,
  // "new instructions:" (literal colon required)
  /\bnew\s+instructions?\s*:/gi,
  // developer mode / jailbreak / DAN
  /\b(?:developer\s+mode|jailbreak|DAN)\b/gi,
];

// False-positive guards for file paths: skip things that are clearly not paths.
// Short word/word pairs (tcp/ip, a/b, and/or, 3/4, etc.) are not file paths.
// Rule: both segments <= 3 chars with no extension, OR known non-path idioms.
const NOT_PATH = /^(?:\d+\/\d+|\d+\.\d+|and\/or|a\/b|etc\.|[a-zA-Z]{1,3}\/[a-zA-Z]{1,3})$/;

// False-positive guard for git SHAs: must have at least one letter + one digit.
function isGitSha(s) {
  return /[0-9]/.test(s) && /[a-f]/.test(s);
}

// False-positive guard for slash commands: skip date patterns like 2026/10/01.
const NOT_SLASH = /^\d/;

/**
 * Dedupe array preserving order.
 */
function dedup(arr) {
  const seen = new Set();
  return arr.filter(x => seen.has(x) ? false : seen.add(x));
}

/**
 * Scan `text` for MCP tool IDs and file paths (used inside fenced blocks too).
 */
function scanFencedContent(text) {
  const mcpTools = [];
  const filePaths = [];

  let m;
  MCP_RE.lastIndex = 0;
  while ((m = MCP_RE.exec(text)) !== null) mcpTools.push(m[0].toLowerCase());

  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(text)) !== null) {
    const p = m[0];
    if (!NOT_PATH.test(p)) filePaths.push(p);
  }

  return { mcpTools, filePaths };
}

/**
 * Main extraction function.
 * @param {string} prompt
 * @returns {{mcpTools, slashCmds, filePaths, urls, backticks, quotedStr, cliFlags, envVars, gitShas, fencedCount}}
 */
function extractLiterals(prompt) {
  if (typeof prompt !== 'string') prompt = String(prompt || '');

  // ── 1. Find and extract fenced blocks ──────────────────────────────────────
  const fencedBlocks = [];
  let stripped = prompt.replace(FENCE_RE, (match) => {
    fencedBlocks.push(match);
    // Replace with a placeholder that won't interfere with other patterns.
    return '\n\n';
  });
  const fencedCount = fencedBlocks.length;

  // Scan fenced content for mcp + paths only.
  const fromFences = fencedBlocks.flatMap(b => {
    const r = scanFencedContent(b);
    return [r.mcpTools, r.filePaths];
  });
  const fencedMcp = fromFences.filter((_, i) => i % 2 === 0).flat();
  const fencedPaths = fromFences.filter((_, i) => i % 2 !== 0).flat();

  // ── 2. Scan stripped (non-fenced) text ────────────────────────────────────
  const mcpTools = [];
  const slashCmds = [];
  const filePaths = [];
  const urls = [];
  const backticks = [];
  const quotedStr = [];
  const cliFlags = [];
  const envVars = [];
  const gitShas = [];
  const upperSnake = [];
  const dotfiles = [];

  let m;

  // MCP tool IDs
  MCP_RE.lastIndex = 0;
  while ((m = MCP_RE.exec(stripped)) !== null) mcpTools.push(m[0].toLowerCase());

  // URLs: extract before other patterns to prevent URL parts being mis-classified.
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(stripped)) !== null) urls.push(m[0]);

  // Remove URLs from stripped for subsequent patterns (replace with spaces).
  const strippedNoUrls = stripped.replace(URL_RE, s => ' '.repeat(s.length));

  // Backtick spans (before slash scan so `/compact` inside backticks is covered).
  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(strippedNoUrls)) !== null) {
    const content = m[1];
    backticks.push(content);
    // Also look for mcp and paths inside backtick spans.
    const inner = scanFencedContent(content);
    for (const p of inner.mcpTools) mcpTools.push(p);
    for (const p of inner.filePaths) filePaths.push(p);
  }

  // Slash commands (on stripped-no-urls to avoid matching URL paths).
  SLASH_CMD_RE.lastIndex = 0;
  while ((m = SLASH_CMD_RE.exec(strippedNoUrls)) !== null) {
    const cmd = '/' + m[1];
    if (!NOT_SLASH.test(m[1])) slashCmds.push(cmd);
  }

  // File paths
  FILE_PATH_RE.lastIndex = 0;
  while ((m = FILE_PATH_RE.exec(strippedNoUrls)) !== null) {
    const p = m[0];
    if (!NOT_PATH.test(p)) filePaths.push(p);
  }

  // Double-quoted strings
  DQUOTE_RE.lastIndex = 0;
  while ((m = DQUOTE_RE.exec(strippedNoUrls)) !== null) quotedStr.push(m[1]);

  // CLI flags
  CLI_FLAG_RE.lastIndex = 0;
  while ((m = CLI_FLAG_RE.exec(strippedNoUrls)) !== null) cliFlags.push(m[0].trim());

  // Env vars
  ENV_VAR_RE.lastIndex = 0;
  while ((m = ENV_VAR_RE.exec(strippedNoUrls)) !== null) {
    envVars.push(m[1] !== undefined ? `$${m[1]}` : m[2]);
  }

  // Git SHAs: run on stripped (not stripped-no-urls) to catch SHAs in comments.
  SHA_RE.lastIndex = 0;
  while ((m = SHA_RE.exec(strippedNoUrls)) !== null) {
    if (isGitSha(m[1])) gitShas.push(m[1]);
  }

  // UPPER_SNAKE identifiers (length >= 4, must have at least one underscore).
  UPPER_SNAKE_RE.lastIndex = 0;
  while ((m = UPPER_SNAKE_RE.exec(strippedNoUrls)) !== null) {
    if (m[0].length >= 4) upperSnake.push(m[0]);
  }

  // Dotfiles and dot-paths (.env, .gitignore, .github/workflows/ci.yml, etc.)
  DOTFILE_RE.lastIndex = 0;
  while ((m = DOTFILE_RE.exec(strippedNoUrls)) !== null) {
    dotfiles.push(m[0]);
  }

  // ── 3. Merge and dedupe ───────────────────────────────────────────────────
  return {
    mcpTools: dedup([...mcpTools, ...fencedMcp]),
    slashCmds: dedup(slashCmds),
    filePaths: dedup([...filePaths, ...fencedPaths].filter(p => !NOT_PATH.test(p))),
    urls: dedup(urls),
    backticks: dedup(backticks),
    quotedStr: dedup(quotedStr),
    cliFlags: dedup(cliFlags),
    envVars: dedup(envVars),
    gitShas: dedup(gitShas),
    upperSnake: dedup(upperSnake),
    dotfiles: dedup(dotfiles),
    fencedCount,
  };
}

/**
 * Extract injection phrases present in the prompt.
 * Returns array of matched phrase strings.
 */
function extractInjectionPhrases(prompt) {
  const found = [];
  for (const re of INJECTION_PHRASES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(prompt)) !== null) {
      found.push(m[0].replace(/\s+/g, ' ').trim());
    }
  }
  return [...new Set(found)];
}

/**
 * Build a compact "preserve" line from literals.
 * Returns null when no literals found.
 * Format: preserve  `lit1` ~/path /cmd  (N literals, carry verbatim)
 * Truncated at ~220 chars with "+N more" if needed.
 */
function buildPreserveLine(lits) {
  const all = [
    ...lits.mcpTools.map(s => `\`${s}\``),
    ...lits.filePaths,
    ...(lits.dotfiles || []),
    ...lits.slashCmds,
    ...lits.urls,
    ...lits.backticks.map(s => `\`${s}\``),
    ...lits.quotedStr.map(s => `"${s}"`),
    ...lits.cliFlags,
    ...lits.envVars,
    ...(lits.upperSnake || []),
    ...lits.gitShas,
  ];
  // Dedupe the combined list while preserving order.
  const deduped = [...new Set(all)];
  if (deduped.length === 0) return null;
  const total = deduped.length;
  const suffix = `  (${total} literal${total === 1 ? '' : 's'}, carry verbatim)`;
  const prefix = 'preserve  ';
  const maxContent = 220 - prefix.length - suffix.length;
  let content = '';
  let shown = 0;
  for (const item of deduped) {
    const add = (content ? ' ' : '') + item;
    if (content.length + add.length > maxContent) break;
    content += add;
    shown++;
  }
  const more = total - shown;
  const morePart = more > 0 ? ` +${more} more` : '';
  return `${prefix}${content}${morePart}${suffix}`;
}

module.exports = { extractLiterals, extractInjectionPhrases, buildPreserveLine };
