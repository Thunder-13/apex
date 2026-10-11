# Lexicon changelog

Format: phrase | group | why | OOF errors addressed

## Round 1 — 2026-10-01

### flags.destructive — 15 new triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| nuke | General destructive verb; "nuke old branches" got zero signal | 1 (just nuke the old merged branches) |
| wipe | General destructive verb; canonical data destruction term | 0 (no direct error, improves recall) |
| purge | General destructive verb; database/queue purge operations | 0 |
| blow away | Orchestrator called out explicitly as missing | 0 |
| clean up branches | Orchestrator called out explicitly; git branch deletion | 0 |
| kill all | "kill all processes on port 3000" had zero destructive signal | 1 |
| restore from | "restore from rds snapshot" is a high-stakes recovery op | 1 |
| data deletion | "user data deletion system" had zero signal; gdpr context | 1 |
| erase | General destructive verb | 0 |
| drop database | Catastrophic SQL op; general form of "drop table" | 0 |
| rm -r | File tree deletion (variant of existing "rm -rf") | 0 |
| security incident | High-stakes incident response context | 0 |
| prod is down | Production outage response context | 0 |
| hard reset | Git hard reset phrase form (complement to "reset --hard") | 0 |
| run in prod | "before i run it in prod" was misclassified; captures prod execution | 1 |

### pools.reasoning — 4 new triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| what is | Factual question → reasoning; "what is an idempotent api call" mis-routed to reliability | 1 |
| what does | Factual question → reasoning | 1 |
| explain | Explanation request is reasoning, not format-extraction | 1 |
| postmortem | Incident analysis → reasoning | 0 |

### pools.creative — 1 new trigger

| phrase | why | OOF errors addressed |
|---|---|---|
| draft | Drafting (email, postmortem, document) is a writing/creative task | 1 |

### flags.ambiguous — 3 new triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| make it better | Vague improvement request; feeds deep-tier override rule (ambiguous >= 0.6 → deep) | 1 |
| just make it work | Vague request with no context | 0 |
| improve this | Improvement without criteria | 0 |

### features.js — structural feature update

- Extended `DESTRUCTIVE_VERBS_RE` to include: nuke, wipe, purge, erase, overwrite, truncate, reset --soft, rm -r (variant)
- This structural feature feeds the `s:destructive_verbs` count used by the tier:deep head (fitted weight +0.46)

## Round 2 — 2026-10-01

### flags.destructive — 5 new triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| in prod | 2-gram catch-all for prod-execution patterns ("run it in prod", "tested in prod") | 1 |
| customer pii | Personal data exposure → security incident context | 1 |
| data breach | Security incident; explicit breach reporting context | 0 |
| auto deploy | Automated deployment = high blast radius; note: "auto-deploys" still misses (morphology) | 0 |
| reset --soft | Git reset command form; "what does git reset --soft do" is labeled destructive | 1 |

### pools.reliability — 4 new anti-triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| what is | Factual question signal; suppresses reliability when the ask starts with "what is X" | 2 |
| what does | Same; factual-lookup pattern | 1 |
| what are | Same; factual-enumeration pattern | 0 |
| is it true | Yes/no question; not a format-extraction task | 0 |

### pools.creative — 3 new triggers

| phrase | why | OOF errors addressed |
|---|---|---|
| rejection | "rejection email" signals a writing/creative task | 1 |
| warm tone | Explicit tone register → creative pool | 0 |
| audience is | Audience specification signals communicative writing | 0 |

---

## Summary

- Round 1 + 2 total: 37 lexicon changes (28 new triggers, 4 new anti-triggers, 5 structural)
- Destructive flag coverage: 3/15 → 11/15 rows with non-zero signal (OOF gold)
- Pool OOF accuracy: 0.505 → 0.580 (simplified prior; actual model improvement may differ)
- Tier OOF accuracy: 0.640 unchanged (override rules not captured in simplified OOF)
