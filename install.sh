#!/usr/bin/env bash
# install.sh -- deploy APEX (Ask. Perfect. EXecute.) v3.0.0 from this repo into ~/.claude.
# Idempotent. Migrates from the legacy APE layout automatically.
#
# Usage:
#   bash install.sh [--dry-run] [--skip-tests]
#
#   --dry-run     print every action without changing anything
#   --skip-tests  bypass the pif test suite (not recommended for production)
#
# After this script completes, plugins installed through a marketplace will
# create a second set of hooks. Remove the manual settings entries added here
# before registering the plugin through the marketplace to avoid double hooks.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
DRY_RUN=0
SKIP_TESTS=0

NO_CLAUDE_MD=0

for _arg in "$@"; do
  case "$_arg" in
    --dry-run)       DRY_RUN=1      ;;
    --skip-tests)    SKIP_TESTS=1   ;;
    --no-claude-md)  NO_CLAUDE_MD=1 ;;
    *)
      echo "unknown flag: $_arg" >&2
      echo "usage: $0 [--dry-run] [--skip-tests] [--no-claude-md]" >&2
      exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO/apex"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
DEST="${CLAUDE_CONFIG_DIR}/skills/apex"
HOOK_DIR="${CLAUDE_CONFIG_DIR}/hooks"
CMD_DIR="${CLAUDE_CONFIG_DIR}/commands"
STATE_DIR="${CLAUDE_CONFIG_DIR}/apex"
SETTINGS="${CLAUDE_CONFIG_DIR}/settings.json"
BACKUP_TS="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${CLAUDE_CONFIG_DIR}/backups/apex-install-$BACKUP_TS"
CLAUDE_MD_PATCHED=0
CLAUDE_MD_BACKUP=""

# Legacy paths (for migration only; these names must stay as legacy references)
LEGACY_SKILL="${CLAUDE_CONFIG_DIR}/skills/auto-prompt-engine"
LEGACY_HOOK_GATE="${CLAUDE_CONFIG_DIR}/hooks/ape-gate.js"
LEGACY_HOOK_SCAN="${CLAUDE_CONFIG_DIR}/hooks/pif-scan.js"
LEGACY_CMD_APE="${CLAUDE_CONFIG_DIR}/commands/ape.md"
LEGACY_CMD_SKIP="${CLAUDE_CONFIG_DIR}/commands/thunder-skip.md"
LEGACY_CMD_SCAN="${CLAUDE_CONFIG_DIR}/commands/pif-scan.md"
LEGACY_STATE_DIR="${CLAUDE_CONFIG_DIR}/ape"

# Locate node
NODE_PATH="$(command -v node 2>/dev/null || echo '/opt/homebrew/bin/node')"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
run_cmd() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

info() { echo "$@"; }
dry_info() { [[ $DRY_RUN -eq 1 ]] && echo "[dry-run] $*" || true; }

# ---------------------------------------------------------------------------
# Preflight: required source files must exist
# ---------------------------------------------------------------------------
REQUIRED_FILES=(
  "$SRC/SKILL.md"
  "$SRC/router/router.js"
  "$SRC/router/pif-detect.js"
  "$SRC/router/pif-adapt.js"
  "$SRC/router/pif-route.js"
  "$SRC/router/apex-state.js"
  "$SRC/router/apex-doctor.js"
  "$SRC/hooks/apex-gate.js"
  "$SRC/hooks/apex-scan.js"
  "$SRC/hooks/apex-statusline.sh"
  "$SRC/router/pif-cli.js"
  "$SRC/commands/apex.md"
  "$SRC/commands/apex-skip.md"
  "$SRC/commands/apex-scan.md"
  "$SRC/commands/apex-start.md"
  "$SRC/commands/apex-stop.md"
  "$SRC/commands/apex-doctor.md"
)

for _f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$_f" ]]; then
    echo "preflight: required file missing: $_f" >&2
    exit 1
  fi
done

info "preflight: all required files present"

# Node syntax check on both hooks
"$NODE_PATH" --check "$SRC/hooks/apex-gate.js" \
  || { echo "syntax error: $SRC/hooks/apex-gate.js" >&2; exit 1; }
"$NODE_PATH" --check "$SRC/hooks/apex-scan.js" \
  || { echo "syntax error: $SRC/hooks/apex-scan.js" >&2; exit 1; }

info "preflight: node --check passed on both hooks"

# ---------------------------------------------------------------------------
# Tests (unless --skip-tests)
# ---------------------------------------------------------------------------
if [[ $SKIP_TESTS -eq 0 ]]; then
  for _test in \
    "$SRC/tests/pif/attacks.test.js" \
    "$SRC/tests/pif/hook.test.js" \
    "$SRC/tests/pif/scan.test.js" \
    "$SRC/tests/pif/cli.test.js" \
    "$SRC/tests/pif/adapt.test.js" \
    "$SRC/tests/pif/redos.test.js" \
    "$SRC/tests/pif/eval.js" \
    "$SRC/tests/router.test.js" \
    "$SRC/tests/literals.test.js"
  do
    if [[ -f "$_test" ]]; then
      _tmp_home="$(mktemp -d)"
      info "running test: $_test"
      if ! APEX_HOME="$SRC" HOME="$_tmp_home" "$NODE_PATH" "$_test" > /dev/null 2>&1; then
        rm -rf "$_tmp_home"
        echo "test failed: $_test" >&2
        echo "re-run with APEX_HOME=$SRC HOME=<tmpdir> node $_test to see output" >&2
        exit 1
      fi
      rm -rf "$_tmp_home"
      info "  passed: $_test"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Backup current and legacy items
# ---------------------------------------------------------------------------
info ""
info "backing up to: $BACKUP_DIR"

if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$BACKUP_DIR"
fi

# Track which artifacts existed so restore.sh acts correctly.
# New-name artifacts (from a previous APEX install)
APEX_SKILL_EXISTED=0
APEX_GATE_EXISTED=0
APEX_SCAN_EXISTED=0
APEX_CMD_APE_EXISTED=0
APEX_CMD_SKIP_EXISTED=0
APEX_CMD_SCAN_EXISTED=0
APEX_CMD_START_EXISTED=0
APEX_CMD_STOP_EXISTED=0
APEX_CMD_DOCTOR_EXISTED=0
APEX_STATUSLINE_EXISTED=0

# Legacy-name artifacts (from the legacy APE layout)
LEGACY_SKILL_EXISTED=0
LEGACY_GATE_EXISTED=0
LEGACY_SCAN_EXISTED=0
LEGACY_CMD_APE_EXISTED=0
LEGACY_CMD_SKIP_EXISTED=0
LEGACY_CMD_SCAN_EXISTED=0

[[ -d "$DEST" ]]                      && APEX_SKILL_EXISTED=1
[[ -f "$HOOK_DIR/apex-gate.js" ]]     && APEX_GATE_EXISTED=1
[[ -f "$HOOK_DIR/apex-scan.js" ]]     && APEX_SCAN_EXISTED=1
[[ -f "$CMD_DIR/apex.md" ]]           && APEX_CMD_APE_EXISTED=1
[[ -f "$CMD_DIR/apex-skip.md" ]]      && APEX_CMD_SKIP_EXISTED=1
[[ -f "$CMD_DIR/apex-scan.md" ]]      && APEX_CMD_SCAN_EXISTED=1
[[ -f "$CMD_DIR/apex-start.md" ]]     && APEX_CMD_START_EXISTED=1
[[ -f "$CMD_DIR/apex-stop.md" ]]      && APEX_CMD_STOP_EXISTED=1
[[ -f "$CMD_DIR/apex-doctor.md" ]]    && APEX_CMD_DOCTOR_EXISTED=1
[[ -f "$HOOK_DIR/apex-statusline.sh" ]] && APEX_STATUSLINE_EXISTED=1

[[ -d "$LEGACY_SKILL" ]]         && LEGACY_SKILL_EXISTED=1
[[ -f "$LEGACY_HOOK_GATE" ]]     && LEGACY_GATE_EXISTED=1
[[ -f "$LEGACY_HOOK_SCAN" ]]     && LEGACY_SCAN_EXISTED=1
[[ -f "$LEGACY_CMD_APE" ]]       && LEGACY_CMD_APE_EXISTED=1
[[ -f "$LEGACY_CMD_SKIP" ]]      && LEGACY_CMD_SKIP_EXISTED=1
[[ -f "$LEGACY_CMD_SCAN" ]]      && LEGACY_CMD_SCAN_EXISTED=1

# Back up current APEX skill dir
if [[ -d "$DEST" ]]; then
  run_cmd cp -R "$DEST" "$BACKUP_DIR/apex"
fi

# Back up current APEX hook files
for _hook in "$HOOK_DIR/apex-gate.js" "$HOOK_DIR/apex-scan.js" "$HOOK_DIR/apex-statusline.sh"; do
  [[ -f "$_hook" ]] && run_cmd cp "$_hook" "$BACKUP_DIR/$(basename "$_hook")"
done

# Back up current APEX command files
for _cmd in "$CMD_DIR/apex.md" "$CMD_DIR/apex-skip.md" "$CMD_DIR/apex-scan.md" \
            "$CMD_DIR/apex-start.md" "$CMD_DIR/apex-stop.md" "$CMD_DIR/apex-doctor.md"; do
  [[ -f "$_cmd" ]] && run_cmd cp "$_cmd" "$BACKUP_DIR/$(basename "$_cmd")"
done

# Back up settings.json
[[ -f "$SETTINGS" ]] && run_cmd cp "$SETTINGS" "$BACKUP_DIR/settings.json"

# ---------------------------------------------------------------------------
# Migrate legacy items into the backup (mv, not rm)
# ---------------------------------------------------------------------------
info "  migrating legacy items -> $BACKUP_DIR/legacy/"

if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$BACKUP_DIR/legacy"
fi

if [[ -d "$LEGACY_SKILL" ]]; then
  run_cmd mv "$LEGACY_SKILL" "$BACKUP_DIR/legacy/auto-prompt-engine"
  info "  migrated: $LEGACY_SKILL"
fi
for _item in "$LEGACY_HOOK_GATE" "$LEGACY_HOOK_SCAN" \
             "$LEGACY_CMD_APE" "$LEGACY_CMD_SKIP" "$LEGACY_CMD_SCAN"; do
  if [[ -f "$_item" ]]; then
    run_cmd mv "$_item" "$BACKUP_DIR/legacy/$(basename "$_item")"
    info "  migrated: $_item"
  fi
done
if [[ -d "$LEGACY_STATE_DIR" ]]; then
  run_cmd mv "$LEGACY_STATE_DIR" "$BACKUP_DIR/legacy/ape-state-dir"
  info "  migrated: $LEGACY_STATE_DIR"
fi

# Write restore.sh
if [[ $DRY_RUN -eq 0 ]]; then
  cat > "$BACKUP_DIR/restore.sh" <<RESTORE_EOF
#!/usr/bin/env bash
# Restore APEX install backup created at ${BACKUP_TS}.
# Generated by install.sh — do not edit by hand.
# Moves the current APEX install aside, restores legacy items if they existed.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR}"
DEST="${DEST}"
HOOK_DIR="${HOOK_DIR}"
CMD_DIR="${CMD_DIR}"
STATE_DIR="${STATE_DIR}"
SETTINGS="${SETTINGS}"
LEGACY_SKILL="${LEGACY_SKILL}"
LEGACY_HOOK_GATE="${LEGACY_HOOK_GATE}"
LEGACY_HOOK_SCAN="${LEGACY_HOOK_SCAN}"
LEGACY_CMD_APE="${LEGACY_CMD_APE}"
LEGACY_CMD_SKIP="${LEGACY_CMD_SKIP}"
LEGACY_CMD_SCAN="${LEGACY_CMD_SCAN}"
LEGACY_STATE_DIR="${LEGACY_STATE_DIR}"
TS="\$(date +%Y%m%d-%H%M%S)"

echo "Restoring from backup: \$BACKUP_DIR"

# 1. Move current APEX install aside (never delete)
if [[ -d "\$DEST" ]]; then
  mv "\$DEST" "\${DEST}.rolled-back-\${TS}"
  echo "  moved apex skill -> \${DEST}.rolled-back-\${TS}"
fi
for _f in "\$HOOK_DIR/apex-gate.js" "\$HOOK_DIR/apex-scan.js" "\$HOOK_DIR/apex-statusline.sh" \
          "\$CMD_DIR/apex.md" "\$CMD_DIR/apex-skip.md" "\$CMD_DIR/apex-scan.md" \
          "\$CMD_DIR/apex-start.md" "\$CMD_DIR/apex-stop.md" "\$CMD_DIR/apex-doctor.md"; do
  [[ -f "\$_f" ]] && mv "\$_f" "\${_f}.rolled-back-\${TS}"
done
if [[ -d "\$STATE_DIR" ]]; then
  mv "\$STATE_DIR" "\${STATE_DIR}.rolled-back-\${TS}"
fi

# 2. Restore backed-up APEX skill dir (only if it existed before this install)
if [[ -d "\$BACKUP_DIR/apex" ]]; then
  cp -R "\$BACKUP_DIR/apex" "\$DEST"
  echo "  restored apex skill dir"
elif [[ "${APEX_SKILL_EXISTED}" -eq 0 ]]; then
  echo "  apex skill was absent before install — left absent"
fi

# 3. Restore legacy items that existed before this install
if [[ "${LEGACY_SKILL_EXISTED}" -eq 1 ]] && [[ -d "\$BACKUP_DIR/legacy/auto-prompt-engine" ]]; then
  cp -R "\$BACKUP_DIR/legacy/auto-prompt-engine" "\$LEGACY_SKILL"
  echo "  restored legacy: auto-prompt-engine"
fi
if [[ "${LEGACY_GATE_EXISTED}" -eq 1 ]] && [[ -f "\$BACKUP_DIR/legacy/ape-gate.js" ]]; then
  cp "\$BACKUP_DIR/legacy/ape-gate.js" "\$LEGACY_HOOK_GATE"
  echo "  restored legacy: ape-gate.js"
fi
if [[ "${LEGACY_SCAN_EXISTED}" -eq 1 ]] && [[ -f "\$BACKUP_DIR/legacy/pif-scan.js" ]]; then
  cp "\$BACKUP_DIR/legacy/pif-scan.js" "\$LEGACY_HOOK_SCAN"
  echo "  restored legacy: pif-scan.js"
fi
if [[ "${LEGACY_CMD_APE_EXISTED}" -eq 1 ]] && [[ -f "\$BACKUP_DIR/legacy/ape.md" ]]; then
  cp "\$BACKUP_DIR/legacy/ape.md" "\$LEGACY_CMD_APE"
  echo "  restored legacy: ape.md"
fi
if [[ "${LEGACY_CMD_SKIP_EXISTED}" -eq 1 ]] && [[ -f "\$BACKUP_DIR/legacy/thunder-skip.md" ]]; then
  cp "\$BACKUP_DIR/legacy/thunder-skip.md" "\$LEGACY_CMD_SKIP"
  echo "  restored legacy: thunder-skip.md"
fi
if [[ "${LEGACY_CMD_SCAN_EXISTED}" -eq 1 ]] && [[ -f "\$BACKUP_DIR/legacy/pif-scan.md" ]]; then
  cp "\$BACKUP_DIR/legacy/pif-scan.md" "\$LEGACY_CMD_SCAN"
  echo "  restored legacy: pif-scan.md"
fi
if [[ "${LEGACY_CMD_SCAN_EXISTED}" -eq 1 ]] && [[ -d "\$BACKUP_DIR/legacy/ape-state-dir" ]]; then
  cp -R "\$BACKUP_DIR/legacy/ape-state-dir" "\$LEGACY_STATE_DIR"
  echo "  restored legacy: .claude/ape state dir"
fi

# 4. Restore settings.json (includes original statusLine deep-equal)
if [[ -f "\$BACKUP_DIR/settings.json" ]]; then
  [[ -f "\$SETTINGS" ]] && cp "\$SETTINGS" "\${SETTINGS}.rolled-back-\${TS}"
  cp "\$BACKUP_DIR/settings.json" "\$SETTINGS"
  echo "  restored settings.json"
fi

echo "Restore complete."
RESTORE_EOF
  chmod +x "$BACKUP_DIR/restore.sh"
  info "backup complete: $BACKUP_DIR"
  info "To roll back: bash $BACKUP_DIR/restore.sh"
else
  dry_info "backup complete: $BACKUP_DIR"
  dry_info "To roll back: bash $BACKUP_DIR/restore.sh"
fi

# ---------------------------------------------------------------------------
# Deploy skill (stage copy then atomic replace)
# ---------------------------------------------------------------------------
info ""
info "deploying skill -> $DEST"

STAGE="$(mktemp -d)"

if [[ $DRY_RUN -eq 0 ]]; then
  cp -R "$SRC" "$STAGE/apex"

  # Preserve docs from the current install (if any)
  if [[ -d "$DEST/docs" ]]; then
    mkdir -p "$STAGE/apex/docs"
    cp -R "$DEST/docs/." "$STAGE/apex/docs/"
  fi

  # Add v2-design.md from REPO/DESIGN.md
  if [[ -f "$REPO/DESIGN.md" ]]; then
    mkdir -p "$STAGE/apex/docs"
    cp "$REPO/DESIGN.md" "$STAGE/apex/docs/v2-design.md"
  fi

  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  mv "$STAGE/apex" "$DEST"
  rmdir "$STAGE" 2>/dev/null || true
else
  dry_info "cp -R $SRC $STAGE/apex"
  dry_info "mv $STAGE/apex $DEST"
fi

info "skill installed -> $DEST"

# ---------------------------------------------------------------------------
# Copy hooks
# ---------------------------------------------------------------------------
info ""
info "installing hooks -> $HOOK_DIR"

run_cmd mkdir -p "$HOOK_DIR"
run_cmd cp "$SRC/hooks/apex-gate.js" "$HOOK_DIR/apex-gate.js"
run_cmd chmod +x "$HOOK_DIR/apex-gate.js"
run_cmd cp "$SRC/hooks/apex-scan.js" "$HOOK_DIR/apex-scan.js"
run_cmd chmod +x "$HOOK_DIR/apex-scan.js"

info "hooks installed"

# ---------------------------------------------------------------------------
# Copy apex-statusline.sh into hook dir
# ---------------------------------------------------------------------------
info ""
info "installing status line wrapper -> $HOOK_DIR/apex-statusline.sh"

run_cmd cp "$SRC/hooks/apex-statusline.sh" "$HOOK_DIR/apex-statusline.sh"
run_cmd chmod +x "$HOOK_DIR/apex-statusline.sh"

info "status line wrapper installed"

# ---------------------------------------------------------------------------
# Copy command files (marker-checked; install when absent or marker matches)
# ---------------------------------------------------------------------------
info ""
info "installing commands -> $CMD_DIR"

run_cmd mkdir -p "$CMD_DIR"

# apex.md and apex-skip.md: install always (our files)
run_cmd cp "$SRC/commands/apex.md"      "$CMD_DIR/apex.md"
run_cmd cp "$SRC/commands/apex-skip.md" "$CMD_DIR/apex-skip.md"

# Helper: install a command file only when absent or when it carries our marker
install_if_marker() {
  local _src="$1" _dst="$2" _marker="$3" _name="$4"
  local _do_install=1
  if [[ -f "$_dst" ]]; then
    if grep -qF "$_marker" "$_dst" 2>/dev/null; then
      _do_install=1
    else
      _do_install=0
      info "  ${_name} exists without our marker, skipping"
    fi
  fi
  if [[ $_do_install -eq 1 ]]; then
    run_cmd cp "$_src" "$_dst"
    info "  ${_name} installed"
  fi
}

install_if_marker "$SRC/commands/apex-scan.md"    "$CMD_DIR/apex-scan.md"    '<!-- apex:apex-scan -->'    'apex-scan.md'
install_if_marker "$SRC/commands/apex-start.md"   "$CMD_DIR/apex-start.md"   '<!-- apex:apex-start -->'   'apex-start.md'
install_if_marker "$SRC/commands/apex-stop.md"    "$CMD_DIR/apex-stop.md"    '<!-- apex:apex-stop -->'    'apex-stop.md'
install_if_marker "$SRC/commands/apex-doctor.md"  "$CMD_DIR/apex-doctor.md"  '<!-- apex:apex-doctor -->'  'apex-doctor.md'

info "commands installed"

# ---------------------------------------------------------------------------
# Initialize state.json and STATUS.md (absent means APEX is on)
# ---------------------------------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
  if [[ ! -f "$STATE_DIR/state.json" ]]; then
    mkdir -p "$STATE_DIR"
    printf '{"enabled":true,"by":"install"}\n' > "$STATE_DIR/state.json"
    info "created $STATE_DIR/state.json (enabled: true)"
  else
    info "  state.json already exists, left untouched"
  fi
  if [[ ! -f "$STATE_DIR/STATUS.md" ]]; then
    mkdir -p "$STATE_DIR"
    printf 'APEX (Ask. Perfect. EXecute.) is ON. Run the APEX loop from CLAUDE.md and start each reply with the ⚡ APEX · Ask. Perfect. EXecute. block.\n' > "$STATE_DIR/STATUS.md"
    info "created $STATE_DIR/STATUS.md (on)"
  else
    info "  STATUS.md already exists, left untouched"
  fi
else
  dry_info "create $STATE_DIR/state.json and STATUS.md if absent"
fi

# ---------------------------------------------------------------------------
# Update settings.json — migrate old ape-gate/pif-scan; wire apex-gate/apex-scan
# ---------------------------------------------------------------------------
info ""
info "updating $SETTINGS"

if [[ ! -f "$SETTINGS" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo '{}' > "$SETTINGS"
  else
    dry_info "create empty $SETTINGS"
  fi
fi

if [[ $DRY_RUN -eq 0 ]]; then
  python3 - "$SETTINGS" "$NODE_PATH" "$CLAUDE_CONFIG_DIR" "$HOOK_DIR" "$STATE_DIR" <<'PY'
import json, sys, re, os

settings_path, node, cfg, hook_dir, state_dir = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

with open(settings_path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

hooks = data.setdefault('hooks', {})

apex_gate_cmd = f'"{node}" "{hook_dir}/apex-gate.js"'
apex_scan_cmd = f'"{node}" "{hook_dir}/apex-scan.js"'
scan_matcher  = r'^(Read|WebFetch|WebSearch|Bash|mcp__.*)$'

def is_legacy_gate(cmd):
    return 'ape-gate.js' in cmd

def is_legacy_scan(cmd):
    return 'pif-scan.js' in cmd

def is_apex_gate(cmd):
    return 'apex-gate.js' in cmd

def is_apex_scan(cmd):
    return 'apex-scan.js' in cmd

# --- UserPromptSubmit: migrate ape-gate.js -> apex-gate.js ---
ups_groups = hooks.setdefault('UserPromptSubmit', [])
apex_gate_present = False
for grp in ups_groups:
    for h in grp.get('hooks', []):
        cmd = h.get('command', '')
        if is_legacy_gate(cmd):
            h['command'] = apex_gate_cmd
            h['statusMessage'] = 'APEX gate...'
            apex_gate_present = True
            print('settings: migrated ape-gate.js -> apex-gate.js in UserPromptSubmit')
        elif is_apex_gate(cmd):
            apex_gate_present = True

if not apex_gate_present:
    ups_groups.append({
        'hooks': [{
            'type': 'command',
            'command': apex_gate_cmd,
            'timeout': 10,
            'statusMessage': 'APEX gate...',
        }]
    })
    print('settings: wired apex-gate into UserPromptSubmit')
else:
    print('settings: apex-gate already present in UserPromptSubmit')

# --- PostToolUse / PostToolUseFailure: migrate pif-scan.js -> apex-scan.js ---
apex_scan_entry = {
    'matcher': scan_matcher,
    'hooks': [{
        'type': 'command',
        'command': apex_scan_cmd,
        'timeout': 20,
        'statusMessage': 'APEX Firewall scan...',
    }],
}

for event in ('PostToolUse', 'PostToolUseFailure'):
    event_groups = hooks.setdefault(event, [])
    apex_scan_present = False
    for grp in event_groups:
        for h in grp.get('hooks', []):
            cmd = h.get('command', '')
            if is_legacy_scan(cmd):
                h['command'] = apex_scan_cmd
                h['statusMessage'] = 'APEX Firewall scan...'
                apex_scan_present = True
                print(f'settings: migrated pif-scan.js -> apex-scan.js in {event}')
            elif is_apex_scan(cmd):
                apex_scan_present = True

    if not apex_scan_present:
        event_groups.append(apex_scan_entry)
        print(f'settings: wired apex-scan into {event}')
    else:
        # Deduplicate: keep only one apex-scan entry (already migrated above)
        seen = False
        new_groups = []
        for grp in event_groups:
            has_scan = any(is_apex_scan(h.get('command', '')) for h in grp.get('hooks', []))
            if has_scan:
                if not seen:
                    new_groups.append(grp)
                    seen = True
                # else: duplicate, drop it
            else:
                new_groups.append(grp)
        event_groups[:] = new_groups

# --- statusLine: back up existing command, set APEX wrapper when different ---
apex_wrapper_cmd = f'sh "{hook_dir}/apex-statusline.sh"'
existing_status_line = data.get('statusLine')

def status_line_cmd(sl):
    if isinstance(sl, dict):
        return sl.get('command', '')
    return ''

existing_cmd = status_line_cmd(existing_status_line)
is_already_wrapper = 'apex-statusline.sh' in existing_cmd

if not is_already_wrapper:
    # Save old command into chain file if it was set
    chain_file = os.path.join(state_dir, 'statusline-chain')
    if existing_cmd:
        os.makedirs(state_dir, exist_ok=True)
        with open(chain_file, 'w', encoding='utf-8') as cf:
            cf.write(existing_cmd + '\n')
        print(f'settings: saved old statusLine command to {chain_file}')
    data['statusLine'] = {'type': 'command', 'command': apex_wrapper_cmd}
    print(f'settings: set statusLine to APEX wrapper')
else:
    print('settings: statusLine is already the APEX wrapper')

with open(settings_path, 'w', encoding='utf-8') as fh:
    fh.write(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY

  python3 -c "import json; json.load(open('$SETTINGS')); print('settings: verified JSON OK')"
else
  dry_info "python3: update $SETTINGS (apex-gate + apex-scan, migrating legacy entries, statusLine)"
fi

# ---------------------------------------------------------------------------
# Patch CLAUDE.md (unless --no-claude-md)
# ---------------------------------------------------------------------------
info ""
_claude_md="${CLAUDE_CONFIG_DIR}/CLAUDE.md"
_patcher="$REPO/scripts/update-claude-md.py"

if [[ $NO_CLAUDE_MD -eq 1 ]]; then
  info "skipping CLAUDE.md update (--no-claude-md)"
elif [[ ! -f "$_claude_md" ]]; then
  info "CLAUDE.md not found at $_claude_md; skipping"
elif [[ ! -f "$_patcher" ]]; then
  info "WARNING: patcher not found at $_patcher; skipping CLAUDE.md update"
else
  info "patching CLAUDE.md -> $_claude_md"
  _patcher_exit=0
  if [[ $DRY_RUN -eq 1 ]]; then
    python3 "$_patcher" "$_claude_md" "$CLAUDE_CONFIG_DIR" --dry-run || _patcher_exit=$?
    if [[ $_patcher_exit -eq 3 ]]; then
      info "WARNING: CLAUDE.md not changed; paste the printed sections manually"
    fi
  else
    python3 "$_patcher" "$_claude_md" "$CLAUDE_CONFIG_DIR" \
      --backup "$BACKUP_DIR/CLAUDE.md" || _patcher_exit=$?
    if [[ $_patcher_exit -eq 0 ]]; then
      CLAUDE_MD_PATCHED=1
      CLAUDE_MD_BACKUP="$BACKUP_DIR/CLAUDE.md"
      info "CLAUDE.md patched (backup: $CLAUDE_MD_BACKUP)"
      # Append CLAUDE.md restore logic to the already-generated restore.sh
      cat >> "$BACKUP_DIR/restore.sh" <<CLAUDE_RESTORE_APPEND

# 5. Restore CLAUDE.md
_claude_md_path="${CLAUDE_CONFIG_DIR}/CLAUDE.md"
if [[ -f "${BACKUP_DIR}/CLAUDE.md" ]]; then
  _ts="\$(date +%Y%m%d-%H%M%S)"
  [[ -f "\$_claude_md_path" ]] && mv "\$_claude_md_path" "\${_claude_md_path}.rolled-back-\${_ts}"
  cp "${BACKUP_DIR}/CLAUDE.md" "\$_claude_md_path"
  echo "  restored CLAUDE.md"
else
  echo "  no CLAUDE.md backup found; skipping"
fi
CLAUDE_RESTORE_APPEND
    elif [[ $_patcher_exit -eq 3 ]]; then
      info "WARNING: CLAUDE.md not changed; paste the printed sections manually"
    else
      info "WARNING: CLAUDE.md patcher failed (exit $_patcher_exit); continuing"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
info ""
info "APEX (Ask. Perfect. EXecute.) v3.0.0 installed."
info ""
if [[ $DRY_RUN -eq 1 ]] && [[ $NO_CLAUDE_MD -eq 0 ]] && [[ -f "$_claude_md" ]]; then
  info "CLAUDE.md: [dry-run] diff printed above (no changes written)"
elif [[ $CLAUDE_MD_PATCHED -eq 1 ]]; then
  info "CLAUDE.md: updated (backup: $CLAUDE_MD_BACKUP)"
  info "  To revert CLAUDE.md only:"
  info "    python3 $REPO/scripts/update-claude-md.py \\"
  info "      ${CLAUDE_CONFIG_DIR}/CLAUDE.md $CLAUDE_CONFIG_DIR \\"
  info "      --revert $CLAUDE_MD_BACKUP"
elif [[ $NO_CLAUDE_MD -eq 1 ]]; then
  info "CLAUDE.md: skipped (--no-claude-md)"
else
  info "CLAUDE.md: not updated -- run manually or re-run install.sh"
  info "  Add '@${CLAUDE_CONFIG_DIR}/apex/STATUS.md' and replace APE references."
fi
info ""
info "To roll back everything: bash $BACKUP_DIR/restore.sh"
info ""
info "Marketplace note: when this plugin is later installed through a Claude Code"
info "marketplace, remove the manual entries added to settings.json by this script"
info "to avoid double hooks."
