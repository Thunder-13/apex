import type { EngineInterface, Register } from 'claude-code'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function stateFilePath($: EngineInterface): Promise<string> {
  const cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? ((await $.env.get('HOME')) ?? '~') + '/.claude'
  return `${cfg}/apex/state.json`
}

async function readEnabled($: EngineInterface): Promise<boolean> {
  try {
    const p = await stateFilePath($)
    const result = await $.fs.read(p)
    const text = typeof result === 'string' ? result : (result as { text?: string }).text ?? ''
    const parsed = JSON.parse(text) as { enabled?: unknown }
    return typeof parsed.enabled === 'boolean' ? parsed.enabled : true
  } catch {
    return true
  }
}

function applyStatus($: EngineInterface, enabled: boolean): void {
  $.ui.status(enabled ? '⚡ APEX · Ask. Perfect. EXecute.' : undefined)
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const register: Register = (on) => {
  // session.start: set status indicator based on state file
  on('session.start', async ($, e, next) => {
    try {
      const enabled = await readEnabled($)
      applyStatus($, enabled)
    } catch {
      // never block the session
    }
    return next(e)
  })

  // prompt.submit: re-read state file to catch hand edits / other sessions
  on('prompt.submit', async ($, e, next) => {
    try {
      const enabled = await readEnabled($)
      applyStatus($, enabled)
    } catch {
      // keep last known state
    }
    return next(e)
  })
}
