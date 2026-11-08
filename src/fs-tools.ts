import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { asArgs, optBool, optInt, optString, rejectUnknown, type Args } from './args.ts'
import { atomicWrite, captureStamp, withFileLock } from './atomic.ts'
import {
  EDIT_MAX_BYTES,
  HASH_MAX_BYTES,
  READ_MAX_BYTES,
  STAT_ENCODING_MAX,
  WRITE_MAX_BYTES,
} from './constants.ts'
import {
  applyEol,
  charsetSupportsBom,
  decodeBuffer,
  edgesAligned,
  decideBom,
  detectBuffer,
  detectEol,
  encodeBody,
  isBinaryBuffer,
  requireCharset,
  stripBom,
  withBom,
  type Charset,
  type Eol,
} from './encoding.ts'
import { raise, rethrowIo, ToolError } from './errors.ts'
import { hashFile, shortHash } from './hash.ts'
import { normalizeUserPath, pathKey, toNative } from './pathutil.ts'

const STAT_FIELDS = ['paths', 'hash']
const READ_FIELDS = ['path', 'offset', 'length', 'mode', 'encoding', 'include_bom', 'max_bytes']
const WRITE_FIELDS = ['path', 'text', 'hex', 'encoding', 'expect_hash', 'preserve', 'create_dirs', 'force']
const PATCH_FIELDS = ['path', 'expect_hash', 'encoding', 'bom', 'edits']
const SPLICE_FIELDS = ['path', 'offset', 'delete_bytes', 'insert', 'insert_hex', 'encoding', 'expect_hash', 'force', 'create_dirs']

interface Located {
  requested: string
  dest: string
  resolved: string
  exists: boolean
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: Date | null
  ctime: Date | null
  readonly: boolean
}

async function locate(input: unknown, follow: boolean): Promise<Located> {
  const requested = normalizeUserPath(input)
  let info: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    info = await lstat(requested)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') rethrowIo(error)
  }
  let dest = requested
  let resolved = requested
  if (info?.isSymbolicLink() && follow) {
    try {
      resolved = toNative(await realpath(requested))
      dest = resolved
      info = await stat(dest)
    } catch (error) {
      rethrowIo(error)
    }
  } else if (info && follow && !info.isSymbolicLink()) {
    try {
      resolved = toNative(await realpath(requested))
    } catch {
      resolved = requested
    }
  }
  return {
    requested,
    dest,
    resolved,
    exists: Boolean(info),
    isDir: Boolean(info?.isDirectory()),
    isSymlink: Boolean(info?.isSymbolicLink()) && !follow,
    size: info?.size ?? 0,
    mtime: info?.mtime ?? null,
    ctime: info?.ctime ?? null,
    readonly: info ? (info.mode & 0o200) === 0 : false,
  }
}

function parseHex(input: unknown, field: string): Buffer {
  if (typeof input !== 'string') raise('E_INVALID_ARG', `${field} must be a hexadecimal string.`)
  const compact = input.replace(/\s+/g, '').toLowerCase()
  if (compact.length % 2 !== 0) raise('E_INVALID_ARG', `${field} must have an even length.`)
  if (!/^[0-9a-f]*$/.test(compact)) raise('E_INVALID_ARG', `${field} contains a non-hexadecimal character.`)
  return Buffer.from(compact, 'hex')
}

function parseExpect(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') raise('E_INVALID_ARG', 'expect_hash must be a string.')
  const text = value.trim().toLowerCase()
  if (text === 'absent') return 'absent'
  if (!/^[0-9a-f]{6}$/.test(text)) {
    raise('E_INVALID_ARG', 'expect_hash must be 6 hex digits, or absent.')
  }
  return text
}

async function ensureParent(filePath: string, create: boolean): Promise<string[]> {
  const dir = path.dirname(filePath)
  const root = path.parse(dir).root
  const rest = dir.slice(root.length).split(path.sep).filter(Boolean)
  const created: string[] = []
  let current = root
  for (const segment of rest) {
    current = path.join(current, segment)
    let exists = false
    try {
      const info = await stat(current)
      if (!info.isDirectory()) raise('E_PATH', 'A path segment is not a directory.')
      exists = true
    } catch (error) {
      if (error instanceof ToolError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') rethrowIo(error)
    }
    if (exists) continue
    if (!create) raise('E_NOT_FOUND', 'Parent directory does not exist.', 'Pass create_dirs: true, or create the directory first.')
    await mkdir(current).catch(rethrowIo)
    created.push(current)
  }
  return created
}

async function verifyWritten(filePath: string, data: Buffer): Promise<string> {
  let actual: { size: number; hash: string | null }
  try {
    actual = await hashFile(filePath, Number.MAX_SAFE_INTEGER)
  } catch (error) {
    raise('E_VERIFY_FAILED', 'The file could not be read back after writing.', 'Stop writing and check the disk.', {
      message: error instanceof Error ? error.message : 'read failed',
    })
  }
  const expected = shortHash(data)
  if (actual.size !== data.length || actual.hash !== expected) {
    raise('E_VERIFY_FAILED', 'The bytes read back do not match the bytes that were written.', 'Stop writing and check the disk.', {
      expect: expected,
      actual: actual.hash,
      size: actual.size,
    })
  }
  return expected
}

export async function fsStat(raw: unknown): Promise<{ entries: Record<string, unknown>[] }> {
  const args = asArgs(raw)
  rejectUnknown(args, STAT_FIELDS)
  const paths = args.paths
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 200) {
    raise('E_INVALID_ARG', 'paths needs between 1 and 200 paths.')
  }
  const wantHash = optBool(args, 'hash', true)
  const entries: Record<string, unknown>[] = []
  for (const item of paths) {
    try {
      const loc = await locate(item, false)
      if (!loc.exists) {
        entries.push({ path: loc.requested, exists: false })
        continue
      }
      const entry: Record<string, unknown> = {
        path: loc.requested,
        exists: true,
        type: loc.isSymlink ? 'symlink' : loc.isDir ? 'dir' : 'file',
        size: loc.size,
        mtime: loc.mtime?.toISOString() ?? null,
        ctime: loc.ctime?.toISOString() ?? null,
        readonly: loc.readonly,
      }
      if (loc.isDir || loc.isSymlink) {
        entry.hash = null
        entry.encoding = null
        entry.is_binary = false
      } else if (!wantHash) {
        entry.hash = null
      } else {
        const hashed = await hashFile(loc.dest)
        entry.hash = hashed.hash
        if (hashed.hash_skipped) entry.hash_skipped = hashed.hash_skipped
      }
      if (!loc.isDir && !loc.isSymlink) {
        const head = await readSlice(loc.dest, 0, Math.min(loc.size, 8192))
        const binary = isBinaryBuffer(head)
        entry.is_binary = binary
        if (!binary && loc.size <= STAT_ENCODING_MAX) {
          const sample = loc.size <= 8192 ? head : await readSlice(loc.dest, 0, Math.min(loc.size, STAT_ENCODING_MAX))
          const detected = detectBuffer(sample)
          const decoded = decodeBuffer(sample, detected.charset)
          entry.encoding = {
            charset: detected.charset,
            bom: detected.bom,
            eol: detectEol(decoded.text),
            confidence: detected.confidence,
          }
        } else {
          entry.encoding = null
        }
      }
      entries.push(entry)
    } catch (error) {
      if (error instanceof ToolError && (error.body.error.code === 'E_INVALID_ARG' || error.body.error.code === 'E_PATH')) {
        throw error
      }
      const code = error instanceof ToolError ? error.body.error.code : 'E_IO'
      let shown = ''
      try {
        shown = typeof item === 'string' ? normalizeUserPath(item) : String(item)
      } catch {
        shown = String(item)
      }
      entries.push({ path: shown, exists: false, error_code: code })
    }
  }
  return { entries }
}

async function readSlice(filePath: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0)
  const handle = await open(filePath, 'r').catch(rethrowIo)
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function fsRead(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, READ_FIELDS)
  const loc = await locate(args.path, true)
  if (!loc.exists) raise('E_NOT_FOUND', 'Path does not exist.')
  if (loc.isDir) raise('E_IS_DIR', 'Target is a directory.')
  const maxBytes = optInt(args, 'max_bytes', READ_MAX_BYTES, 1, READ_MAX_BYTES) ?? READ_MAX_BYTES
  const length = optInt(args, 'length', null, 0, READ_MAX_BYTES)
  let offset = optInt(args, 'offset', 0) ?? 0
  if (offset < 0) offset = loc.size + offset
  if (offset < 0 || offset > loc.size) {
    raise('E_RANGE', 'The read offset is outside the file.', undefined, { total_size: loc.size })
  }
  const modeRaw = optString(args, 'mode') ?? 'auto'
  if (modeRaw !== 'text' && modeRaw !== 'hex' && modeRaw !== 'auto') {
    raise('E_INVALID_ARG', 'mode must be text, hex, or auto.')
  }
  const want = length === null ? maxBytes : Math.min(length, maxBytes)
  const slice = await readSlice(loc.dest, offset, Math.min(want, loc.size - offset))
  const head = offset === 0 ? slice.subarray(0, 8192) : await readSlice(loc.dest, 0, Math.min(8192, loc.size))
  const binary = isBinaryBuffer(head.length ? head : slice)
  let mode: 'text' | 'hex' = modeRaw === 'auto' ? (binary ? 'hex' : 'text') : modeRaw
  if (mode === 'text' && binary) raise('E_NOT_TEXT', 'This is binary. Text mode cannot return reliable characters.', 'Use mode: "hex", or fs_splice.')
  const hashed = loc.size <= HASH_MAX_BYTES ? await hashFile(loc.dest) : { hash: null as string | null }
  const base: Record<string, unknown> = {
    path: loc.requested,
    mode,
    offset,
    bytes_read: slice.length,
    total_size: loc.size,
    eof: offset + slice.length >= loc.size,
    remaining: Math.max(0, loc.size - offset - slice.length),
  }
  if (loc.resolved !== loc.requested) base.resolved_path = loc.resolved
  if (hashed.hash) base.hash = hashed.hash
  if (mode === 'hex') {
    base.hex = slice.toString('hex')
    return base
  }
  const encodingArg = optString(args, 'encoding') ?? 'auto'
  const includeBom = optBool(args, 'include_bom', false)
  let charset: Charset
  let source: 'bom' | 'detected' | 'explicit'
  let confidence: string
  let lossy = false
  if (encodingArg !== 'auto') {
    charset = requireCharset(encodingArg)
    source = 'explicit'
    const decoded = decodeBuffer(slice, charset)
    lossy = decoded.lossy
    confidence = lossy ? 'fallback' : 'valid-utf8'
    return finishText(base, decoded.text, charset, source, confidence, lossy, includeBom, slice, offset)
  }
  const detected = detectBuffer(slice.length ? slice : head)
  charset = detected.charset
  source = detected.confidence === 'bom' ? 'bom' : 'detected'
  confidence = detected.confidence
  const decoded = decodeBuffer(slice, charset)
  lossy = decoded.lossy || detected.lossy
  return finishText(base, decoded.text, charset, source, confidence, lossy, includeBom, slice, offset)
}

function finishText(
  base: Record<string, unknown>,
  text: string,
  charset: Charset,
  source: string,
  confidence: string,
  lossy: boolean,
  includeBom: boolean,
  slice: Buffer,
  offset: number,
): Record<string, unknown> {
  const hadBom = offset === 0 && stripBom(slice).charset !== null
  let shown = text.startsWith('\uFEFF') ? text.slice(1) : text
  if (includeBom && hadBom) shown = `\uFEFF${shown}`
  const fileBom = hadBom || text.startsWith('\uFEFF')
  base.text = shown
  base.encoding_used = charset === 'utf-8-bom' ? 'utf-8' : charset
  base.encoding_source = source
  base.encoding_confidence = confidence
  base.lossy = lossy
  base.bom = Boolean(stripBom(offset === 0 ? slice : Buffer.alloc(0)).charset) || (offset === 0 && fileBom)
  base.eol = detectEol(text)
  base.offset_aligned = edgesAligned(slice, charset)
  return base
}

function preserveOf(args: Args): { bom: string; eol: string } {
  if (!('preserve' in args) || args.preserve === undefined) return { bom: 'keep', eol: 'as_is' }
  const value = args.preserve
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    raise('E_INVALID_ARG', 'preserve must be an object.')
  }
  const record = value as Args
  for (const key of Object.keys(record)) {
    if (key !== 'bom' && key !== 'eol') raise('E_INVALID_ARG', `Unknown preserve field ${key}.`)
  }
  const bom = record.bom === undefined ? 'keep' : record.bom
  const eol = record.eol === undefined ? 'as_is' : record.eol
  if (typeof bom !== 'string' || !['keep', 'add', 'strip', 'as_is'].includes(bom)) {
    raise('E_INVALID_ARG', 'preserve.bom must be keep, add, strip, or as_is.')
  }
  if (typeof eol !== 'string' || !['keep', 'crlf', 'lf', 'as_is'].includes(eol)) {
    raise('E_INVALID_ARG', 'preserve.eol must be keep, crlf, lf, or as_is.')
  }
  return { bom, eol }
}

export async function fsWrite(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, WRITE_FIELDS)
  const hasText = 'text' in args && args.text !== undefined
  const hasHex = 'hex' in args && args.hex !== undefined
  if (hasText === hasHex) raise('E_INVALID_ARG', 'Provide exactly one of text or hex.')
  const loc = await locate(args.path, true)
  if (loc.isDir) raise('E_IS_DIR', 'Target is a directory.')
  const createDirs = optBool(args, 'create_dirs', true)
  const force = optBool(args, 'force', false)
  const expect = parseExpect(args.expect_hash)
  return withFileLock(loc.dest, async () => {
    const current = await locate(args.path, true)
    if (current.isDir) raise('E_IS_DIR', 'Target is a directory.')
    let previous: Buffer | null = null
    if (current.exists) previous = await readFile(current.dest).catch(rethrowIo)
    const hashBefore = previous ? shortHash(previous) : null
    if (expect === 'absent' && current.exists) {
      raise('E_EXISTS', 'expect_hash requires the file to be absent, but it already exists.', 'Read it again before deciding to overwrite.', {
        hash: hashBefore,
        size: previous?.length ?? 0,
      })
    }
    if (hasHex && current.exists && expect === null && !force) {
      raise('E_HASH_REQUIRED', 'Editing an existing binary file requires expect_hash.', 'Retry with the returned hash, or pass force: true.', {
        path: current.requested,
        exists: true,
        hash: hashBefore,
        size: previous?.length ?? 0,
      })
    }
    if (expect && expect !== 'absent') {
      if (!current.exists) {
        raise('E_HASH_MISMATCH', 'The file is gone, so it does not match the hash you sent. Nothing was written.', 'Check the path.', {
          expect,
          actual: null,
        })
      }
      if (hashBefore !== expect) {
        raise('E_HASH_MISMATCH', 'The file changed after you read it. The write was cancelled and not a byte on disk was touched.', 'Read the file again with fs_read, then retry.', {
          expect,
          actual: hashBefore,
        })
      }
    }
    let data: Buffer
    let encoding: string | null = null
    if (hasHex) {
      data = parseHex(args.hex, 'hex')
    } else {
      if (typeof args.text !== 'string') raise('E_INVALID_ARG', 'text must be a string.')
      const charset = requireCharset(optString(args, 'encoding') ?? 'utf-8')
      encoding = charset === 'utf-8-bom' ? 'utf-8' : charset
      const preserve = preserveOf(args)
      const oldDetected = previous ? detectBuffer(previous) : null
      const oldText = previous ? decodeBuffer(previous, oldDetected?.charset ?? 'utf-8').text : ''
      const oldEol = previous ? detectEol(oldText) : 'none'
      const hadBom = previous ? stripBom(previous).charset !== null : false
      const shaped = applyEol(args.text, preserve.eol, oldEol as Eol)
      const writeBom = decideBom(preserve.bom, Boolean(previous), hadBom, shaped, charset)
      if (writeBom && !charsetSupportsBom(charset) && charset !== 'utf-8-bom') {
        raise('E_INVALID_ARG', `${charset} cannot write a BOM.`)
      }
      data = withBom(encodeBody(shaped, charset), charset, writeBom)
    }
    if (data.length > WRITE_MAX_BYTES) raise('E_TOO_LARGE', 'A single write exceeds 32 MB.', 'Split the write, or use a script.')
    const dirs = await ensureParent(current.dest, createDirs)
    const stamp = expect && expect !== 'absent' ? await captureStamp(current.dest) : null
    const absent = expect === 'absent' || (!current.exists && expect === null && hasHex)
    await atomicWrite(current.dest, data, async () => {
      if (stamp) {
        const now = await captureStamp(current.dest)
        if (!now || now.size !== stamp.size || now.mtimeMs !== stamp.mtimeMs) {
          const actual = now ? (await hashFile(current.dest)).hash : null
          raise('E_HASH_MISMATCH', 'The file changed after the check. The write was cancelled.', 'Read the hash again with fs_read, then retry.', {
            expect,
            actual,
          })
        }
      } else if (absent) {
        const now = await captureStamp(current.dest)
        if (now && !current.exists) {
          raise('E_EXISTS', 'The file appeared before the write. It was not overwritten.')
        }
      }
    })
    const hashAfter = await verifyWritten(current.dest, data)
    const detected = detectBuffer(data.subarray(0, Math.min(data.length, STAT_ENCODING_MAX)))
    const decoded = decodeBuffer(data.subarray(0, Math.min(data.length, STAT_ENCODING_MAX)), detected.charset)
    const result: Record<string, unknown> = {
      path: current.requested,
      created: !current.exists,
      bytes_written: data.length,
      hash_before: hashBefore,
      hash_after: hashAfter,
      verified: true,
      encoding,
      bom: stripBom(data).charset !== null,
      eol: hasText ? detectEol(decoded.text) : detectEol(decoded.text),
      dirs_created: dirs,
    }
    if (force) result.forced = true
    if (current.resolved !== current.requested) result.resolved_path = current.resolved
    return result
  })
}

export async function fsPatch(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, PATCH_FIELDS)
  const loc = await locate(args.path, true)
  if (!loc.exists) raise('E_NOT_FOUND', 'Path does not exist.')
  if (loc.isDir) raise('E_IS_DIR', 'Target is a directory.')
  if (loc.size > EDIT_MAX_BYTES) raise('E_TOO_LARGE', 'The file is over 8 MB and cannot be patched.', 'Use a script.')
  const edits = args.edits
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 50) {
    raise('E_INVALID_ARG', 'edits needs between 1 and 50 edits.')
  }
  const expect = parseExpect(args.expect_hash)
  const encodingArg = optString(args, 'encoding') ?? 'auto'
  if ('bom' in args && args.bom !== undefined && args.bom !== null && typeof args.bom !== 'string') {
    raise('E_INVALID_ARG', 'bom must be a string: keep, add, strip, or as_is.')
  }
  const bomPolicy = optString(args, 'bom') ?? 'keep'
  if (!['keep', 'add', 'strip', 'as_is'].includes(bomPolicy)) {
    raise('E_INVALID_ARG', 'bom must be keep, add, strip, or as_is.')
  }
  return withFileLock(pathKey(loc.dest), async () => {
    const original = await readFile(loc.dest).catch(rethrowIo)
    if (isBinaryBuffer(original.subarray(0, 8192))) {
      raise('E_NOT_TEXT', 'A binary file cannot be patched.', 'Use fs_splice.')
    }
    const hashBefore = shortHash(original)
    if (expect === 'absent') raise('E_EXISTS', 'The file already exists.')
    if (expect && hashBefore !== expect) {
      raise('E_HASH_MISMATCH', 'The file changed after you read it. The edit was cancelled and not a byte on disk was touched.', 'Read the content and hash again with fs_read.', {
        expect,
        actual: hashBefore,
      })
    }
    const detected = detectBuffer(original)
    if (encodingArg === 'auto' && detected.confidence === 'fallback') {
      raise('E_ENCODING_UNSURE', 'The file encoding could not be determined, so it will not be guessed.', 'Pass encoding explicitly.')
    }
    const charset = encodingArg === 'auto' ? detected.charset : requireCharset(encodingArg)
    const decoded = decodeBuffer(original, charset)
    const reencoded = withBom(encodeBody(decoded.text, charset), charset, stripBom(original).charset !== null)
    if (!reencoded.equals(original)) {
      let offset = 0
      const limit = Math.min(reencoded.length, original.length)
      while (offset < limit && reencoded[offset] === original[offset]) offset++
      raise('E_ENCODING_ROUNDTRIP', 'Rewriting with this encoding would change bytes that were already in the file.', 'Use a different encoding.', { offset })
    }
    const source = encodingArg === 'auto' ? (detected.confidence === 'bom' ? 'bom' : 'detected') : 'explicit'
    const text = decoded.text.replace(/^\uFEFF/, '')
    const ranges: { index: number; start: number; end: number; next: string; count: number }[] = []
    for (let index = 0; index < edits.length; index++) {
      const edit = edits[index]
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) raise('E_INVALID_ARG', `edits[${index}] must be an object.`)
      const record = edit as Args
      const oldText = record.old_text
      const newText = record.new_text
      if (typeof oldText !== 'string' || oldText.length === 0) {
        raise('E_INVALID_ARG', `edits[${index}].old_text must be a non-empty string.`)
      }
      if (typeof newText !== 'string') raise('E_INVALID_ARG', `edits[${index}].new_text must be a string.`)
      const count = record.count === undefined ? 1 : record.count
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        raise('E_INVALID_ARG', `edits[${index}].count must be a positive integer.`)
      }
      const found: number[] = []
      let from = 0
      while (from <= text.length) {
        const at = text.indexOf(oldText, from)
        if (at < 0) break
        found.push(at)
        from = at + oldText.length
      }
      if (found.length === 0) {
        raise('E_NO_MATCH', 'old_text was not found in the file.', 'Read the file again and match the text that is actually there.', { index })
      }
      if (found.length !== count) {
        const samples = found.slice(0, 20).map((at) => ({
          byte_offset: encodeBody(text.slice(0, at), charset).length,
          line: lineOf(text, at),
          snippet: snippet(text, at, oldText.length),
        }))
        const code = found.length > count ? 'E_AMBIGUOUS' : 'E_NO_MATCH'
        const message = found.length > count ? 'old_text matched more times than count.' : 'old_text matched fewer times than count.'
        raise(code, message, 'Make old_text longer so it matches only the intended place.', {
          index,
          count,
          found: found.length,
          matches: samples,
        })
      }
      ranges.push({
        index,
        start: found[0]!,
        end: found[0]! + oldText.length,
        next: newText,
        count,
      })
      if (count > 1) {
        for (let n = 1; n < found.length; n++) {
          ranges.push({
            index,
            start: found[n]!,
            end: found[n]! + oldText.length,
            next: newText,
            count,
          })
        }
      }
    }
    const ordered = [...ranges].sort((a, b) => a.start - b.start)
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.start < ordered[i - 1]!.end) {
        raise('E_OVERLAP', 'Edit ranges overlap.', 'Split them into separate calls.', {
          a: ordered[i - 1]!.index,
          b: ordered[i]!.index,
        })
      }
    }
    let next = text
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
      next = next.slice(0, range.start) + range.next + next.slice(range.end)
    }
    const hadBom = stripBom(original).charset !== null
    const writeBom = decideBom(bomPolicy, true, hadBom, next, charset)
    const data = withBom(encodeBody(next, charset), charset, writeBom)
    const stamp = await captureStamp(loc.dest)
    await atomicWrite(loc.dest, data, async () => {
      const now = await captureStamp(loc.dest)
      if (!stamp || !now || now.size !== stamp.size || now.mtimeMs !== stamp.mtimeMs) {
        raise('E_HASH_MISMATCH', 'The file changed after the check. The edit was cancelled.', 'Read it again, then retry.', {
          expect: hashBefore,
          actual: now ? (await hashFile(loc.dest)).hash : null,
        })
      }
    })
    const hashAfter = await verifyWritten(loc.dest, data)
    const applied = edits.map((_, index) => {
      const first = ranges.find((range) => range.index === index)!
      return {
        index,
        occurrences: first.count,
        byte_offset: encodeBody(text.slice(0, first.start), charset).length + (hadBom ? (stripBom(original).body.length === original.length ? 0 : original.length - stripBom(original).body.length) : 0),
        line: lineOf(text, first.start),
      }
    })
    return {
      path: loc.requested,
      applied,
      hash_before: hashBefore,
      hash_after: hashAfter,
      verified: true,
      encoding_used: charset === 'utf-8-bom' ? 'utf-8' : charset,
      encoding_source: source,
      roundtrip_ok: true,
      bom: stripBom(data).charset !== null,
      eol: detectEol(next),
      ...(loc.resolved !== loc.requested ? { resolved_path: loc.resolved } : {}),
    }
  })
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

function snippet(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 40)
  const to = Math.min(text.length, at + length + 40)
  return text.slice(from, to)
}

export async function fsSplice(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, SPLICE_FIELDS)
  const hasInsert = 'insert' in args && args.insert !== undefined
  const hasHex = 'insert_hex' in args && args.insert_hex !== undefined
  if (hasInsert && hasHex) raise('E_INVALID_ARG', 'Provide only one of insert or insert_hex.')
  const deleteBytes = optInt(args, 'delete_bytes', 0, 0) ?? 0
  if (!hasInsert && !hasHex && deleteBytes === 0) {
    raise('E_INVALID_ARG', 'Nothing to insert or delete.')
  }
  const loc = await locate(args.path, true)
  if (loc.isDir) raise('E_IS_DIR', 'Target is a directory.')
  const force = optBool(args, 'force', false)
  const createDirs = optBool(args, 'create_dirs', true)
  const expect = parseExpect(args.expect_hash)
  const offsetArg = args.offset
  if (typeof offsetArg !== 'number' && offsetArg !== 'start' && offsetArg !== 'end') {
    raise('E_INVALID_ARG', 'offset must be a byte count, start, or end.')
  }
  if (typeof offsetArg === 'number' && !Number.isInteger(offsetArg)) {
    raise('E_INVALID_ARG', 'offset must be an integer.')
  }
  return withFileLock(loc.dest, async () => {
    const current = await locate(args.path, true)
    if (current.isDir) raise('E_IS_DIR', 'Target is a directory.')
    if (current.exists && current.size > EDIT_MAX_BYTES) {
      raise('E_TOO_LARGE', 'The file is over 8 MB and cannot be spliced.', 'Use a script.')
    }
    const creating =
      !current.exists &&
      deleteBytes === 0 &&
      (offsetArg === 'start' || offsetArg === 'end' || offsetArg === 0)
    if (!current.exists && !creating) raise('E_NOT_FOUND', 'Path does not exist.')
    let previous = current.exists ? await readFile(current.dest).catch(rethrowIo) : Buffer.alloc(0)
    const hashBefore = current.exists ? shortHash(previous) : null
    if (current.exists && expect === null && !force) {
      raise('E_HASH_REQUIRED', 'Editing an existing file requires expect_hash.', 'Retry with the returned hash, or pass force: true.', {
        path: current.requested,
        exists: true,
        hash: hashBefore,
        size: previous.length,
      })
    }
    if (expect === 'absent' && current.exists) {
      raise('E_EXISTS', 'expect_hash requires the file to be absent, but it already exists.', undefined, { hash: hashBefore, size: previous.length })
    }
    if (expect && expect !== 'absent' && hashBefore !== expect) {
      raise('E_HASH_MISMATCH', 'The file changed after you read it. The edit was cancelled and not a byte on disk was touched.', 'Read the hash again with fs_read.', {
        expect,
        actual: hashBefore,
      })
    }
    let position: number
    if (offsetArg === 'start') position = 0
    else if (offsetArg === 'end') position = previous.length
    else if ((offsetArg as number) < 0) {
      position = previous.length + (offsetArg as number)
      if (position < 0) raise('E_RANGE', 'The offset is outside the file.', undefined, { total_size: previous.length })
    } else position = offsetArg as number
    if (position < 0 || position > previous.length || position + deleteBytes > previous.length) {
      raise('E_RANGE', 'The delete range is outside the file.', undefined, { total_size: previous.length })
    }
    let payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let encoding: string | null = null
    if (hasInsert) {
      if (typeof args.insert !== 'string') raise('E_INVALID_ARG', 'insert must be a string.')
      const charset = requireCharset(optString(args, 'encoding') ?? 'utf-8')
      encoding = charset
      payload = encodeBody(args.insert, charset)
    } else if (hasHex) {
      payload = parseHex(args.insert_hex, 'insert_hex')
    }
    const data = Buffer.concat([previous.subarray(0, position), payload, previous.subarray(position + deleteBytes)])
    if (data.length > EDIT_MAX_BYTES && current.exists) {
      raise('E_TOO_LARGE', 'The result is over 8 MB, so fs_splice will not write it.')
    }
    const dirs = current.exists ? [] : await ensureParent(current.dest, createDirs)
    const stamp = expect && expect !== 'absent' ? await captureStamp(current.dest) : null
    await atomicWrite(current.dest, data, async () => {
      if (stamp) {
        const now = await captureStamp(current.dest)
        if (!now || now.size !== stamp.size || now.mtimeMs !== stamp.mtimeMs) {
          raise('E_HASH_MISMATCH', 'The file changed after the check. The edit was cancelled.', undefined, {
            expect,
            actual: now ? (await hashFile(current.dest)).hash : null,
          })
        }
      }
    })
    const hashAfter = await verifyWritten(current.dest, data)
    return {
      path: current.requested,
      size_before: previous.length,
      size_after: data.length,
      hash_before: hashBefore,
      hash_after: hashAfter,
      verified: true,
      forced: force,
      encoding,
      dirs_created: dirs,
      ...(current.resolved !== current.requested ? { resolved_path: current.resolved } : {}),
    }
  })
}
