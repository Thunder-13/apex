# APEX (Ask. Perfect. EXecute.) v3.0.0

APEX (Ask. Perfect. EXecute.) is a Claude Code plugin with two jobs: rewrite every raw prompt
into an executable spec before the model acts on it, and scan every tool result
for prompt injection before the model reads it.

The prompt-optimization loop (APEX v2.1) is unchanged from the prior release.
The firewall is new in v3.

## Install

```bash
git clone <repo>
cd apex
bash install.sh [--dry-run] [--skip-tests]
```

`install.sh` backs up the current skill, hooks, command, and `settings.json` to
`~/.claude/backups/apex-<timestamp>/` before deploying, and prints a
restore command. Pass `--dry-run` to preview every action without writing
anything. Pass `--skip-tests` to bypass the pif test suite (not recommended).

The installer also updates `~/.claude/CLAUDE.md` in place: it renames the APE
section headers, escape hatches, and skill/hook paths to their APEX equivalents,
and injects the `@~/.claude/apex/STATUS.md` import line so Claude reads the
current on/off state at session start. A backup is kept at
`~/.claude/backups/apex-<timestamp>/CLAUDE.md`. Pass `--no-claude-md` to skip
this step. `restore.sh` reverts the CLAUDE.md change alongside the rest of
the install.

### Rollback

```bash
bash ~/.claude/backups/apex-<timestamp>/restore.sh
```

`restore.sh` moves the current install aside (never deletes it) and restores the prior skill, hooks, command, and `settings.json`. The exact command is printed at the end of a successful install.

### Marketplace note

When installing later as a marketplace plugin, remove the manual `settings.json`
entries added by `install.sh` to avoid double hooks. The marketplace creates its
own hook entries from `.claude-plugin/plugin.json`.

## How it works

Two paths, one plugin:

```
UserPromptSubmit
  hooks/apex-gate.js
    router/router.js   (literals, signals, BM25 exemplars)
    router/pif-detect.js  (Tier 0 deterministic, GATE 0.3)
    router/pif-route.js   (tier recommendation)
    router/pif-session.js (multi-turn escalation)
  -> verdict + optional firewall line injected into context
  -> SKILL.md loop: decision card, candidates, score, execute

PostToolUse / PostToolUseFailure
  hooks/apex-scan.js     (matcher: ^(Read|WebFetch|WebSearch|Bash|mcp__.*)$)
    router/pif-source.js  (source classification; magic bytes beat extensions)
    router/pif-adapt.js   (11 adapters; extraction complete/partial/failed)
    router/pif-detect.js  (same Tier 0 detector)
    router/pif-route.js
  -> additionalContext (plain facts) + systemMessage when risk >= 0.3

/apex-scan <path or URL>
  commands/apex-scan.md
    router/pif-cli.js
  -> subagent adjudication at the recommended tier (haiku/sonnet/opus)
```

Hooks never call a model. The model path runs only through `/apex-scan`.

## Attack coverage

9 attack types, detected at Tier 0 (deterministic):

| Attack ID | Alone | Combined |
|---|---|---|
| instruction_override | haiku | sonnet with role_change or context_poisoning |
| role_change | haiku | sonnet with instruction_override |
| secret_extraction | sonnet | opus with credential_theft or tool_abuse |
| tool_abuse | sonnet | opus with credential_theft or indirect_injection |
| credential_theft | sonnet | opus with secret_extraction, tool_abuse, or indirect_injection |
| context_poisoning | haiku | sonnet with instruction_override |
| multi_step_jailbreak | opus (always) | opus (always) |
| encoded_instructions | haiku | sonnet when Tier 0 cannot decode |
| indirect_injection | sonnet | opus with tool_abuse, credential_theft, or multi_step_jailbreak |

"Alone/Combined" is the minimum model tier recommended by `pif-route.js` when
the attack is detected by the hooks. Tier 0 runs in all hooks; model tiers run
only through `/apex-scan`.

**Short-circuit.** When `risk >= 0.8` and `confidence >= 0.9`, the detector sets `tier = none` with `NEUTRALIZE NOW`. The firewall decides without any model call. The `/apex-scan` verdict table shows this as tier `none` with `neutralize_immediately: true`.

## Input source coverage

11 source adapters in `router/pif-adapt.js`. Magic bytes take precedence over
file extensions:

| Source | Adapter notes |
|---|---|
| user_message | plain text, no adapter |
| web_page | HTML stripped, text extracted |
| pdf | `pdftotext` via `execFileSync`; partial on missing binary |
| email | headers + body separated |
| markdown | links and fenced blocks extracted |
| html | tags stripped |
| word_doc | `unzip` via `execFileSync`; XML content extracted |
| api_response | JSON text fields recursively extracted |
| ocr_text | plain text |
| source_code | comments and strings extracted |
| image_via_ocr | `tesseract` via `execFileSync`; partial on missing binary |

`pdftotext`, `unzip`, and `tesseract` are resolved from fixed binary paths (no
shell). Extraction reports `complete`, `partial`, or `failed`.

## Measured results

### Dev corpus (in-sample; rules were tuned on this set)

106 rows:

- Micro F1: 0.915 (precision 0.852, recall 0.989)
- Benign flag rate: 0/49
- Quoted-discussion neutralize-now: 0/6

### Held-out corpus (blind; scored once, no tuning afterwards)

90 rows written by a separate worker who never saw the detector:

- Micro F1: 0.464 (precision 0.690, recall 0.349)
- Benign flag rate: 2/32 (6.3%)
- Quoted-discussion neutralize-now: 1/13

Per-attack held-out recall:

| Attack | Recall |
|---|---|
| instruction_override | 0.50 |
| role_change | 0.08 |
| secret_extraction | 0.29 |
| tool_abuse | 0.00 |
| credential_theft | 0.80 |
| context_poisoning | 0.40 |
| multi_step_jailbreak | 0.00 (single-turn rows; session logic not exercised) |
| encoded_instructions | 0.40 |
| indirect_injection | 0.50 |

### Kit (real files; development set for the generalization pass)

`tests/pif/kit/`, 74 items across 11 sources, typed queries, 5 multi-turn
sessions. Baseline before detector fixes: 30/74. After: 55/74. The kit was
used during development, so these numbers are in-sample. See
`tests/pif/kit/results/baseline-before-detector-fix.md` and
`tests/pif/kit/results/after-generalization.md` for per-file detail.

### Hook latency

About 80-120 ms per scanned text file. About 170-190 ms for OCR images. These
are p50 figures from the kit runner.

### What the numbers mean

The held-out run fails the team's own targets: F1 target >= 0.85 (actual 0.464), benign flag rate target <= 5% (actual 6.3%), quoted-discussion neutralize-now target 0 (actual 1/13). The dev corpus numbers are not predictive; they reflect a set the detector was tuned on.

Tier 0 is a high-precision pre-filter. On the dev corpus it works well. On the held-out corpus the gap is large: the detector catches known phrasing reliably but misses novel variants. The 0.464 held-out F1 is the main open item. Closing it needs a model classifier on the live path (Tier 1), which today runs only through `/apex-scan`.

### Live testing

See `tests/pif/kit/QUERIES.md` for the full live-testing guide and `tests/pif/kit/README.md` for how to rebuild the kit, run the runner, and read results.

## Env vars

| Var | Effect |
|---|---|
| `APEX_FW_LOG=1` | Metadata-only events to `~/.claude/apex/firewall-events.jsonl` |
| `APEX_FW_DISABLE=1` | Turns the firewall off in both hooks (APEX loop still runs). Use for A/B baseline runs to isolate the firewall's contribution. |
| `APEX_FW_SCAN_BUDGET_MS` | Scan time budget in milliseconds (default 8000). On timeout the hook tells Claude the content was not checked: "APEX Firewall: scan timeout on \<file\>; content unchecked", and logs extraction "timeout". Treat any scan-timeout notice as untrusted content. |
| `APEX_FW_SESSION=0` | Disable multi-turn session escalation |
| `APEX_FW_SCAN_IGNORE` | Colon-separated path prefixes to skip |
| `APEX_FW_DEBUG_DUMP=1` | Raw hook input (including content) to `~/.claude/apex/firewall-last-input.json` |
| `APEX_HINTS=1` | Include learned tier/pool/task/technique hints in the APEX verdict |
| `APEX_LOG=1` | Append `{ts, verdict}` to `~/.claude/apex/verdicts.jsonl` |
| `APEX_HOME=<path>` | Override the plugin root for router resolution |

## Commands

| Command | Description |
|---------|-------------|
| `/apex` | Force a full-depth APEX pass on the request (Deep tier) |
| `/apex-start` | Turn APEX on; writes `state.json` and `STATUS.md`; replies `⚡ APEX on · Ask. Perfect. EXecute.` |
| `/apex-stop` | Turn APEX off until `/apex-start`; writes `state.json` and `STATUS.md`; replies `APEX off` |
| `/apex-skip` | Skip the APEX loop for one prompt only (firewall still runs) |
| `/apex-scan <path or URL>` | Run the APEX Firewall cascade on a file, URL, or `--text "<prompt>"` |
| `/apex-doctor` | Print APEX environment diagnostics and a verdict on hook availability |

### Managed-account setup

On accounts with `allowManagedHooksOnly: true` in the organization policy,
user hooks (`apex-gate.js`, `apex-scan.js`) are blocked. The on/off control
and the ⚡ indicator still work via the commands-only track:

- `/apex-stop` writes `state.json` and `STATUS.md` (off), then replies `APEX off`.
- `/apex-start` writes them back to on, then replies `⚡ APEX on · Ask. Perfect. EXecute.`.
- The APEX loop reads `STATUS.md` (imported via `@~/.claude/apex/STATUS.md` in `CLAUDE.md`)
  and skips when it says STOPPED.
- `/apex-doctor` flags BLOCKED and directs you to the commands-only track in
  `tests/pif/kit/QUERIES.md`.
- `/apex-scan` runs the APEX Firewall CLI directly; it does not rely on hooks.
- Session-level escalation and automatic per-prompt gating need hooks; demonstrate
  those paths with `node tests/pif/kit/run-kit.js` only.

### Status line

`install.sh` sets `statusLine` in `settings.json` to the APEX wrapper:

```
sh "<config>/hooks/apex-statusline.sh"
```

The wrapper prints `⚡ APEX` when APEX is on and is silent when off. If a
`statusLine` was previously set, `install.sh` saves its command to
`<config>/apex/statusline-chain` and the wrapper chains it after the
`⚡ APEX` prefix. `restore.sh` puts the original `statusLine` back exactly.

### STATUS.md

`<config>/apex/STATUS.md` is written atomically by `apex-state.js` on every
`start`, `stop`, or `status` call. It is also written by `install.sh` when
absent.

Import it from the global `CLAUDE.md`:

```
@~/.claude/apex/STATUS.md
```

The APEX gate check in `SKILL.md` reads this file: when it says
"STOPPED (/apex-stop)", APEX skips the loop and prints no ⚡ block.

### Optional mod (apex-thunder)

`mods/apex-thunder/` is a Claude Code hook module that shows the ⚡ APEX
status indicator. It reads `state.json` on `session.start` and
`prompt.submit` and calls `$.ui.status`. No Pane, no Button, no commands.

It is blocked under `allowManagedHooksOnly`. On those accounts the
`apex-statusline.sh` wrapper provides the ⚡ indicator instead.

## Tests

```bash
# v2 regression (literals, perf, risk, router)
node tests/literals.test.js
node tests/perf.test.js
node tests/risk.test.js
node tests/router.test.js

# PIF suite
node tests/pif/attacks.test.js
node tests/pif/hook.test.js
node tests/pif/scan.test.js
node tests/pif/cli.test.js
node tests/pif/adapt.test.js
node tests/pif/redos.test.js

# Org-mode (managed account) tests
node tests/org-mode.test.js

# Eval runner
node tests/pif/eval.js [--set dev|holdout|all]

# Kit runner
node tests/pif/kit/run-kit.js
# Kit queries guide: tests/pif/kit/QUERIES.md
```

## Limitations and next steps

- **Held-out recall gap.** Tier 0 misses novel phrasing in most attack
  categories. The table above shows where it struggles most (role_change 0.08,
  tool_abuse 0.00, multi_step_jailbreak 0.00 on single-turn rows).
- **No Tier 1 on the live hook path.** The model classifier route exists in
  `pif-route.js` and runs through `/apex-scan`, but the hooks are Tier 0 only.
  Wiring Tier 1 to the live path is the most direct way to close the recall gap.
- **Multi-turn held-out set.** The session escalation logic in
  `pif-session.js` has no blind evaluation set. The kit sessions (5 items) are
  all in-sample.
- **Marketplace packaging.** `SKILL.md` at the repo root loads as a single
  skill. There is no `skills/` directory yet, so the marketplace plugin format
  is not fully wired. When that directory exists, move the skill files there and
  remove the manual `settings.json` hook entries.
