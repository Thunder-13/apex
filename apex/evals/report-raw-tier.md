# APEX v2 Router Evaluation Report

Data: evals/holdout.norm.jsonl
Rows: 80 | Evaluated: 80

## Tier
accuracy (raw model head): 0.600 | accuracy (post-override): 0.600
macro-F1: 0.602 | ECE: 0.152 | Brier: 0.181
majority baseline: 0.487 | prior-only baseline: 0.362

## Pool
accuracy: 0.650 | macro-F1: 0.619 | ECE: 0.071 | Brier: 0.145
majority baseline: 0.425 | prior-only baseline: 0.588

## Task type (top-1)
accuracy: 0.537 | macro-F1: 0.502
majority baseline: 0.063

## Techniques
(a) top-2 recall (non-empty rows, n=55): 0.136
(b) none-accuracy (empty-gold rows, n=25): 0.920
(c) precision of picks (non-empty rows): 0.200

## FAST subset
coverage: 1.3% | accuracy: 1.000
tau_fast: 0.66

## Latency
per-row p50: 1ms | p95: 2ms
in-process (1000 calls) p50: 1ms | p95: 1ms

## Check gates
FAIL tier_acc >= 0.85: 0.600
FAIL pool_acc >= 0.90: 0.650
FAIL tech_top2_recall >= 0.80: 0.136
FAIL tier_ECE <= 0.10: 0.152
PASS pool_ECE <= 0.10: 0.071
PASS fast_acc >= 0.85: 1.000
PASS inproc_p95 < 15ms: 1ms