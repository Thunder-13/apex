#!/usr/bin/env python3
"""
Validate gold.jsonl against schema, enum values, and all coverage requirements.
Prints "GOLD OK <n> rows" plus per-label counts on success.
Raises AssertionError with details on first failing requirement.
"""
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

GOLD_PATH = Path(__file__).parent / "gold.jsonl"

# ── Valid enum sets ───────────────────────────────────────────────────────────
VALID_TIERS = {"micro", "standard", "deep"}
VALID_POOLS = {"creative", "reliability", "reasoning"}
VALID_TASK_TYPES = {
    "code_build", "code_fix", "code_review", "refactor", "ops_shell",
    "data_extract", "classify_label", "data_analysis", "research",
    "explain_teach", "write_prose", "creative_ideation", "plan_design",
    "prompt_agent_design", "decision_advice", "quick_fact",
}
VALID_TECHNIQUES = {f"T{i}" for i in range(1, 42)} | {"none"}
REQUIRED_FLAGS = {
    "persona_fit", "critique_loop", "iteration_readiness",
    "output_parseability", "injection_defense", "destructive",
    "ambiguous", "needs_fresh_facts",
}
REQUIRED_FIELDS = {"id", "ask", "tier", "pool", "task_type", "techniques", "flags", "rationale"}

# ── Load and parse ────────────────────────────────────────────────────────────
rows = []
with open(GOLD_PATH, encoding="utf-8") as f:
    for line_no, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise AssertionError(f"Line {line_no}: JSON parse error: {e}")
        rows.append((line_no, obj))

n = len(rows)
print(f"Loaded {n} rows.")

# ── Per-row schema validation ─────────────────────────────────────────────────
ids_seen = set()
first6_seen = {}
errors = []

for line_no, obj in rows:
    row_id = obj.get("id", f"<line {line_no}>")

    # Required fields
    missing = REQUIRED_FIELDS - set(obj.keys())
    if missing:
        errors.append(f"{row_id}: missing fields {missing}")

    # ID uniqueness
    if row_id in ids_seen:
        errors.append(f"{row_id}: duplicate id")
    ids_seen.add(row_id)

    # Enum: tier
    if obj.get("tier") not in VALID_TIERS:
        errors.append(f"{row_id}: invalid tier '{obj.get('tier')}'")

    # Enum: pool
    if obj.get("pool") not in VALID_POOLS:
        errors.append(f"{row_id}: invalid pool '{obj.get('pool')}'")

    # Enum: task_type
    if obj.get("task_type") not in VALID_TASK_TYPES:
        errors.append(f"{row_id}: invalid task_type '{obj.get('task_type')}'")

    # techniques: list, 0-2 items, each valid
    techs = obj.get("techniques", [])
    if not isinstance(techs, list):
        errors.append(f"{row_id}: techniques must be a list")
    elif len(techs) > 2:
        errors.append(f"{row_id}: techniques has {len(techs)} items (max 2)")
    else:
        for t in techs:
            if t not in VALID_TECHNIQUES:
                errors.append(f"{row_id}: unknown technique '{t}'")

    # flags: all required keys, all boolean
    flags = obj.get("flags", {})
    if not isinstance(flags, dict):
        errors.append(f"{row_id}: flags must be a dict")
    else:
        missing_flags = REQUIRED_FLAGS - set(flags.keys())
        if missing_flags:
            errors.append(f"{row_id}: missing flags {missing_flags}")
        for k, v in flags.items():
            if not isinstance(v, bool):
                errors.append(f"{row_id}: flag '{k}' must be bool, got {type(v).__name__}")

    # rationale: non-empty string
    rat = obj.get("rationale", "")
    if not isinstance(rat, str) or not rat.strip():
        errors.append(f"{row_id}: rationale must be non-empty string")

    # First-6-words uniqueness
    ask = obj.get("ask", "")
    first6 = " ".join(ask.lower().split()[:6])
    if first6 in first6_seen:
        errors.append(
            f"{row_id}: first-6-words collision with {first6_seen[first6]}: '{first6}'"
        )
    else:
        first6_seen[first6] = row_id

if errors:
    for e in errors[:30]:
        print("ERROR:", e)
    if len(errors) > 30:
        print(f"... and {len(errors)-30} more errors")
    raise AssertionError(f"{len(errors)} schema/enum errors found.")

print("Schema validation passed.")

# ── Coverage checks ───────────────────────────────────────────────────────────
tier_counts   = Counter(obj["tier"] for _, obj in rows)
pool_counts   = Counter(obj["pool"] for _, obj in rows)
task_counts   = Counter(obj["task_type"] for _, obj in rows)
technique_ids = Counter()
no_technique_count = 0
flag_true_counts  = Counter()
flag_false_counts = Counter()
short_asks = 0   # < 8 words
long_asks  = 0   # > 60 words

for _, obj in rows:
    techs = obj["techniques"]
    if not techs:
        no_technique_count += 1
    for t in techs:
        technique_ids[t] += 1

    for flag, val in obj["flags"].items():
        if val:
            flag_true_counts[flag] += 1
        else:
            flag_false_counts[flag] += 1

    word_count = len(obj["ask"].split())
    if word_count < 8:
        short_asks += 1
    if word_count > 60:
        long_asks += 1

# Print counts before asserting
print("\n── Tier distribution ──────────────")
for t in sorted(VALID_TIERS):
    pct = 100 * tier_counts[t] / n
    print(f"  {t:10s}: {tier_counts[t]:3d}  ({pct:.1f}%)")

print("\n── Pool distribution ──────────────")
for p in sorted(VALID_POOLS):
    print(f"  {p:12s}: {pool_counts[p]:3d}")

print("\n── Task type distribution ─────────")
for tt in sorted(VALID_TASK_TYPES):
    print(f"  {tt:22s}: {task_counts[tt]:3d}")

print("\n── Techniques used ────────────────")
all_technique_ids_in_T = [t for t in technique_ids if t.startswith("T")]
print(f"  Distinct T-IDs used: {len(all_technique_ids_in_T)}")
for t in sorted(all_technique_ids_in_T, key=lambda x: int(x[1:])):
    print(f"    {t}: {technique_ids[t]}")
print(f"  Entries with techniques=[]: {no_technique_count}")

print("\n── Flag counts (true / false) ─────")
for flag in sorted(REQUIRED_FLAGS):
    print(f"  {flag:25s}: true={flag_true_counts[flag]:3d}  false={flag_false_counts[flag]:3d}")

print(f"\n── Ask lengths ────────────────────")
print(f"  Under 8 words:  {short_asks}")
print(f"  Over 60 words:  {long_asks}")

# ── Assertions ────────────────────────────────────────────────────────────────
FAILURES = []

def chk(condition, msg):
    if not condition:
        FAILURES.append(msg)

# Task type: every type at least 8 times
for tt in VALID_TASK_TYPES:
    chk(task_counts[tt] >= 8, f"task_type '{tt}' appears only {task_counts[tt]} times (need ≥8)")

# Pool: every pool at least 40 times
for p in VALID_POOLS:
    chk(pool_counts[p] >= 40, f"pool '{p}' appears only {pool_counts[p]} times (need ≥40)")

# Tier: roughly 30% micro, 50% standard, 20% deep (allow ±8%)
chk(0.22 <= tier_counts["micro"]    / n <= 0.38, f"micro tier {tier_counts['micro']/n:.1%} outside 22-38%")
chk(0.42 <= tier_counts["standard"] / n <= 0.58, f"standard tier {tier_counts['standard']/n:.1%} outside 42-58%")
chk(0.12 <= tier_counts["deep"]     / n <= 0.28, f"deep tier {tier_counts['deep']/n:.1%} outside 12-28%")

# Techniques: at least 30 distinct T-IDs used
chk(len(all_technique_ids_in_T) >= 30,
    f"Only {len(all_technique_ids_in_T)} distinct technique IDs used (need ≥30)")

# At least 20 asks with techniques=[]
chk(no_technique_count >= 20,
    f"Only {no_technique_count} asks have techniques=[] (need ≥20)")

# Every flag: true ≥10, false ≥10
for flag in REQUIRED_FLAGS:
    chk(flag_true_counts[flag] >= 10,
        f"Flag '{flag}' is true only {flag_true_counts[flag]} times (need ≥10)")
    chk(flag_false_counts[flag] >= 10,
        f"Flag '{flag}' is false only {flag_false_counts[flag]} times (need ≥10)")

# Length checks
chk(short_asks >= 30, f"Only {short_asks} asks under 8 words (need ≥30)")
chk(long_asks  >= 20, f"Only {long_asks} asks over 60 words (need ≥20)")

if FAILURES:
    print("\n── FAILURES ───────────────────────")
    for f in FAILURES:
        print(" FAIL:", f)
    raise AssertionError(f"{len(FAILURES)} coverage requirement(s) not met.")

print(f"\nGOLD OK {n} rows")
