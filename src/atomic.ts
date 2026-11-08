import { open, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { raise, rethrowIo, ToolError } from './errors.ts'
import { pathKey } from './pathutil.ts'

const chains = new Map<string, Promise<unknown>>()

export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = pathKey(filePath)
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function atomicWrite(dest: string, data: Buffer, guard?: () => Promise<void>): Promise<void> {
  const dir = path.dirname(dest)
  const tmp = path.join(dir, `.finch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
  const handle = await open(tmp, 'w').catch(rethrowIo)
  try {
    await handle.write(data)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(tmp).catch(() => undefined)
    rethrowIo(error)
  }
  await handle.close()
  try {
    if (guard) await guard()
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, dest)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
        await delay(10 + attempt * 15)
        continue
      }
      break
    }
  }
  await unlink(tmp).catch(() => undefined)
  if (last instanceof ToolError) throw last
  const code = (last as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    raise('E_ACCESS', 'The file is busy, so the replace failed. The previous bytes are still on disk.')
  }
  rethrowIo(last)
}

export async function captureStamp(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(filePath)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    rethrowIo(error)
  }
}
