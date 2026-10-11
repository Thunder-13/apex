#!/usr/bin/env python3
"""
update-claude-md.py  <CLAUDE.md>  <config-dir>
    [--dry-run]  [--backup <path>]  [--revert <backup>]

Apply 7 APE -> APEX renames to CLAUDE.md. Safe and idempotent.
Exit 0 on success. Exit 3 when at least one rule is unmatched (nothing written).
"""

import sys
import os
import argparse
import shutil
import tempfile
import difflib
import re
import datetime

# ---------------------------------------------------------------------------
# Rule text constants
# ---------------------------------------------------------------------------

R1_OLD = (
    "## Mandate zero: Auto Prompt Engine (APE)\n"
    "\n"
    "Runs before everything else. Every ask, every session, no exceptions, including\n"
    "the model-routing rule below. The only bypass is `/thunder-skip`.\n"
    "\n"
    "**Escape hatch.** Put `/thunder-skip` anywhere in a prompt and APE is skipped\n"
    "for that turn. The raw ask runs directly, no APE block, no note about skipping.\n"
    "Absent that token, the loop runs."
)

R1_NEW_TMPL = (
    "## Mandate zero: APEX (Ask. Perfect. EXecute.)\n"
    "\n"
    "Runs before everything else. Every ask, every session, including the\n"
    "model-routing rule below, while APEX is on.\n"
    "\n"
    "**On or off.** APEX is on by default. `/apex-stop` turns it off and `/apex-start`\n"
    "turns it back on. Current state:\n"
    "\n"
    "@{import_path}\n"
    "\n"
    "When APEX is off (the state above says STOPPED, or the most recent toggle in this\n"
    "conversation was `/apex-stop`), skip the loop and print no ⚡ block. While it is\n"
    "on, every reply starts with the ⚡ APEX block, so the ⚡ is the visible on signal.\n"
    "\n"
    "**Escape hatch.** Put `/apex-skip` anywhere in a prompt and APEX is skipped for\n"
    "that prompt. The raw ask runs directly, no APEX block, no note about skipping.\n"
    "Absent that token, and with APEX on, the loop runs."
)

R2_OLD = "```\n⚡ APE\nTechnique:"
R2_NEW  = "```\n⚡ APEX · Ask. Perfect. EXecute.\nTechnique:"

R3_OLD = "**Order of operations:** APE -> plan on Opus"
R3_NEW  = "**Order of operations:** APEX -> plan on Opus"

R4_OLD = (
    "Full ruleset: skill `/auto-prompt-engine`\n"
    "(`~/.claude/skills/auto-prompt-engine/SKILL.md`).\n"
    "Technique library: `~/.claude/skills/auto-prompt-engine/references/techniques.md`"
)
R4_NEW = (
    "Full ruleset: skill `/apex`\n"
    "(`~/.claude/skills/apex/SKILL.md`).\n"
    "Technique library: `~/.claude/skills/apex/references/techniques.md`"
)

R5_OLD = (
    "Enforcement: `~/.claude/hooks/ape-gate.js`, wired to `UserPromptSubmit`; it\n"
    "injects the S1 verdict (literals to preserve, risk signals, gated exemplars)."
)
R5_NEW = (
    "Enforcement: `~/.claude/hooks/apex-gate.js`, wired to `UserPromptSubmit`; it\n"
    "injects the S1 verdict (literals to preserve, risk signals, gated exemplars) and\n"
    "the APEX Firewall result. `~/.claude/hooks/apex-scan.js` runs the APEX Firewall\n"
    "on tool output. On an organization account with `allowManagedHooksOnly`, neither\n"
    "hook runs; this file and the `/apex-*` commands carry APEX. `/apex-doctor` reports\n"
    "which applies."
)

R6_OLD = "0. APE is already live via hook. Nothing to activate."
R6_NEW  = (
    "0. APEX (Ask. Perfect. EXecute.) is on by default, shown by ⚡ in every reply."
    " `/apex-stop` and `/apex-start` toggle it; `/apex-doctor` checks the setup."
)

R7_OLD = (
    "- APE skill: `~/.claude/skills/auto-prompt-engine/SKILL.md`\n"
    "- APE hook: `~/.claude/hooks/ape-gate.js` (UserPromptSubmit)\n"
    "- APE bypass: `/thunder-skip`"
)
R7_NEW = (
    "- APEX skill: `~/.claude/skills/apex/SKILL.md`\n"
    "- APEX hooks: `~/.claude/hooks/apex-gate.js` (UserPromptSubmit),"
    " `~/.claude/hooks/apex-scan.js` (PostToolUse, APEX Firewall)\n"
    "- APEX commands: `/apex` (deep pass), `/apex-start`, `/apex-stop`,"
    " `/apex-skip` (one prompt), `/apex-scan <file>`, `/apex-doctor`"
)

# (rule_id, old, new_template, new_anchor)
RULES = [
    ("R1", R1_OLD, R1_NEW_TMPL, "## Mandate zero: APEX (Ask. Perfect. EXecute.)"),
    ("R2", R2_OLD, R2_NEW,      "⚡ APEX · Ask. Perfect. EXecute.\nTechnique:"),
    ("R3", R3_OLD, R3_NEW,      "**Order of operations:** APEX -> plan on Opus"),
    ("R4", R4_OLD, R4_NEW,      "Full ruleset: skill `/apex`"),
    ("R5", R5_OLD, R5_NEW,      "Enforcement: `~/.claude/hooks/apex-gate.js`"),
    ("R6", R6_OLD, R6_NEW,      "0. APEX (Ask. Perfect. EXecute.) is on by default"),
    ("R7", R7_OLD, R7_NEW,      "- APEX skill: `~/.claude/skills/apex/SKILL.md`"),
]

RESIDUAL_CHECKS = [
    (r'\bAPE\b',           'standalone APE'),
    ('thunder-skip',       'thunder-skip'),
    ('auto-prompt-engine', 'auto-prompt-engine'),
    ('ape-gate',           'ape-gate'),
]

# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def compute_import_path(config_dir):
    home = os.environ.get('HOME', '')
    if home:
        canonical_dot_claude = os.path.realpath(os.path.join(home, '.claude'))
        if os.path.realpath(config_dir) == canonical_dot_claude:
            return '~/.claude/apex/STATUS.md'
    return os.path.join(os.path.abspath(config_dir), 'apex', 'STATUS.md')


def apply_rules(content, import_path):
    changed = []
    unmatched = []

    for rule_id, old, new_tmpl, new_anchor in RULES:
        new = new_tmpl.replace('{import_path}', import_path)
        if old in content:
            content = content.replace(old, new, 1)
            changed.append(rule_id)
        elif new_anchor in content:
            pass  # already applied; idempotent skip
        else:
            unmatched.append((rule_id, new))

    return content, changed, unmatched


def check_residuals(content):
    hits = []
    for pattern, label in RESIDUAL_CHECKS:
        if re.search(pattern, content):
            hits.append(label)
    return hits


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Apply APE -> APEX renames to CLAUDE.md.')
    parser.add_argument('claude_md',  help='path to CLAUDE.md')
    parser.add_argument('config_dir', help='config dir (e.g. ~/.claude)')
    parser.add_argument('--dry-run',  action='store_true',
                        help='print unified diff; write nothing')
    parser.add_argument('--backup',   default='', metavar='PATH',
                        help='backup destination path')
    parser.add_argument('--revert',   default='', metavar='BACKUP',
                        help='copy a backup back to CLAUDE.md')
    args = parser.parse_args()

    claude_md  = os.path.abspath(args.claude_md)
    config_dir = os.path.abspath(args.config_dir)

    if args.revert:
        src = os.path.abspath(args.revert)
        if not os.path.exists(src):
            print(f'revert: backup not found: {src}', file=sys.stderr)
            sys.exit(1)
        shutil.copy2(src, claude_md)
        print(f'reverted {claude_md} from {src}')
        sys.exit(0)

    with open(claude_md, 'r', encoding='utf-8') as fh:
        original = fh.read()

    import_path = compute_import_path(config_dir)
    new_content, changed, unmatched = apply_rules(original, import_path)

    if unmatched:
        rule_ids = ', '.join(r for r, _ in unmatched)
        print(
            f'CLAUDE.md: {len(unmatched)} rule(s) unmatched ({rule_ids}) -- nothing written',
            file=sys.stderr)
        for rule_id, new_text in unmatched:
            print(f'\n--- unmatched {rule_id}: paste this manually ---', file=sys.stderr)
            print(new_text, file=sys.stderr)
        sys.exit(3)

    if args.dry_run:
        diff = list(difflib.unified_diff(
            original.splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile='CLAUDE.md (before)',
            tofile='CLAUDE.md (after)',
        ))
        sys.stdout.writelines(diff if diff else ['(no changes)\n'])
        sys.exit(0)

    backup_path = args.backup or os.path.join(
        config_dir, 'backups',
        'claude-md-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.md'
    )
    os.makedirs(os.path.dirname(os.path.abspath(backup_path)), exist_ok=True)
    shutil.copy2(claude_md, backup_path)
    print(f'backup: {backup_path}')

    dir_ = os.path.dirname(claude_md)
    fd, tmp = tempfile.mkstemp(dir=dir_, prefix='.claude-md-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(new_content)
        os.replace(tmp, claude_md)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    print(f'CLAUDE.md updated: {", ".join(changed)} applied; import path: {import_path}')

    hits = check_residuals(new_content)
    if hits:
        print(f'INFO: residuals still present after update: {", ".join(hits)}')

    sys.exit(0)


if __name__ == '__main__':
    main()
