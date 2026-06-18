import type { RuntimeAdapter } from './adapter.js'
import { ClaudeAdapter } from './claude.js'
import { CodefreeAdapter } from './codefree.js'
import { loadAgentsConfig } from '../config/agents.js'
import { BizError, Code } from '../lib/envelope.js'

function buildAdapters(): Record<string, RuntimeAdapter> {
  const cfg = loadAgentsConfig()
  const result: Record<string, RuntimeAdapter> = {}
  for (const rt of cfg.runtimes) {
    if (rt.type === 'claude-cli') {
      result[rt.id] = new ClaudeAdapter(rt.command ?? 'claude')
    } else if (rt.type === 'codefree-cli') {
      result[rt.id] = new CodefreeAdapter(rt.command ?? 'codefree')
    }
  }
  // 保底
  if (!result['claude']) result['claude'] = new ClaudeAdapter('claude')
  return result
}

let _adapters: Record<string, RuntimeAdapter> | null = null

function getAdapters(): Record<string, RuntimeAdapter> {
  if (!_adapters) _adapters = buildAdapters()
  return _adapters
}

export function clearRuntimeCache() {
  _adapters = null
}

export function getRuntime(id: string): RuntimeAdapter {
  const adapter = getAdapters()[id]
  if (!adapter) {
    throw new BizError(
      Code.RUNTIME_NOT_REGISTERED,
      `Runtime "${id}" not found. 请在配置页面添加对应运行时。`,
      400,
    )
  }
  return adapter
}

export function registerRuntime(id: string, adapter: RuntimeAdapter) {
  getAdapters()[id] = adapter
}
