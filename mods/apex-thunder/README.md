# apex-thunder mod

Optional Claude Code hook module that shows the ⚡ APEX status indicator
in the status line when APEX (Ask. Perfect. EXecute.) is on.

This is a simplified, status-only version of the dev-mods copy. It has no
Pane, no Button, and no commands. It reads `state.json` on `session.start`
and `prompt.submit` and calls `$.ui.status` accordingly.

## Behavior

- When `~/.claude/apex/state.json` has `"enabled": true` (or is absent): status
  shows `⚡ APEX · Ask. Perfect. EXecute.`
- When `"enabled": false`: status is cleared (`$.ui.status(undefined)`)

The config dir follows `CLAUDE_CONFIG_DIR` when set, falling back to
`$HOME/.claude`.

## Limitations

Hook modules are blocked on accounts where `allowManagedHooksOnly: true` is set
in the organization's managed settings. On those accounts the statusline wrapper
(`hooks/apex-statusline.sh`) provides the ⚡ indicator instead.

On accounts with `allowManagedHooksOnly`, `claude plugin test` refuses to run as well.
Type-check with a local `tsconfig.json` that includes `hooks/register.tsx` and
`types/index.d.ts`:

```
tsc --project tsconfig.json
```

Validate with:

```
claude plugin validate mods/apex-thunder   # from the repository root
```
