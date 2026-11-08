import path from 'node:path'
import { raise } from './errors.ts'

const ILLEGAL = /[<>:"|?*\u0000-\u001f]/

export function normalizeUserPath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    raise('E_INVALID_ARG', 'Path must be a non-empty string.')
  }
  if (input.includes('\0')) raise('E_PATH', 'Path contains a null character.')
  if (process.platform !== 'win32') return normalizePosix(input)
  const slashed = input.replaceAll('/', '\\')
  const unc = slashed.startsWith('\\\\')
  if (!unc && !/^[A-Za-z]:\\/.test(slashed)) {
    raise('E_INVALID_ARG', 'Only absolute paths are accepted.', 'Pass a full path starting with a drive letter or a UNC prefix.')
  }

  const body = unc ? slashed.slice(2) : slashed.slice(3)
  const parts = body.split('\\')
  const stack: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) raise('E_PATH', 'Path escapes the root directory.')
      stack.pop()
      continue
    }
    const trimmed = part.replace(/[ .]+$/g, '')
    if (!trimmed) raise('E_PATH', 'A path segment is only spaces or dots.')
    if (ILLEGAL.test(trimmed)) raise('E_PATH', 'Path contains an illegal character.')
    stack.push(trimmed)
  }

  let normalized: string
  if (unc) {
    if (stack.length < 2) raise('E_PATH', 'The UNC path is incomplete.')
    normalized = `\\\\${stack.join('\\')}`
  } else {
    const drive = slashed.slice(0, 2)
    normalized = stack.length === 0 ? `${drive}\\` : `${drive}\\${stack.join('\\')}`
  }
  if (normalized.length > 240 && !normalized.startsWith('\\\\?\\')) {
    normalized = unc ? `\\\\?\\UNC\\${normalized.slice(2)}` : `\\\\?\\${normalized}`
  }
  return normalized
}

function normalizePosix(input: string): string {
  if (!input.startsWith('/')) {
    raise('E_INVALID_ARG', 'Only absolute paths are accepted.', 'Pass a full path starting with /.')
  }
  const stack: string[] = []
  for (const part of input.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (stack.length === 0) raise('E_PATH', 'Path escapes the root directory.')
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.length === 0 ? '/' : `/${stack.join('/')}`
}

export function pathKey(value: string): string {
  if (process.platform !== 'win32') return value
  return value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '').toLowerCase()
}

export function toNative(value: string): string {
  if (process.platform === 'win32') return value.replaceAll('/', '\\')
  return value
}

export function parentDir(filePath: string): string {
  return path.dirname(filePath)
}
