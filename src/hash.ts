import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { HASH_HEX_LEN, HASH_MAX_BYTES } from './constants.ts'
import { rethrowIo } from './errors.ts'

export function shortHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, HASH_HEX_LEN)
}

export async function hashFile(filePath: string, maxBytes = HASH_MAX_BYTES): Promise<{
  size: number
  hash: string | null
  hash_skipped?: 'too_large'
}> {
  const handle = await open(filePath, 'r').catch(rethrowIo)
  try {
    const info = await handle.stat()
    if (info.size > maxBytes) return { size: info.size, hash: null, hash_skipped: 'too_large' }
    const hash = createHash('sha256')
    const buf = Buffer.alloc(256 * 1024)
    let pos = 0
    while (pos < info.size) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
      if (bytesRead <= 0) break
      hash.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    return { size: info.size, hash: hash.digest('hex').slice(0, HASH_HEX_LEN) }
  } finally {
    await handle.close()
  }
}
