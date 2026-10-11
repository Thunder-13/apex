#!/usr/bin/env python3
"""Align tier labels with the user's CLAUDE.md rule before fitting or scoring.

CLAUDE.md: "Deep (multi-file, ambiguous, or destructive)". Any row whose
destructive or ambiguous flag is true gets tier = deep. The rule reads labels
only, never router output, and is applied identically to gold and holdout.
Writes <name>.norm.jsonl next to the input and prints what changed.
"""
import json, sys, collections

for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    changed = collections.Counter()
    for r in rows:
        if (r['flags']['destructive'] or r['flags']['ambiguous']) and r['tier'] != 'deep':
            changed[r['tier']] += 1
            r['tier_raw'] = r['tier']
            r['tier'] = 'deep'
    out = path.replace('.jsonl', '.norm.jsonl')
    with open(out, 'w', encoding='utf-8') as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    tiers = collections.Counter(r['tier'] for r in rows)
    print(f'{path}: {sum(changed.values())} rows raised to deep {dict(changed)} -> tiers {dict(tiers)} -> {out}')
