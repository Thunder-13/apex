/**
 * State contract for the apex-thunder plugin.
 *
 * $.state keys this plugin owns:
 *   enabled  — whether APEX (Ask. Perfect. EXecute.) is on
 *   stateAt  — ISO timestamp of the last toggle, kept for display
 */
export type ApexThunderState = {
  enabled: boolean
  stateAt: string
}

declare module 'claude-code' {
  interface PluginState {
    'apex-thunder': { enabled: boolean; stateAt: string }
  }
}
