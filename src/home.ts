import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LOG_KEEP_MS } from './constants.ts'

export interface Layout {
  root: string
  active: string
  finished: string
  tmp: string
}

export function homeDir(): string {
  if (process.env.FINCH_SHELL_HOME) return path.resolve(process.env.FINCH_SHELL_HOME)
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'finch-shell-mcp')
  }
  return path.join(os.homedir(), '.finch-shell-mcp')
}

export async function ensureLayout(): Promise<Layout> {
  const root = homeDir()
  const layout: Layout = {
    root,
    active: path.join(root, 'jobs', 'active'),
    finished: path.join(root, 'jobs', 'finished'),
    tmp: path.join(root, 'tmp'),
  }
  await mkdir(layout.active, { recursive: true })
  await mkdir(layout.finished, { recursive: true })
  await mkdir(layout.tmp, { recursive: true })
  return layout
}

export interface ActiveLog {
  jobId: string
  ownerPid: number
  logPath: string
  startedAt: string | null
}

const ACTIVE_NAME = /^(j_[0-9a-f]+)\.(\d+)\.log$/i

export async function listActiveLogs(activeDir: string): Promise<ActiveLog[]> {
  let names: string[] = []
  try {
    names = await readdir(activeDir)
  } catch {
    return []
  }
  const out: ActiveLog[] = []
  for (const name of names) {
    const match = ACTIVE_NAME.exec(name)
    if (!match) continue
    const logPath = path.join(activeDir, name)
    let startedAt: string | null = null
    try {
      const info = await stat(logPath)
      startedAt = info.birthtime?.toISOString?.() ?? info.mtime.toISOString()
    } catch {
      startedAt = null
    }
    out.push({
      jobId: match[1]!.toLowerCase(),
      ownerPid: Number(match[2]),
      logPath,
      startedAt,
    })
  }
  return out
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

export async function sweepOldLogs(finishedDir: string, tmpDir: string): Promise<void> {
  const cutoff = Date.now() - LOG_KEEP_MS
  await sweepDir(finishedDir, cutoff)
  await sweepDir(tmpDir, Date.now() - 24 * 60 * 60 * 1000)
}

async function sweepDir(dir: string, cutoff: number): Promise<void> {
  let names: string[] = []
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const info = await stat(full)
      if (info.mtimeMs < cutoff) await rm(full, { force: true })
    } catch {
      // A failed sweep does not stop the server.
    }
  }
}
