#!/usr/bin/env python3
"""Validator for holdout.jsonl — APE router evaluation set."""

import json
import sys
from collections import Counter
from pathlib import Path

HOLDOUT = Path(__file__).parent / "holdout.jsonl"

VALID_TIERS = {"micro", "standard", "deep"}
VALID_POOLS = {"creative", "reliability", "reasoning"}
VALID_TASK_TYPES = {
    "code_build", "code_fix", "code_review", "refactor", "ops_shell",
    "data_extract", "classify_label", "data_analysis", "research",
    "explain_teach", "write_prose", "creative_ideation", "plan_design",
    "prompt_agent_design", "decision_advice", "quick_fact",
}
VALID_TECHNIQUES = {
    "T1","T2","T3","T4","T5","T6","T7","T8","T9","T10",
    "T11","T12","T13","T14","T15","T16","T17","T18","T19","T20",
    "T21","T22","T23","T24","T25","T26","T27","T28","T29","T30",
    "T31","T32","T33","T34","T35","T36","T37","T38","T39","T40",
    "T41",
}
FLAG_KEYS = {
    "persona_fit", "critique_loop", "iteration_readiness",
    "output_parseability", "injection_defense", "destructive",
    "ambiguous", "needs_fresh_facts",
}
REQUIRED_FIELDS = {"id", "ask", "tier", "pool", "task_type", "techniques", "flags", "rationale"}

errors = []
rows = []

# ── Load ──────────────────────────────────────────────────────────────────────
if not HOLDOUT.exists():
    print(f"FAIL: {HOLDOUT} not found")
    sys.exit(1)

with open(HOLDOUT) as fh:
    for lineno, line in enumerate(fh, 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            errors.append(f"line {lineno}: JSON parse error: {exc}")
            continue
        rows.append((lineno, obj))

# ── Schema + enum validation ───────────────────────────────────────────────────
ids_seen = {}
for lineno, obj in rows:
    rid = obj.get("id", f"<line {lineno}>")

    # required fields
    missing = REQUIRED_FIELDS - set(obj.keys())
    if missing:
        errors.append(f"{rid}: missing fields {missing}")

    # id uniqueness
    if rid in ids_seen:
        errors.append(f"{rid}: duplicate id (also at line {ids_seen[rid]})")
    ids_seen[rid] = lineno

    # enum checks
    if obj.get("tier") not in VALID_TIERS:
        errors.append(f"{rid}: bad tier '{obj.get('tier')}'")
    if obj.get("pool") not in VALID_POOLS:
        errors.append(f"{rid}: bad pool '{obj.get('pool')}'")
    if obj.get("task_type") not in VALID_TASK_TYPES:
        errors.append(f"{rid}: bad task_type '{obj.get('task_type')}'")

    techs = obj.get("techniques", [])
    if not isinstance(techs, list):
        errors.append(f"{rid}: techniques must be a list")
    elif len(techs) > 2:
        errors.append(f"{rid}: techniques has {len(techs)} entries (max 2)")
    else:
        for t in techs:
            if t not in VALID_TECHNIQUES:
                errors.append(f"{rid}: unknown technique '{t}'")

    flags = obj.get("flags", {})
    if not isinstance(flags, dict):
        errors.append(f"{rid}: flags must be a dict")
    else:
        missing_flags = FLAG_KEYS - set(flags.keys())
        if missing_flags:
            errors.append(f"{rid}: flags missing keys {missing_flags}")
        for k, v in flags.items():
            if k not in FLAG_KEYS:
                errors.append(f"{rid}: unknown flag key '{k}'")
            elif not isinstance(v, bool):
                errors.append(f"{rid}: flag '{k}' is not bool (got {type(v).__name__})")

    if not isinstance(obj.get("ask", ""), str) or not obj.get("ask"):
        errors.append(f"{rid}: ask must be a non-empty string")
    if not isinstance(obj.get("rationale", ""), str) or not obj.get("rationale"):
        errors.append(f"{rid}: rationale must be a non-empty string")

# Bail early on schema errors — coverage counts will be wrong
if errors:
    for e in errors:
        print(f"  SCHEMA ERROR: {e}")
    print(f"\nFAIL: {len(errors)} schema error(s) found in {len(rows)} rows")
    sys.exit(1)

# ── Coverage checks ────────────────────────────────────────────────────────────
objs = [obj for _, obj in rows]

tier_counts   = Counter(o["tier"] for o in objs)
pool_counts   = Counter(o["pool"] for o in objs)
type_counts   = Counter(o["task_type"] for o in objs)
no_tech_count = sum(1 for o in objs if o["techniques"] == [])

flag_true = {k: sum(1 for o in objs if o["flags"].get(k)) for k in FLAG_KEYS}

short_asks = [o for o in objs if len(o["ask"].split()) < 8]
long_asks  = [o for o in objs if len(o["ask"].split()) > 60]

coverage_errors = []

# total rows
if len(objs) != 80:
    coverage_errors.append(f"expected 80 rows, got {len(objs)}")

# tier min 12 each
for t in VALID_TIERS:
    if tier_counts[t] < 12:
        coverage_errors.append(f"tier '{t}' only {tier_counts[t]} (need >= 12)")

# pool min 15 each
for p in VALID_POOLS:
    if pool_counts[p] < 15:
        coverage_errors.append(f"pool '{p}' only {pool_counts[p]} (need >= 15)")

# task type min 3 each
for tt in VALID_TASK_TYPES:
    if type_counts[tt] < 3:
        coverage_errors.append(f"task_type '{tt}' only {type_counts[tt]} (need >= 3)")

# no-technique asks >= 15
if no_tech_count < 15:
    coverage_errors.append(f"only {no_tech_count} asks with techniques=[] (need >= 15)")

# every flag true >= 4 times
for k, cnt in flag_true.items():
    if cnt < 4:
        coverage_errors.append(f"flag '{k}' true only {cnt} times (need >= 4)")

# short asks >= 15
if len(short_asks) < 15:
    coverage_errors.append(f"only {len(short_asks)} asks under 8 words (need >= 15)")

# long asks >= 10
if len(long_asks) < 10:
    coverage_errors.append(f"only {len(long_asks)} asks over 60 words (need >= 10)")

# ── Report ─────────────────────────────────────────────────────────────────────
print("\n=== Coverage counts ===")
print(f"Total rows : {len(objs)}")
print(f"\nTiers      : {dict(sorted(tier_counts.items()))}")
print(f"Pools      : {dict(sorted(pool_counts.items()))}")
print(f"\nTask types :")
for tt in sorted(VALID_TASK_TYPES):
    print(f"  {tt:<25} {type_counts[tt]}")
print(f"\nTechniques=[] : {no_tech_count}")
print(f"Asks < 8 words: {len(short_asks)}")
print(f"Asks > 60 words: {len(long_asks)}")
print(f"\nFlag true counts:")
for k in sorted(FLAG_KEYS):
    print(f"  {k:<25} {flag_true[k]}")

if coverage_errors:
    print("\n=== Coverage failures ===")
    for e in coverage_errors:
        print(f"  FAIL: {e}")
    print(f"\nFAIL: {len(coverage_errors)} coverage rule(s) not met")
    sys.exit(1)

print("\nHOLDOUT OK 80 rows")
