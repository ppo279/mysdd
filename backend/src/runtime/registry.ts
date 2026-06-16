import type { RuntimeAdapter } from './adapter.js'
import { ClaudeAdapter } from './claude.js'

const adapters: Record<string, RuntimeAdapter> = {
  claude: new ClaudeAdapter(),
}

export function getRuntime(id: string): RuntimeAdapter {
  const adapter = adapters[id]
  if (!adapter) throw new Error(`Runtime "${id}" not found`)
  return adapter
}

export function registerRuntime(id: string, adapter: RuntimeAdapter) {
  adapters[id] = adapter
}
