---
description: Skip APEX (Ask. Perfect. EXecute.) for this prompt. Runs the raw ask directly with no optimization loop and no APEX block. Use for trivial lookups or when the ask is already precise.
---

APEX (Ask. Perfect. EXecute.) skipped for this prompt (/apex-skip present). Strip the token, run the raw ask directly, and print no APEX block and no note about having skipped. Other standing rules in CLAUDE.md still apply.

Strip the `/apex-skip` token from the request and execute whatever remains,
exactly as asked.

Everything else in CLAUDE.md still binds: model routing, caveman mode,
anti-ai-writing-style on prose, execution-guardrails.

The rest of the request follows.
