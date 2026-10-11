---
description: Force a full-depth APEX pass on the request. Runs the APEX (Ask. Perfect. EXecute.) loop at Deep tier- shows the router --explain output first (labeled weak), then the full decision card table with probabilities and the gate result, then agreement or override notes vs the router hints per head, then the three candidates, scoring table, resample, final block, execute.
---

Run the `apex` skill at **Deep** tier on the request below,
regardless of how small it looks.

**Step 1: run the router and show learned hints (labeled weak).**

Execute:

```
node ~/.claude/skills/apex/router/router.js --explain "<the ask>"
```

Quote the ask safely (escape any inner quotes). Show the full `--explain`
output, which includes:

- The feature table (feature name, raw score, contribution per head).
- Per-head predictions with probabilities: tier, pool, task, techniques, flags.
- The `preserve` and `signals` lines the hook would inject.
- The top two exemplar paths with `use_when` fields.

Label the learned predictions explicitly: **these are weak hints** (router
holdout accuracy: tier 0.60, pool 0.65, task 0.54, technique top-2 recall 0.14).
The `preserve` and `signals` lines are deterministic and reliable.

**Step 2: run the full decision card.**

Answer each question from the ask alone, independently of the others. State
probabilities in 0.05 steps. Print the card as a table:

| Question | Answer | p |
|---|---|---|
| tier | micro / standard / deep | 0.XX |
| pool | creative / reliability / reasoning | 0.XX |
| task (top 3) | task_type_1, task_type_2, task_type_3 | 0.XX, 0.XX, 0.XX |
| persona_fit | yes/no | 0.XX |
| critique_loop | yes/no | 0.XX |
| iteration_readiness | yes/no | 0.XX |
| output_parseability | yes/no | 0.XX |
| injection_defense | yes/no | 0.XX |
| destructive | yes/no | 0.XX |
| ambiguous | yes/no | 0.XX |
| needs_fresh_facts | yes/no | 0.XX |
| T<k> <name> (shortlist, 3-6) | would improve / would not | 0.XX |

Then show the mechanical rules applied:

```
conf_tier = clamp((3 * p_max_tier - 1) / 2, 0, 1)  = X.XX
conf_pool = clamp((3 * p_max_pool - 1) / 2, 0, 1)  = X.XX
gate      = min(conf_tier, conf_pool)               = X.XX
mode      = FAST / CHECK / DELIBERATE
techniques selected: T<k> p=0.XX [+ T<k> p=0.XX]  or  none
flags triggered (p >= 0.50): <list>
```

**Step 2b: pull task-matched exemplars.**

```
node ~/.claude/skills/apex/router/router.js --exemplars "<ask>" --task <task from card> --techniques <your picks> -k 3
```

Show the top result (path + `use_when`). Note that the bank skews heavily to
plan_design (220 of 377 prompts); if the task is code_fix or quick_fact and no
exemplar was shown in the verdict, skip this step and use C3 as alternate
decomposition.

**Step 3: agreement or override vs the router hints.**

For each head where the router emitted a hint, state one line:

- Tier: agreed / overridden to X because Y.
- Pool: agreed / overridden to X because Y.
- Task: agreed / overridden to X because Y.
- Techniques: agreed / swapped to X because Y.

If the router could not run or emitted no hints, say so.

**Step 4: show all the work the standard tier hides.**

- The routing decision: pool and task, and why.
- The technique(s) selected, with the trigger that fired. Consult
  `references/techniques.md` for anti-trigger conditions.
- All three candidates, written out in full:
  - C1: direct spec (smallest faithful rewrite, no technique beyond clarity).
  - C2: technique-applied (write out the output contract, grounding source,
    persona, or reasoning scaffold explicitly).
  - C3: exemplar-skeleton (apply the top exemplar's structure to this ask)
    or alternate decomposition if no exemplar fits.
- The scoring table: core five (Fidelity, Specificity, Verifiability, Scope,
  Context) plus every triggered conditional (Persona Fit, Critique Loop,
  Iteration Readiness, Output Parseability, Injection Defense), 1 to 5 each,
  totalled as n/max. Mark untriggered dimensions n/a. Any candidate with
  Fidelity <= 3 is marked disqualified before totals are shown.
- The resample round: which fragment came from C1, C2, and C3 into the winner.
- The final `⚡ APEX · Ask. Perfect. EXecute.` block (fourteen-line Deep cap), with the decision card
  receipt on the Technique line.

Then execute. Do not ask for approval of the optimized prompt.

The rest of the request follows.
