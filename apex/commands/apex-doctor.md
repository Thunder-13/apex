---
description: Run the APEX (Ask. Perfect. EXecute.) environment doctor. Reports config dir, version, state, hooks, commands, status line, organization policy, and external tools. Ends with a verdict on whether hooks are allowed.
allowed-tools: Bash(node:*)
---

<!-- apex:apex-doctor -->

!`node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/apex}/router/apex-doctor.js"`

Show the output of the command above verbatim, with no edits or summary.
