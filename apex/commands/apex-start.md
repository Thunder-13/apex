---
description: Turn APEX (Ask. Perfect. EXecute.) on. Updates the state file and STATUS.md so the ⚡ indicator is shown and the APEX loop runs.
allowed-tools: Bash(node:*)
---

<!-- apex:apex-start -->

!`node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/apex}/router/apex-state.js" start`

Reply with exactly the one line below and nothing else:

⚡ APEX on · Ask. Perfect. EXecute.

From the next prompt on, run the APEX loop from CLAUDE.md on every user request.
