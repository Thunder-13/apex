#!/bin/sh
# apex-statusline.sh - POSIX sh status line wrapper for APEX (Ask. Perfect. EXecute.)
#
# Reads stdin once. If <config>/apex/statusline-chain exists, runs the stored
# command with the same stdin and captures its output. Prints "⚡ APEX" (joined
# by " · " to the chained output when non-empty) when APEX is on; prints only
# the chained output when APEX is off.
#
# On/off decision: grep "enabled" : *false in state.json. Missing file means on.
# Never fails: exit 0 on any error.
set -e

# ---------------------------------------------------------------------------
# Config dir
# ---------------------------------------------------------------------------
_cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
_state="${_cfg}/apex/state.json"
_chain="${_cfg}/apex/statusline-chain"

# ---------------------------------------------------------------------------
# Read stdin once into a temp file so we can pass it to the chain
# ---------------------------------------------------------------------------
_tmpdir=""
_stdin_file=""
if command -v mktemp >/dev/null 2>&1; then
  _tmpdir="$(mktemp -d 2>/dev/null)" || _tmpdir=""
fi
if [ -n "$_tmpdir" ]; then
  _stdin_file="${_tmpdir}/apex-statusline-stdin"
  cat > "$_stdin_file" 2>/dev/null || true
else
  # Cannot buffer stdin; skip chaining
  cat > /dev/null 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Run chain command (if present) with the buffered stdin
# ---------------------------------------------------------------------------
_chain_out=""
if [ -f "$_chain" ] && [ -n "$_stdin_file" ]; then
  _chain_cmd="$(cat "$_chain" 2>/dev/null)" || _chain_cmd=""
  if [ -n "$_chain_cmd" ]; then
    _chain_out="$(eval "$_chain_cmd" < "$_stdin_file" 2>/dev/null)" || _chain_out=""
  fi
fi

# Clean up temp dir
if [ -n "$_tmpdir" ]; then
  rm -rf "$_tmpdir" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Decide on/off: missing state.json means on
# ---------------------------------------------------------------------------
_apex_on=1
if [ -f "$_state" ]; then
  if grep -qE '"enabled": *false' "$_state" 2>/dev/null; then
    _apex_on=0
  fi
fi

# ---------------------------------------------------------------------------
# Emit output
# ---------------------------------------------------------------------------
if [ "$_apex_on" = "1" ]; then
  if [ -n "$_chain_out" ]; then
    printf '%s' "⚡ APEX · ${_chain_out}"
  else
    printf '%s' "⚡ APEX"
  fi
else
  if [ -n "$_chain_out" ]; then
    printf '%s' "$_chain_out"
  fi
fi

exit 0
