# Changelog

## 3.0.0: APEX (Ask. Perfect. EXecute.)

Renamed from APE (Auto Prompt Engine) to APEX (Ask. Perfect. EXecute.). The firewall is the APEX Firewall.
Added `/apex-start` and `/apex-stop` state-file plumbing: `~/.claude/apex/state.json` controls whether the gate and firewall run; missing or invalid file means on.

Merged APEX v2.1 (prompt optimization) with the prompt injection firewall work
into a single plugin. The v2.1 optimization loop is unchanged.

### Added: managed accounts and the commands-only track

- `router/apex-state.js`: now reads `CLAUDE_CONFIG_DIR` (falls back to `~/.claude`);
  writes `STATUS.md` atomically on every `setEnabled` call and on `status` when the
  file is absent. `STATUS.md` contains the exact text the `@`-import in `CLAUDE.md`
  reads to decide whether to skip the APEX loop.
- `commands/apex-start.md`: `/apex-start` command. Runs `apex-state.js start` via a
  bash execution line, then replies `⚡ APEX on · Ask. Perfect. EXecute.`.
- `commands/apex-stop.md`: `/apex-stop` command. Runs `apex-state.js stop`, then
  replies `APEX off`. The reply and all subsequent replies until `/apex-start` carry
  no ⚡ block.
- `commands/apex-doctor.md`: `/apex-doctor` command. Runs `router/apex-doctor.js`
  and shows the output verbatim.
- `router/apex-doctor.js`: prints config dir, APEX version, state, skill path, hook
  wiring, commands present, statusLine, organization policy (reads
  `remote-settings.json`, `/Library/Application Support/ClaudeCode/managed-settings.json`,
  `/etc/claude-code/managed-settings.json`), and external tools. Ends with either
  "Hooks: BLOCKED by organization policy (allowManagedHooksOnly). Use the
  commands-only track in tests/pif/kit/QUERIES.md." or "Hooks: allowed. Use the
  full track." Exits 0.
- `hooks/apex-statusline.sh`: POSIX sh status line wrapper. Reads `state.json`
  (missing = on). When on: prints `⚡ APEX`, joined by ` · ` to the output of the
  chained command when `statusline-chain` is present. When off: prints only the
  chain output. Never fails; exit 0 on any error.
- `tests/org-mode.test.js`: tests for STATUS.md writing, statusline behavior,
  doctor verdict, command file structure, and the installer statusLine round-trip.
- `mods/apex-thunder/`: simplified hook module (status-only). Reads `state.json`
  on `session.start` and `prompt.submit`; calls `$.ui.status`. No Pane, no Button,
  no commands. Blocked under `allowManagedHooksOnly`.
- `tests/pif/kit/QUERIES.md`: Step 0 (`/apex-doctor`) and commands-only track (a–e).

### Changed: managed accounts and the commands-only track

- `install.sh`: target config dir is now `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`.
  Installs `apex-start.md`, `apex-stop.md`, `apex-doctor.md` (marker-checked).
  Copies `apex-statusline.sh` into `<config>/hooks/`. Backs up the existing
  `statusLine` command to `<config>/apex/statusline-chain` when it is not already
  the APEX wrapper; sets `statusLine` to the APEX wrapper. `restore.sh` puts the
  original `statusLine` back deep-equal. Creates `STATUS.md` (on) when absent.
- `hooks/apex-gate.js`, `hooks/apex-scan.js`: all paths use `configDir()`, which
  reads `CLAUDE_CONFIG_DIR`.
- `SKILL.md`: gate check now documents the stopped-check (STATUS.md import) and
  the skip-check separately.
- `commands/apex-scan.md`: accepts `--text "<prompt>"` to scan inline text directly.

### Added

- `hooks/apex-scan.js`: PostToolUse/PostToolUseFailure hook. Scans content
  returned by Read, WebFetch, WebSearch, Bash, and `mcp__*` tools through the
  PIF pipeline. Emits `additionalContext` (plain facts) and a `systemMessage`
  banner when attacks pass the 0.3 gate. Always exits 0. On scan timeout it
  reports the content as unchecked and logs extraction "timeout".
- `APEX_FW_DISABLE=1`: turns the firewall off in both hooks while leaving the APEX
  loop running. Use for A/B baseline runs to isolate the firewall's contribution.
- `APEX_FW_SCAN_BUDGET_MS`: scan time budget in milliseconds (default 8000). A
  watchdog holds any input that exceeds the budget, reports it as unchecked, and
  logs "timeout". The hook still exits 0.
- `install.sh` writes `<backup>/restore.sh`. Running it moves the current install
  aside and restores the prior skill, hooks, command, and `settings.json` without
  deleting anything.
- `router/pif-detect.js`: Tier 0 deterministic detector. Regex, keyword, entropy,
  unicode, and base64 scanners across 9 attack types. Gate 0.3.
- `router/pif-route.js`: Tier recommendation (none/haiku/sonnet/opus), escalation
  rules, `buildPrompt()` templates, `route()` and `validateModelOutput()`.
- `router/pif-adapt.js`: 11 source adapters. `pdftotext`, `unzip`, and
  `tesseract` via `execFileSync` with no shell. Reports extraction
  complete/partial/failed.
- `router/pif-source.js`: Source classification by magic bytes, then extension.
- `router/pif-session.js`: Multi-turn session escalation. Metadata-only state
  in `~/.claude/apex/firewall-sessions/`. Disabled by `APEX_FW_SESSION=0`.
- `router/pif-cli.js`: CLI runner for `/apex-scan`.
- `commands/apex-scan.md`: `/apex-scan <path or URL>` command. Runs Tier 0 then
  has the recommended model adjudicate through a subagent.
- `tests/pif/`: attacks, hook, scan, cli, adapt, redos test files.
- `tests/pif/eval.js`: eval runner (`--set dev|holdout|all`).
- `tests/pif/kit/run-kit.js`: kit runner against real files.
- `tests/pif/kit/QUERIES.md`: typed query guide for the kit.
- `references/pif-routing.md`: multi-tier routing policy, decision table,
  per-attack hints, cost budget, and model prompt templates.
- `references/pif-threats.json`: threat definitions for the detector.
- `install.sh`: idempotent deploy script with `--dry-run` and `--skip-tests`.
  Backs up before deploying; prints a restore command.
- Firewall section in `SKILL.md`: what the firewall outputs mean and how the
  model should handle them.
- `CHANGELOG.md` (this file).

### Changed

- Plugin version bumped to 3.0.0 in `.claude-plugin/plugin.json`.
- `SKILL.md` title updated to "APEX v3.0". Firewall section added after
  step 0.5. Order-of-operations diagram extended to show both hook paths.
- `README.md` rewritten to cover both the APEX loop and the firewall, with
  measured results and caveats.
- `references/pif-routing.md`: cost-share figures labeled as design targets.
  Retrieved-source escalation rule updated to require evidence (a retrieved
  source alone no longer escalates).
- `hooks/apex-gate.js`: PIF Tier 0 now runs on every prompt through the
  UserPromptSubmit hook, routing through `pif-detect.js`, `pif-route.js`, and
  `pif-session.js`.

### Fixed

- `router/router.js` wired to `pif-detect.js` and `pif-route.js` so the
  UserPromptSubmit hook carries firewall output alongside the APEX verdict.

### Security

- Shell injection in the pdf, word_doc, and image adapters: replaced
  `execSync` string interpolation with `execFileSync` argument arrays.
- Super-linear regexes in the detector (email pattern) and adapters (tags,
  comments, markdown links) rewritten. A 1 MB stress suite in
  `tests/pif/redos.test.js` covers the fixed patterns across HTML, Markdown,
  email, source code, JSON, and binary DOCX/PDF shapes. The scan watchdog
  (`APEX_FW_SCAN_BUDGET_MS`) holds any input that still exceeds the budget.
- Replaced the blanket 0.40 `indirect_injection` score on every retrieved
  source with evidence-based scoring in `pif-detect.js`.

### Known limitations

- Held-out micro F1 is 0.464 (recall 0.349). The detector catches known
  phrasing reliably but misses novel variants. This is the main open item.
- Hooks run Tier 0 only. Tier 1 (model classifier) runs through `/apex-scan`
  only, not on the live hook path.
- Multi-turn session escalation has no blind evaluation set.
- `SKILL.md` at the repo root loads as a single skill. No `skills/` directory
  exists yet, so marketplace packaging is incomplete.

---

## 2.1 and earlier

See `evals/report.md` for APEX v2.1 router accuracy numbers (tier 0.60, pool
0.65, task 0.54, technique top-2 recall 0.14 on an 80-ask holdout).
