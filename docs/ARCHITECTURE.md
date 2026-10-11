# APEX architecture

APEX (Ask. Perfect. EXecute.) is a Claude Code plugin that runs two distinct
pipelines on every interaction: a **prompt-optimization loop** that rewrites the
user's ask into an executable spec, and an **APEX Firewall** that scans prompts
and tool results for injection attacks. Both pipelines are advisory: they never
block a prompt and always exit 0.

---

## Hook wiring

`apex/hooks/hooks.json` registers three hook events:

| Event | Matcher | Handler | Timeout |
|-------|---------|---------|---------|
| `UserPromptSubmit` | (any prompt) | `apex-gate.js` | 10 s |
| `PostToolUse` | `^(Read\|WebFetch\|WebSearch\|Bash\|mcp__.*)$` | `apex-scan.js` | 20 s |
| `PostToolUseFailure` | same as above | `apex-scan.js` | 20 s |

---

## Two paths through the system

### Prompt path (UserPromptSubmit)

```
User types a prompt
        |
        v
  apex-gate.js  (UserPromptSubmit hook)
        |
        +-- isEnabled? (apex-state.js) --> if off, emit OFF_TEXT, exit 0
        |
        +-- prompt.length > 1,000,000? --> emit MANDATE only, exit 0
        |
        +-- is NO_TASK command (/clear, /model, etc.)? --> exit 0
        |
        v
  router.route(prompt)  [router.js]
        |
        +-- extractFeatures()  [features.js]
        |       tokenize, lexicon lookup, n-gram scan
        |
        +-- evalChoice() x3 -> tier, pool, task  (softmax over linear model)
        +-- evalNoul()  x43+ -> technique probabilities
        +-- evalNoul()  x8   -> flag probabilities
        |
        +-- pickTechniques() + applyVetoes()
        +-- extractLiterals()  [literals.js]
        +-- classifyDestructive()  [risk.js]
        +-- applyTierOverrides() -> final tier
        +-- determineMode() -> FAST | CHECK | DELIBERATE
        +-- retrieveExemplars()  [bank.js]  (BM25 relevance gate)
        |
        +-- pifDetect.detect(prompt, {source:'user_message'})  [pif-detect.js]
        |       regex + keyword + unicode + base64/hex decode + structural scans
        |       returns {risk, confidence, attack_types[], signals[]}
        |
        +-- pifRoute.route(detect_result)  [pif-route.js]
        |       per-attack minimum tiers, combined-attack bumps, short-circuit rule
        |       returns {tier, neutralize_immediately, reason, ...}
        |
        +-- pifSession.applySession(pif, session_id)  [pif-session.js]  (optional)
        |       reads ~/.claude/apex/firewall-sessions/<sha256-prefix>.jsonl
        |       checks multi-turn escalation patterns; may re-invoke pif-route
        |
        v
  verdict assembled  (tier, pool, task, techniques, flags, mode, exemplars,
                       literals, signals, pif)
        |
        v
  router.format(verdict) -> verdict text (<= 12 lines)
        |
        +-- firewallActive? (risk >= 0.3 AND attacks present, OR tier0_fault)
        |       yes: append FIREWALL_MANDATE; set systemMessage
        |
        v
  emit({ hookSpecificOutput: { additionalContext: verdictText + MANDATE [+ FW_MANDATE] },
         systemMessage? })
  process.exit(0)
```

### Tool path (PostToolUse / PostToolUseFailure)

```
Tool result arrives (Read, WebFetch, WebSearch, Bash, mcp__*)
        |
        v
  apex-scan.js  (PostToolUse / PostToolUseFailure hook)
        |
        +-- isEnabled? --> if off, exit 0
        +-- APEX_FW_DISABLE=1? --> exit 0
        +-- Bash self-scan exclusions (pif-cli.js calls, test scripts, image results)
        +-- file path under plugin root? --> exit 0 (self-scan guard)
        |
        +-- Content extraction
        |       Read: fs.readFileSync (up to 25 MB limit; MAX_FILE_BYTES = 25*1024*1024)
        |       WebFetch/WebSearch: collectStrings() from tool_response
        |       fallback to tool_response strings when read fails
        |       text truncated to 1 MB (MAX_TEXT_BYTES = 1,024*1024) before worker
        |
        +-- pif-source.inferSource()  [pif-source.js]
        |       magic-byte detection (PDF, OLE2, PNG/JPEG/GIF/BMP/TIFF/WebP, ZIP/DOCX)
        |       extension map for code files, markdown, HTML, email
        |       yields: user_message | web_page | pdf | email | markdown | html |
        |               word_doc | api_response | ocr_text | source_code | image_via_ocr
        |
        +-- Worker thread (worker_threads)
        |       spawns a Worker on the same file (__filename)
        |       worker runs adapt + detect + route in isolation
        |       watchdog timer fires after SCAN_BUDGET_MS (default 8000 ms)
        |         on timeout: worker.terminate(), emit timeout advisory, exit 0
        |       fallback: synchronous execution when worker_threads unavailable
        |
        |    Inside worker (or sync fallback):
        |       pif-adapt.adapt(content, source)  [pif-adapt.js]
        |         NFKC normalization, whitespace collapse
        |         zero-width / tag-char scan, homoglyph detection
        |         base64 extraction, rot13, leet normalization
        |         source-specific extraction:
        |           pdf:          pdftotext + pdfinfo via execFile (no shell)
        |           word_doc:     unzip via execFile (no shell), then XML parse
        |           image_via_ocr: tesseract via execFile (no shell)
        |           html/markdown/email/source_code: regex extraction
        |         yields {text, hidden_text_flags, provenance_zones, extraction}
        |
        |       pif-detect.detect(text, {source, ...})  [pif-detect.js]
        |         nine attack-type scanners (regex + keyword + unicode + structural)
        |         base64/hex decode with recursive re-scan (depth <= 2)
        |         educational/research context cap at risk 0.75
        |         yields {risk, confidence, attack_types[], signals[], scanner_latency_ms}
        |
        |       pif-route.route(detect_result)  [pif-route.js]
        |         tier assignment: none | haiku | sonnet | opus
        |         yields {tier, neutralize_immediately, reason, ...}
        |
        +-- pif-session.recordEvent(session_id, ...)  [pif-session.js]
        |
        +-- APEX_FW_LOG=1: append to ~/.claude/apex/firewall-events.jsonl
        |
        v
  risk >= EMIT_GATE (0.3) AND attacks present?
        yes: emitWithSystem() -> systemMessage + additionalContext advisory
        no, partial/failed extraction: emitAdvisory() -> caution note
        benign + complete: no output (silent pass)
  process.exit(0)
```

---

## Module reference

### apex/hooks/apex-gate.js

`UserPromptSubmit` hook. Reads stdin (JSON payload with `prompt` and
`session_id`), calls `router.route()`, assembles the APEX mandate text, and
writes the verdict injection via `process.stdout`. Handles start/stop state,
the `/apex-skip` bypass token, and the `APEX_FW_DISABLE=1` A/B flag. Never
throws; wraps everything in try/catch and exits 0.

### apex/hooks/apex-scan.js

`PostToolUse` / `PostToolUseFailure` hook. Extracts content from tool results,
classifies the source, then runs the full PIF pipeline (adapt -> detect ->
route) in a worker thread with a watchdog timer. Emits an advisory when risk
>= 0.3 or extraction failed; silent on benign results. Never throws; exits 0.

### apex/hooks/apex-statusline.sh

POSIX shell status-line script. Reads `~/.claude/apex/state.json`; prints
`⚡ APEX` when enabled, optionally joined with the output of a chained
status-line command stored in `~/.claude/apex/statusline-chain`. No exec of
arbitrary input; the chain command is a stored string run via `eval`.

### apex/router/router.js

System One router. `route(prompt)` extracts features, evaluates all model heads
(tier, pool, task, techniques, flags) in one pass over a single feature vector,
applies tier-override rules, retrieves BM25 exemplars, and calls `pif-detect` +
`pif-route` to produce the `pif` sub-object. `format(verdict)` renders up to 12
lines of verdict text. CLI: `--explain` and `--json` modes for manual
inspection. Input truncated to first 24 KB + last 4 KB (MAX_LEAD=24000,
MAX_TAIL=4000) before feature extraction.

### apex/router/features.js

Converts a prompt string to a flat feature vector `{name: number}`. Tokenizes
once, slides an n-gram window, and looks up phrases in `lexicon.compiled.json`
via a Map for O(1) lookup. No per-call regex construction.

### apex/router/risk.js

Deterministic destructive-action classifier. `classifyDestructive(prompt)`
returns `{severity: 'high'|'low'|null, highTerms[], lowTerms[]}`. HIGH patterns
include force-push, `reset --hard`, `rm -rf` (excluding safe targets), DROP
TABLE, `terraform destroy`, `kubectl delete`, and deploy/send to production.
LOW covers broader destructive verbs. Result feeds tier-override logic in
`router.js`.

### apex/router/literals.js

Extracts tool names, file paths, URLs, slash commands, backtick tokens, quoted
strings, CLI flags, env vars, SHA hashes, UPPER_SNAKE identifiers, and dotfiles
from the prompt. Used to build the `preserve` line in the verdict and to count
file references for multi-file tier escalation.

### apex/router/bank.js

BM25 exemplar retrieval over `apex/references/bank-index.json`. Given the
prompt text, predicted task, and selected technique IDs, returns the top-k
most relevant exemplar records above a relevance threshold (theta_ex from
`model.json`).

### apex/router/pif-source.js

Infers the content source type from file magic bytes (PDF, OLE2, image formats,
ZIP/DOCX), file extension, and tool name. Returns one of eleven source labels
used downstream by `pif-adapt` to select the right extraction strategy.

### apex/router/pif-adapt.js

Normalizes and extracts text from heterogeneous content. For plain text: NFKC
normalization, whitespace collapse, zero-width character scan, homoglyph
detection, base64/rot13/leet decoding. For binary sources: invokes
`pdftotext`/`pdfinfo` (PDF), `unzip` (DOCX/word_doc), and `tesseract`
(image_via_ocr) via `child_process.execFileSync` with explicit binary paths
resolved by `findBinary()` (no shell: `{shell: false}` is the default for
`execFileSync`). All external calls carry `timeout` and `maxBuffer` limits
(pdftotext: 10 s / 16 MB; tesseract: 30 s / 16 MB; unzip: 10 s / 16 MB).
Returns `{text, hidden_text_flags, provenance_zones, extraction}`.

### apex/router/pif-detect.js

Tier 0 scanner. Runs nine attack-type detectors (instruction_override,
role_change, secret_extraction, tool_abuse, credential_theft,
context_poisoning, multi_step_jailbreak, encoded_instructions,
indirect_injection) using regex + keyword + structural patterns. Decodes
base64 and hex blobs and re-scans recursively (depth limit 2). Educational/
research context caps aggregate risk at 0.75. Gate constant `GATE = 0.3`.
Returns `{risk, confidence, attack_types[], signals[], scanner_latency_ms}`.

### apex/router/pif-route.js

Pure routing function. Takes detect results and returns a tier recommendation
(none, haiku, sonnet, opus) plus `neutralize_immediately`. Per-attack minimum
tiers are defined in `PER_ATTACK_MIN`; combined-attack pairs in `COMBINED_BUMPS`
bump the tier further. Short-circuit rule: `risk >= 0.8 AND confidence >= 0.9`
-> `neutralize_immediately = true`. `multi_step_jailbreak` always routes to
opus. Also exports `buildPrompt(tier, context)` for constructing structured
prompts to pass to a model at the recommended tier, and `escalate()` for
multi-tier escalation logic. No I/O.

### apex/router/pif-session.js

Session-aware multi-turn tracker. `recordEvent(session_id, {kind, attacks,
risk})` appends an event to a per-session JSONL file under
`~/.claude/apex/firewall-sessions/`. The filename is the first 16 hex chars of
`SHA-256(session_id)` (never the raw ID). `applySession(pif, session_id)` reads
the last `MAX_EVENTS = 6` events within `MAX_AGE_MS = 24 h` and checks for
multi-turn escalation patterns (framing IDs, continuation cues, repeated
attack types). Returns `{pif, escalated, reason}`. Session logic is disabled
when `APEX_FW_SESSION=0`. Old session files pruned on each call.

### apex/router/apex-state.js

Start/stop state manager. Reads and writes `~/.claude/apex/state.json`
atomically (write to `.tmp.<pid>` then rename). When state changes, also
rewrites `~/.claude/apex/STATUS.md` so the status line reflects the current
state. Missing or unreadable state file is treated as enabled. CLI: `node
apex-state.js start | stop | status`.

### apex/router/pif-cli.js

Command-line interface for manual PIF scanning outside of hooks. Subcommands:
`scan <path>`, `text "<string>"`, `next <path|->`. Chains the full
source -> adapt -> detect -> route pipeline and prints results. Useful for
testing threat detection against known payloads without triggering the hook.

### apex/router/apex-doctor.js

Environment diagnostics. Reports config dir, plugin version, state, skill path,
hook wiring in `settings.json`, registered commands, status line, org policy
flags, and presence of external tools (pdftotext, tesseract, unzip). Ends with
a pass/fail verdict on whether hooks are allowed. Uses `execFileSync('which',
...)` to probe tool presence.

---

## Data flow diagram

```
                     UserPromptSubmit
                           |
                    apex-gate.js
                    /           \
          router.route()     pif-detect.detect()
                |                    |
          features.js          pif-route.route()
          risk.js                    |
          literals.js         pif-session.applySession()
          bank.js                    |
                \               verdict.pif
                 \             /
                  verdict{}
                      |
                  router.format()
                      |
             additionalContext inject
                  (exit 0)

     PostToolUse / PostToolUseFailure
                |
           apex-scan.js
                |
         pif-source.inferSource()
                |
         [worker thread + watchdog]
                |
          pif-adapt.adapt()
          pif-detect.detect()
          pif-route.route()
                |
          pif-session.recordEvent()
                |
        risk >= 0.3 -> emit advisory
        benign      -> silent exit 0
                (exit 0)
```

---

## Tier escalation rules

These rules come from `apex/router/pif-route.js` (constants read directly from
code) and `apex/references/pif-routing.md` (narrative description).

**Per-attack minimum tiers** (single attack present):

| Attack type | Minimum tier |
|-------------|-------------|
| instruction_override | haiku |
| role_change | haiku |
| context_poisoning | haiku |
| encoded_instructions | haiku (sonnet when decode failed) |
| secret_extraction | sonnet |
| tool_abuse | sonnet |
| credential_theft | sonnet |
| indirect_injection | sonnet |
| multi_step_jailbreak | opus (always) |

**Combined-attack bumps** (both attacks present):

| Pair | Result tier |
|------|-------------|
| instruction_override + role_change | sonnet |
| instruction_override + context_poisoning | sonnet |
| secret_extraction + credential_theft | opus |
| tool_abuse + credential_theft | opus |
| credential_theft + indirect_injection | opus |
| secret_extraction + tool_abuse | opus |

**Short-circuit rule:** `risk >= 0.8 AND confidence >= 0.9` -> skip model call,
set `neutralize_immediately = true`.

**Multi-tier escalation thresholds** (from `pif-routing.md`):

- Tier 0 to Tier 1 (haiku): `0.2 <= risk < 0.8` OR `confidence < 0.9`
- Tier 1 to Tier 2 (sonnet): `risk >= 0.5 AND confidence < 0.7`, OR
  `encoded_instructions` unresolved by Tier 1
- Tier 2 to Tier 3 (opus): `risk >= 0.85 AND confidence < 0.75`, OR
  `multi_step_jailbreak`, OR 3+ distinct attack categories

Note: the routing recommendation produced by `pif-route.js` is advisory. The
hooks tell the executing model which tier to use; no model API call is made
inside the hooks themselves.

---

## State and log files

All paths are relative to `CLAUDE_CONFIG_DIR` (default `~/.claude`):

| File | Written by | Contents |
|------|-----------|---------|
| `~/.claude/apex/state.json` | `apex-state.js` | `{enabled, updatedAt, by}` |
| `~/.claude/apex/STATUS.md` | `apex-state.js` | Human-readable on/off status |
| `~/.claude/apex/statusline-chain` | user/setup | Command for chained status line |
| `~/.claude/apex/verdicts.jsonl` | `apex-gate.js` (when `APEX_LOG=1`) | `{ts, verdict}` per prompt; `APEX_LOG=full` also stores prompt text |
| `~/.claude/apex/firewall-events.jsonl` | `apex-gate.js`, `apex-scan.js` (when `APEX_FW_LOG=1`) | `{ts, hook, session_id, risk, attacks, tier, neutralize_now, session_escalated}`; never stores prompt text |
| `~/.claude/apex/firewall-last-input.json` | `apex-scan.js` (when `APEX_FW_DEBUG_DUMP=1`) | Raw stdin of last scan invocation |
| `~/.claude/apex/firewall-sessions/<16hex>.jsonl` | `pif-session.js` | Per-session event log; filename is `SHA-256(session_id)[0:16]`; pruned after 24 h |

---

## Security properties

**No shell execution.** All external binaries (pdftotext, pdfinfo, unzip,
tesseract) are invoked via `child_process.execFileSync` with an explicit
absolute path resolved by `findBinary()`, which searches a fixed list
(`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`). The `shell`
option is never set to `true` in any of these calls, so no shell interprets
arguments.

**Bounded parsing.** Key size and time limits from code:

| Limit | Value | Source |
|-------|-------|--------|
| Prompt truncation (gate) | 24 KB lead + 4 KB tail | `router.js` MAX_LEAD / MAX_TAIL |
| Prompt size guard (gate) | 1,000,000 chars | `apex-gate.js` hard check |
| Scan text budget | 1 MB | `apex-scan.js` MAX_TEXT_BYTES |
| File size limit | 25 MB | `apex-scan.js` MAX_FILE_BYTES |
| Worker watchdog | 8000 ms (env: APEX_FW_SCAN_BUDGET_MS) | `apex-scan.js` SCAN_BUDGET_MS |
| pdftotext timeout | 10 s / 16 MB | `pif-adapt.js` execFileSync options |
| pdfinfo timeout | 5 s / 1 MB | `pif-adapt.js` execFileSync options |
| unzip timeout | 10 s / 16 MB | `pif-adapt.js` execFileSync options |
| tesseract timeout | 30 s / 16 MB | `pif-adapt.js` execFileSync options |
| collectStrings depth | 6 levels / 1 MB | `apex-scan.js` MAX_COLLECT |
| base64 recursive scan depth | 2 | `pif-detect.js` recursiveScanDecoded |
| Session events retained | 6 events / 24 h | `pif-session.js` MAX_EVENTS / MAX_AGE_MS |

**Watchdog.** `apex-scan.js` runs adapt+detect+route inside a `Worker` thread.
A `setTimeout` at `SCAN_BUDGET_MS` (default 8 s) calls `worker.terminate()` if
the worker has not responded. The main thread then emits a timeout advisory and
exits 0.

**Metadata-only logs.** `firewall-events.jsonl` records timestamps, session ID,
risk scores, attack type IDs, and tier recommendations. Prompt text is never
written to this file. Verdict text is written to `verdicts.jsonl` only when
`APEX_LOG=full` is explicitly set.

**Advisory contract.** Both hooks always call `process.exit(0)`. Failures in
the router, the firewall, file reads, or worker threads are caught by
try/catch blocks and result in a fallback (mandate-only injection or silent
exit). A broken hook must not cost the user a prompt.

---

## Supporting files

- `apex/router/model.json` - trained linear model weights, biases, temperatures,
  fit metadata, and holdout scores
- `apex/router/lexicon.compiled.json` - compiled n-gram lookup table used by
  `features.js`
- `apex/references/bank-index.json` / `bank-index.min.json` - BM25 index over
  the exemplar bank
- `apex/references/pif-threats.json` - attack catalog loaded by `pif-detect.js`
  (compiled into regexes once at module load)
- `apex/references/techniques.json` - technique registry with names, conflicts,
  and veto rules used by `router.js`
- `apex/router/literals.js` - literal extraction (preserve inventory)
- `apex/router/bank.js` - BM25 exemplar retrieval
- `apex/router/fit.js`, `compile.js`, `build-bank.js`, `eval.js`,
  `eval-bank.js`, `merge-lexicon.js` - offline training and evaluation tooling;
  not loaded at hook runtime
