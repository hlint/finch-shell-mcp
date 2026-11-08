import { execFileSync } from 'node:child_process'
import { detect } from 'jschardet'
import iconv from 'iconv-lite'
import { CHARSETS, type Charset } from './constants.ts'

export type { Charset }
import { raise } from './errors.ts'

const ICONV: Record<Charset, string> = {
  'utf-8': 'utf8',
  'utf-8-bom': 'utf8',
  'utf-16-le': 'utf16le',
  'utf-16-be': 'utf16be',
  gbk: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
  shift_jis: 'shiftjis',
  'euc-jp': 'eucjp',
  'euc-kr': 'euckr',
  'latin-1': 'latin1',
}

export type Eol = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none'
export type Confidence = 'bom' | 'valid-utf8' | 'heuristic' | 'fallback'

export interface Detection {
  charset: Charset
  bom: boolean
  confidence: Confidence
  lossy: boolean
}

export function assertIcu(): void {
  try {
    const text = new TextDecoder('gbk').decode(Buffer.from([0xd6, 0xd0]))
    if (text !== '中') throw new Error('mismatch')
  } catch {
    console.error('Node.js must include full ICU. TextDecoder cannot decode gbk.')
    process.exit(1)
  }
}

export function isCharset(value: string): value is Charset {
  return (CHARSETS as readonly string[]).includes(value)
}

export function requireCharset(value: string, label = 'encoding'): Charset {
  const name = value.trim().toLowerCase().replaceAll('_', '-')
  const aliases: Record<string, Charset> = {
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    'utf-8-bom': 'utf-8-bom',
    utf16le: 'utf-16-le',
    'utf-16le': 'utf-16-le',
    'utf-16-le': 'utf-16-le',
    utf16be: 'utf-16-be',
    'utf-16be': 'utf-16-be',
    'utf-16-be': 'utf-16-be',
    gbk: 'gbk',
    gb18030: 'gb18030',
    big5: 'big5',
    shiftjis: 'shift_jis',
    'shift-jis': 'shift_jis',
    shift_jis: 'shift_jis',
    eucjp: 'euc-jp',
    'euc-jp': 'euc-jp',
    euckr: 'euc-kr',
    'euc-kr': 'euc-kr',
    latin1: 'latin-1',
    'latin-1': 'latin-1',
    'iso-8859-1': 'latin-1',
  }
  const mapped = aliases[name]
  if (!mapped || !isCharset(mapped)) {
    raise('E_INVALID_ARG', `${label} does not support ${value}.`, `Available: ${CHARSETS.join(', ')}`)
  }
  return mapped
}

export function bomOf(charset: Charset): Buffer | null {
  if (charset === 'utf-8' || charset === 'utf-8-bom') return Buffer.from([0xef, 0xbb, 0xbf])
  if (charset === 'utf-16-le') return Buffer.from([0xff, 0xfe])
  if (charset === 'utf-16-be') return Buffer.from([0xfe, 0xff])
  return null
}

export function charsetSupportsBom(charset: Charset): boolean {
  return charset === 'utf-8' || charset === 'utf-8-bom' || charset === 'utf-16-le' || charset === 'utf-16-be'
}

export function stripBom(buffer: Buffer): { body: Buffer; charset: Charset | null } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { body: buffer.subarray(3), charset: 'utf-8' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { body: buffer.subarray(2), charset: 'utf-16-le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { body: buffer.subarray(2), charset: 'utf-16-be' }
  }
  return { body: buffer, charset: null }
}

export function isStrictUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

function looksUtf16(buffer: Buffer): Charset | null {
  if (buffer.length < 4) return null
  const len = Math.min(buffer.length, 8192)
  let even = 0
  let odd = 0
  for (let i = 0; i < len; i++) {
    if (buffer[i] !== 0) continue
    if (i % 2 === 0) even++
    else odd++
  }
  const zeros = even + odd
  if (zeros < len / 8) return null
  if (odd > even * 3) return 'utf-16-le'
  if (even > odd * 3) return 'utf-16-be'
  return null
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192)
  if (sample.length === 0) return false
  if (stripBom(sample).charset) return false
  let nul = 0
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) nul++
  if (nul > 0 && !looksUtf16(sample)) return true
  if (isStrictUtf8(sample)) return false
  const found = detect(sample)
  if (found?.encoding && ((found.confidence ?? 0) >= 0.2 || found.language)) return false
  return true
}

function mapDetectName(name: string): Charset | null {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (key === 'ascii' || key === 'utf8') return 'utf-8'
  if (key === 'utf16le' || key === 'utf16') return 'utf-16-le'
  if (key === 'utf16be') return 'utf-16-be'
  if (key === 'gb18030') return 'gb18030'
  if (key === 'gbk' || key === 'gb2312' || key === 'cp936') return 'gbk'
  if (key === 'big5' || key === 'cp950') return 'big5'
  if (key === 'shiftjis' || key === 'sjis' || key === 'cp932') return 'shift_jis'
  if (key === 'eucjp') return 'euc-jp'
  if (key === 'euckr' || key === 'cp949') return 'euc-kr'
  if (key === 'iso88591' || key === 'latin1' || key === 'windows1252') return 'latin-1'
  return null
}

let oemCharset: Charset | null | undefined

export function platformCharset(): Charset | null {
  if (oemCharset !== undefined) return oemCharset
  oemCharset = null
  if (process.platform !== 'win32') {
    const lang = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || ''
    if (/utf-?8/i.test(lang)) oemCharset = 'utf-8'
    else if (/gbk|gb18030|cp936/i.test(lang)) oemCharset = 'gbk'
    return oemCharset
  }
  try {
    const out = execFileSync('chcp.com', [], { encoding: 'utf8', windowsHide: true })
    const code = Number(/(\d+)/.exec(out)?.[1])
    const map: Record<number, Charset> = {
      65001: 'utf-8',
      936: 'gbk',
      54936: 'gb18030',
      950: 'big5',
      932: 'shift_jis',
      949: 'euc-kr',
      1252: 'latin-1',
    }
    oemCharset = map[code] ?? null
  } catch {
    oemCharset = null
  }
  return oemCharset
}

function decodesClean(buffer: Buffer, charset: Charset): boolean {
  const text = iconv.decode(buffer, ICONV[charset])
  if (text.includes('\uFFFD')) return false
  return iconv.encode(text, ICONV[charset]).equals(buffer)
}

export function detectBuffer(buffer: Buffer): Detection {
  const sample = buffer.subarray(0, 128 * 1024)
  const bom = stripBom(sample).charset
  if (bom) return { charset: bom === 'utf-8' ? 'utf-8' : bom, bom: true, confidence: 'bom', lossy: false }
  if (sample.length === 0 || isStrictUtf8(sample)) {
    return { charset: 'utf-8', bom: false, confidence: 'valid-utf8', lossy: false }
  }
  const utf16 = looksUtf16(sample)
  if (utf16 && decodesClean(sample, utf16)) {
    return { charset: utf16, bom: false, confidence: 'heuristic', lossy: false }
  }
  const hinted = platformCharset()
  if (hinted && hinted !== 'utf-8-bom' && decodesClean(sample, hinted)) {
    return { charset: hinted, bom: false, confidence: 'heuristic', lossy: false }
  }
  const found = detect(sample)
  const mapped = found?.encoding ? mapDetectName(found.encoding) : null
  if (mapped && decodesClean(sample, mapped)) {
    return { charset: mapped, bom: false, confidence: 'heuristic', lossy: false }
  }
  return { charset: 'utf-8', bom: false, confidence: 'fallback', lossy: true }
}

export function decodeBuffer(buffer: Buffer, charset: Charset): { text: string; lossy: boolean } {
  const bodyCharset: Charset = charset === 'utf-8-bom' ? 'utf-8' : charset
  const stripped = stripBom(buffer)
  const text = iconv.decode(stripped.body, ICONV[bodyCharset])
  const back = iconv.encode(text, ICONV[bodyCharset])
  return { text, lossy: !back.equals(stripped.body) }
}

export function encodeBody(text: string, charset: Charset): Buffer {
  const body = text.replace(/^\uFEFF/, '')
  const bodyCharset: Charset = charset === 'utf-8-bom' ? 'utf-8' : charset
  const encoded = iconv.encode(body, ICONV[bodyCharset])
  const back = iconv.decode(encoded, ICONV[bodyCharset])
  if (back !== body) {
    let index = 0
    const limit = Math.min(body.length, back.length)
    while (index < limit && body[index] === back[index]) index++
    const code = body.codePointAt(index) ?? 0
    raise(
      'E_ENCODING_UNREPRESENTABLE',
      `Character ${index} (U+${code.toString(16).toUpperCase()}) cannot be represented in ${charset}.`,
      'Use another encoding, or change that character.',
      { index, codepoint: `U+${code.toString(16).toUpperCase()}` },
    )
  }
  return encoded
}

export function withBom(body: Buffer, charset: Charset, writeBom: boolean): Buffer {
  if (!writeBom) return body
  const mark = bomOf(charset)
  if (!mark) {
    raise('E_INVALID_ARG', `${charset} cannot write a BOM.`, 'Do not use preserve.bom add, or switch to utf-8 / utf-16.')
  }
  return Buffer.concat([mark, body])
}

export function detectEol(text: string): Eol {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        crlf++
        i++
      } else cr++
    } else if (ch === '\n') lf++
  }
  const kinds = Number(crlf > 0) + Number(lf > 0) + Number(cr > 0)
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  if (crlf) return 'crlf'
  if (lf) return 'lf'
  return 'cr'
}

export function applyEol(text: string, mode: string, oldEol: Eol): string {
  if (mode === 'as_is') return text
  if (mode === 'crlf') return text.replace(/\r\n|\r|\n/g, '\n').replace(/\n/g, '\r\n')
  if (mode === 'lf') return text.replace(/\r\n|\r|\n/g, '\n')
  if (mode === 'keep') {
    const repl = oldEol === 'crlf' ? '\r\n' : oldEol === 'lf' ? '\n' : oldEol === 'cr' ? '\r' : null
    if (!repl) return text
    return text.replace(/\r\n|\n/g, (token) => (token === '\r\n' ? '\r\n' : repl))
  }
  raise('E_INVALID_ARG', 'preserve.eol must be keep, crlf, lf, or as_is.')
}

export function decideBom(
  policy: string,
  existed: boolean,
  hadBom: boolean,
  text: string,
  charset: Charset,
): boolean {
  if (!['keep', 'add', 'strip', 'as_is'].includes(policy)) {
    raise('E_INVALID_ARG', 'preserve.bom must be keep, add, strip, or as_is.')
  }
  if (charset === 'utf-8-bom') return true
  const wants =
    policy === 'add' ||
    policy === 'strip'
      ? policy === 'add'
      : policy === 'as_is'
        ? text.startsWith('\uFEFF')
        : existed
          ? hadBom
          : text.startsWith('\uFEFF')
  if (wants && !charsetSupportsBom(charset)) {
    raise('E_INVALID_ARG', `${charset} has no BOM.`, 'Do not request a BOM, or switch to utf-8 / utf-16.')
  }
  return wants
}

export function incompleteBytes(buffer: Buffer, charset: Charset): number {
  if (buffer.length === 0) return 0
  if (charset === 'utf-16-le' || charset === 'utf-16-be') return buffer.length % 2
  if (charset === 'latin-1') return 0
  if (charset === 'utf-8' || charset === 'utf-8-bom') {
    let i = buffer.length - 1
    let cont = 0
    while (i >= 0 && cont < 3 && (buffer[i]! & 0xc0) === 0x80) {
      i--
      cont++
    }
    if (i < 0) return 0
    const lead = buffer[i]!
    let need = 1
    if ((lead & 0xe0) === 0xc0) need = 2
    else if ((lead & 0xf0) === 0xe0) need = 3
    else if ((lead & 0xf8) === 0xf0) need = 4
    else return 0
    const have = buffer.length - i
    return have < need ? have : 0
  }
  return buffer[buffer.length - 1]! >= 0x80 ? 1 : 0
}

export function edgesAligned(buffer: Buffer, charset: Charset): boolean {
  if (buffer.length === 0) return true
  return startOnBoundary(buffer, charset) && endOnBoundary(buffer, charset)
}

function startOnBoundary(buffer: Buffer, charset: Charset): boolean {
  if (charset === 'utf-8' || charset === 'utf-8-bom') return (buffer[0]! & 0xc0) !== 0x80
  if (charset === 'utf-16-le' || charset === 'utf-16-be' || charset === 'latin-1') return true
  return true
}

function endOnBoundary(buffer: Buffer, charset: Charset): boolean {
  if (charset === 'utf-8' || charset === 'utf-8-bom' || charset === 'utf-16-le' || charset === 'utf-16-be') {
    return incompleteBytes(buffer, charset) === 0
  }
  if (charset === 'latin-1') return true
  let index = 0
  while (index < buffer.length) {
    if (buffer[index]! < 0x80) {
      index++
      continue
    }
    if (index + 1 >= buffer.length) return false
    index += 2
  }
  return true
}

export function offsetAligned(buffer: Buffer, offset: number, charset: Charset): boolean {
  if (offset <= 0 || offset >= buffer.length) return true
  if (charset === 'utf-8' || charset === 'utf-8-bom') return (buffer[offset]! & 0xc0) !== 0x80
  if (charset === 'utf-16-le' || charset === 'utf-16-be') return offset % 2 === 0
  if (charset === 'latin-1') return true
  let i = 0
  while (i < offset && i < buffer.length) {
    const b = buffer[i]!
    const width = b < 0x80 ? 1 : 2
    if (i + width > offset) return false
    i += width
  }
  return i === offset
}
