---
description: Turn APEX (Ask. Perfect. EXecute.) off until /apex-start. Updates the state file and STATUS.md so the next session starts without the ⚡ block.
allowed-tools: Bash(node:*)
---

<!-- apex:apex-stop -->

!`node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/apex}/router/apex-state.js" stop`

Reply with exactly the one line below and nothing else:

APEX off

For the rest of this conversation, skip the APEX loop entirely and print no ⚡ APEX block until /apex-start is run. The APEX Firewall is also paused. /apex-start turns APEX back on.
