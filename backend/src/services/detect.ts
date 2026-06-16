import { execSync, execFileSync } from 'child_process'
import net from 'net'

export interface DetectedRuntime {
  id: string
  type: string
  command: string
  version: string | null
  available: boolean
  daemonPort?: number      // daemon 型工具监听的端口（如 Ollama 的 11434）
  daemonRunning?: boolean  // daemon 是否当前在跑
  source: 'cli' | 'daemon'
}

// 所有候选运行时定义
const CANDIDATES: Array<{
  id: string
  type: string
  command: string
  versionFlag: string
  source: 'cli' | 'daemon'
  daemonPort?: number
}> = [
  { id: 'claude', type: 'claude-cli',   command: 'claude',  versionFlag: '--version', source: 'cli' },
  { id: 'codex',  type: 'openai-cli',   command: 'codex',   versionFlag: '--version', source: 'cli' },
  { id: 'gemini', type: 'gemini-cli',   command: 'gemini',  versionFlag: '--version', source: 'cli' },
  { id: 'aider',  type: 'aider-cli',    command: 'aider',   versionFlag: '--version', source: 'cli' },
  { id: 'ollama', type: 'ollama',       command: 'ollama',  versionFlag: '--version', source: 'daemon', daemonPort: 11434 },
  { id: 'lmstudio', type: 'lmstudio',   command: 'lms',     versionFlag: '--version', source: 'daemon', daemonPort: 1234  },
]

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    try {
      // Windows fallback（WSL 下也可能需要）
      execSync(`where ${cmd}`, { stdio: 'ignore', timeout: 2000 })
      return true
    } catch {
      return false
    }
  }
}

function getVersion(command: string, flag: string): string | null {
  try {
    const out = execFileSync(command, [flag], { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    // 取第一行，截断超长内容
    return out.trim().split('\n')[0].slice(0, 80) || null
  } catch {
    return null
  }
}

function checkPort(port: number, timeout = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (result: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, '127.0.0.1')
  })
}

export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  const results: DetectedRuntime[] = []

  for (const candidate of CANDIDATES) {
    const exists = commandExists(candidate.command)

    if (candidate.source === 'cli') {
      const version = exists ? getVersion(candidate.command, candidate.versionFlag) : null
      results.push({
        id: candidate.id,
        type: candidate.type,
        command: candidate.command,
        version,
        available: exists,
        source: 'cli',
      })
    } else {
      // daemon 型：检查 CLI 存在 + 端口是否可达
      const version = exists ? getVersion(candidate.command, candidate.versionFlag) : null
      const daemonRunning = candidate.daemonPort ? await checkPort(candidate.daemonPort) : false
      results.push({
        id: candidate.id,
        type: candidate.type,
        command: candidate.command,
        version,
        available: exists || daemonRunning,
        daemonPort: candidate.daemonPort,
        daemonRunning,
        source: 'daemon',
      })
    }
  }

  return results
}
