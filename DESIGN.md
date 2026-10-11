# APEX v2 design: a System One router in front of the System Two loop

## Outcome (2026-10-01)

### Measured results

The lexical router (v2.0) was evaluated on an 80-ask holdout written by a second
author (labels are model-authored; tier labels are normalized to the CLAUDE.md
Deep rule for destructive/ambiguous/multi-file asks).

| Head | Router holdout accuracy | Two-Sonnet annotator agreement |
|---|---|---|
| tier | 0.60 | 0.83 |
| pool | 0.65 | 0.90 |
| task | 0.54 | 0.93 |
| technique top-2 recall | 0.14 | 0.69 |
| flags | n/a | 0.90-1.00 |

The router's learned heads are not accurate enough to route on directly. The
annotator agreement numbers show the ceiling the model can reach when answering
the same questions with the same typed structure.

### Design change: router 2.1

The learned classification heads are demoted to opt-in hints (`APEX_HINTS=1`).
The default verdict now contains only what code is reliable at:

- **Deterministic literal extraction** (`preserve` line): MCP ids, slash
  commands, paths, URLs, backtick spans, quoted strings, env vars, SHAs.
- **Severity-tagged destructive signals and injection phrases** (`signals`
  line): HIGH-severity destructive terms always raise to Deep; 3+ distinct file
  paths also raise; LOW terms are reported for the model's calibration.
- **Gated BM25 exemplar retrieval**: shown only on a strong precision-gated
  bank match; the bank skews to plan_design (220 of 377 prompts).

The LLM answers the judgment questions itself via the decision card (Jev method:
typed atomic questions answered independently in 0.05 steps, combined by
deterministic rules). Ambiguity is decided by the card, not the hook. This
architecture matches ability to task: code handles what code does reliably; the
model handles what the model does reliably.

The original plan below describes the v2.0 design. Where this outcome section
disagrees, the outcome section takes precedence.

---

# Original plan (superseded where the outcome section above says so)

Status: plan, written on Opus 2026-10-01. Workers build against this file.

## Why this shape

Jev (TypeSafe, docs in `research/jev-docs/`, brief in `research/jev-brief.md`)
gets its speed and trustworthiness from four ideas, and none of them needs a
trained model to be useful:

1. **Typed decisions, not prose.** Every question has a closed answer space
   (Choice / Score / Noul) and returns a probability per answer.
2. **Atomic questions, asked together, answered in isolation.** One pass over
   the same state answers many narrow questions ("speculative fan-out"); code
   combines them.
3. **Calibrated confidence gates behaviour.** Confidence decides whether
   software acts on the answer or escalates to a slower reasoner.
4. **Code stays in control.** Deterministic checks and weighted combination
   happen in code, never inside a prompt.

APEX v1 asked the LLM to do everything in prose: guess the tier, guess the
pool, pick techniques from memory, then write and score candidates. v2 splits
that into two systems:

- **System One (new):** `router/`, a zero-dependency Node module run by the
  `UserPromptSubmit` hook. It reads the raw ask and emits a typed verdict with
  probabilities and confidence in single-digit milliseconds: tier, pool, task
  type, per-technique probabilities, trigger flags, and the best exemplar
  prompts from the 377-prompt bank.
- **System Two (existing, upgraded):** the SKILL.md loop. It still writes three
  candidates and scores them, but it starts from the verdict. Confidence
  decides how much deliberation it spends on technique selection.

What this does not claim: the router is not Jev. It is a linear model over
lexical and structural features, fit on a few hundred labeled asks. The LLM
stays the final arbiter and overrides the router whenever the router is
unsure or wrong. Accuracy numbers are agreement with model-authored labels,
reported on a holdout written by a different author.

## Layout (plugin root = `apex/apex/`)

```
apex/
  .claude-plugin/plugin.json      version 2.0.0
  SKILL.md                        System Two loop, v2
  commands/apex.md                 forced Deep pass, now shows the router table
  commands/apex-skip.md        unchanged
  hooks/hooks.json                unchanged shape
  hooks/apex-gate.js               v2: runs router, prints verdict + mandate
  references/techniques.md        library v2 (T1..Tn), human-readable
  references/techniques.json      registry v2, machine-readable
  references/bank/                copies of the 377 bank prompts
  references/bank-index.json      compiled index + BM25 stats
  router/features.js              state -> feature vector
  router/lexicons.json            trigger lexicons (techniques, tasks, pools, tiers, flags)
  router/model.json               fitted weights + temperatures + thresholds
  router/router.js                route(prompt) -> verdict; format(verdict) -> text
  router/bank.js                  BM25 exemplar retrieval
  router/fit.js                   fit weights + calibrate on evals/gold.jsonl
  router/eval.js                  metrics on evals/holdout.jsonl (+ 5-fold CV on gold)
  router/build-bank.js            research/bank-index-*.jsonl -> references/bank-index.json
  tests/router.test.js            node:test unit tests
  evals/                          gold.jsonl, holdout.jsonl, report.md
```

## System One: the questions (Jev primitives)

State = the raw prompt string (the hook payload's `prompt`). All questions are
answered from the same feature vector in one pass, each by its own head, so no
head's answer leaks into another's (Jev: "evaluated in parallel and in
isolation against the same state").

| Head | Primitive | Answer space |
|---|---|---|
| tier | Choice | micro, standard, deep |
| pool | Choice | creative, reliability, reasoning |
| task | Choice | 16 task types from `research/tag-vocab.md` |
| tech.Tk | Noul, one per technique | p(technique k improves this prompt) |
| flag.f | Noul, one per flag | persona_fit, critique_loop, iteration_readiness, output_parseability, injection_defense, destructive, ambiguous, needs_fresh_facts |

### Features (`features.js`)

Deterministic, lowercase, Unicode-aware. Returns a flat `{name: number}` map.

- **Lexicon hits**, one feature per group: every technique, task type, pool,
  tier, and flag has a trigger list and an anti list in `lexicons.json`
  (seeded from `research/trigger-lexicon.json`, extended by hand where the
  gold set shows gaps). Feature value = `log1p(trigger hits) - 0.7*log1p(anti hits)`.
  Match on word boundaries; multi-word phrases match as phrases.
- **Structure:** `log_words`, `has_code_fence`, `has_path`, `has_url`,
  `has_mcp_tool`, `has_slash_cmd`, `ends_question`, `starts_imperative`,
  `n_list_items`, `n_and_clauses`, `pasted_long` (> 600 chars), `has_stack_trace`,
  `has_json_blob`, `n_file_refs`, `scope_all_words` (all, every, entire, whole
  repo), `destructive_verbs` (rm -rf, delete, drop, force push, reset --hard,
  deploy, prod, publish, send, migrate), `non_ascii_ratio`, `followup_refs`
  (it, that, same, again, the other), `bias`.
- Stack trace, JSON blobs, and code fences count as structure, but their text
  still feeds lexicons at 0.3 weight so a pasted `json` does not read as "make
  me JSON".

### Model (`model.json`, `router.js`)

- Choice head h with classes c: `logit_c = sum_i W[h][c][i] * x_i + b[h][c]`,
  `p = softmax(logit / T_h)`.
- Noul head: `p = sigmoid((w . x + b) / T_h)`.
- **Prior weights.** Before fitting, `W` is the hand prior: +1.0 from a class's
  own lexicon feature, +0.3 from lexicons of known-related classes (pool
  `reliability` <- task `data_extract`, `classify_label`, `code_build`;
  techniques via `techniques.json` pool/task affinity), 0 elsewhere.
- **Fit (`fit.js`).** Multinomial / binary logistic regression by full-batch
  gradient descent on `evals/gold.jsonl`, loss = NLL + `lambda * ||W - W_prior||^2`.
  Pull toward the prior, not toward zero: with a few hundred rows the prior
  carries most of the signal and the data corrects it. Choose `lambda` by
  5-fold CV on gold (grid 0.01..3). Then fit temperature `T_h` per head by
  minimizing NLL on out-of-fold predictions (temperature scaling).
- **Confidence (Jev's formulas, see `research/jev-brief.md` section 2).**
  Choice: `conf = clamp((N * p_max - 1) / (N - 1), 0, 1)`. Noul: use the
  brief's stated formula; if none is stated, `conf = |2p - 1|`.

### Code in control (`router.js`, deterministic, after the model)

1. Technique pick: rank techniques by `p`. Keep the top 2 with
   `p >= theta_tech`; drop the second if `techniques.json` lists it as a
   conflict of the first or if its `p < 0.5 * p_first`; output `none` when
   nothing clears `theta_tech`. Anti-trigger vetoes from `techniques.json`
   apply (example: T1 persona is vetoed when pool = reliability with p > 0.8
   and task is data_extract or classify_label).
2. Tier overrides: `flag.destructive >= 0.5` or `flag.ambiguous >= 0.6` raises the tier to deep (CLAUDE.md: "Deep (multi-file, ambiguous, or destructive)"); three
   or more file refs or `scope_all_words` plus a code task raises standard to
   deep. Overrides are recorded in the verdict so the LLM sees why.
3. **Mode (confidence-gated routing).** `overall = min(conf_tier, conf_pool,
   conf_tech)` where `conf_tech` = Noul confidence of the top technique (or of
   the strongest rejected one when the pick is `none`).
   - `FAST` when `overall >= tau_fast`: System Two adopts the verdict's tier,
     pool and techniques, and spends its effort on candidates.
   - `CHECK` when `tau_check <= overall < tau_fast`: System Two confirms or
     swaps among the top 3 techniques shown.
   - `DELIBERATE` below `tau_check`: System Two does full technique selection
     from `techniques.md`; the verdict is a weak prior.
   `tau_fast` is set on out-of-fold gold predictions as the lowest threshold
   whose FAST-subset accuracy (tier, pool and top technique all correct) is
   >= 0.90. `tau_check` is the threshold where accuracy drops below 0.60.
4. Exemplars: `bank.js` BM25 (k1 = 1.2, b = 0.75) over each bank doc's
   `title + use_when + structure + keywords x2 + task_types + technique names`.
   Query = ask tokens + predicted task name + names of the picked techniques.
   Final score = `bm25 * (0.6 + 0.1 * quality)`, filtered to docs sharing at
   least one of the top-2 task types when any exist. Return top 2 with
   relative path, `use_when`, and the first 160 chars of `fragment`.

### Verdict text (what the hook injects, <= 12 lines)

```
APEX S1 verdict (router 2.0, 4 ms, model fit 2026-10-01)
tier standard 0.82 | pool reliability 0.91 | task data_extract 0.74
techniques T7 Structured output 0.88 + T12 Grounding 0.61 | next T2 Few-shot 0.34
flags output_parseability 0.93, injection_defense 0.58
mode FAST (confidence 0.71 >= 0.66): adopt tier/pool/techniques, deliberate on candidates
exemplars references/bank/structured_output_extractor.txt - <use_when>
          references/bank/<file> - <use_when>
```

Followed by the v2 mandate (the v1 mandate, tightened, plus how to use the
verdict). Only flags with `p >= 0.5` are printed.

### Hook contract (unchanged, still binding)

Never blocks, never throws, always exits 0. `/apex-skip` anywhere bypasses
with the v1 bypass text and no router call. Bare CLI commands in `NO_TASK`
inject nothing. Router failure (missing file, bad JSON, exception) falls back
to the mandate alone. Router resolution order: `$APEX_HOME/router/router.js`,
then `~/.claude/skills/apex/router/router.js`, then
`../router/router.js` relative to the hook file.

Opt-in local log: when `APEX_LOG=1`, append `{ts, verdict}` (no prompt text
unless `APEX_LOG=full`) to `~/.claude/apex/verdicts.jsonl` for later refits.

## System Two changes (SKILL.md v2)

- Step 0.5: read the S1 verdict when present; when absent, do the router's job
  by hand with the same question list.
- Three pools: creative, reliability, reasoning.
- Mode semantics as above. Overriding the router is allowed and expected when
  it is wrong; the `Technique:` line says so in a few words.
- Candidates are forced distinct by construction: C1 direct spec (smallest
  faithful rewrite), C2 technique-applied (the picked techniques), C3
  exemplar-skeleton (the top exemplar's structure applied to this ask) or an
  alternate decomposition when no exemplar fits.
- Scoring: Fidelity is a gate. A candidate with Fidelity <= 3 is out before
  totals are compared. Then highest total, ties on Fidelity, then Verifiability, then Scope.
- `Technique:` line carries the S1 receipt, e.g.
  `Technique: T7 structured output + T12 grounding (S1 FAST 0.71, agreed)` or
  `(S1 said T1; overridden, extraction task)`. Block stays eight lines.

## Checks that can fail (definition of done)

| # | Check | Pass |
|---|---|---|
| 1 | `node --test tests/` | all pass |
| 2 | `node router/eval.js` on holdout | tier acc >= 0.85, pool acc >= 0.90, technique top-2 recall >= 0.80, ECE (tier, pool) <= 0.10; task top-1 reported (target >= 0.65) |
| 3 | Same eval, FAST subset | accuracy >= 0.85 on holdout at the fitted `tau_fast`, coverage reported |
| 4 | Router latency | in-process p95 < 15 ms over 1000 calls; hook process p95 < 100 ms over 50 runs |
| 5 | Hook fuzz | 200 random/garbage payloads: exit 0 every time, stdout empty or valid JSON |
| 6 | Bypass | payload containing `/apex-skip` returns the bypass text and no verdict |
| 7 | Baseline beat | the fitted model beats (a) majority-class and (b) prior-only weights on holdout for every Choice head |
| 8 | Live | after install and wiring, one real prompt in a fresh `claude -p` shows the verdict in context |

If check 2 misses, report the real numbers and what limits them (label noise,
small n). Do not tune on the holdout. The holdout is used once for the report.
