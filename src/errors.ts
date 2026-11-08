export const ERROR_CODES = [
  'E_INVALID_ARG',
  'E_NOT_FOUND',
  'E_IS_DIR',
  'E_ACCESS',
  'E_PATH',
  'E_HASH_MISMATCH',
  'E_HASH_REQUIRED',
  'E_EXISTS',
  'E_NO_MATCH',
  'E_AMBIGUOUS',
  'E_OVERLAP',
  'E_RANGE',
  'E_NOT_TEXT',
  'E_TOO_LARGE',
  'E_ENCODING_UNSURE',
  'E_ENCODING_ROUNDTRIP',
  'E_ENCODING_UNREPRESENTABLE',
  'E_VERIFY_FAILED',
  'E_IO',
  'E_SPAWN_FAILED',
  'E_TOO_MANY_JOBS',
  'E_JOB_GONE',
  'E_STDIN_CLOSED',
  'E_NOT_INTERACTIVE',
  'E_KILL_INCOMPLETE',
  'E_MEM_LIMIT',
  'E_TIMEOUT',
  'E_TTY_UNAVAILABLE',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ToolFail {
  ok: false
  error: {
    code: ErrorCode
    message: string
    hint?: string
    context?: Record<string, unknown>
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  hint?: string,
  context?: Record<string, unknown>,
): ToolFail {
  const error: ToolFail['error'] = { code, message }
  if (hint) error.hint = hint
  if (context && Object.keys(context).length > 0) error.context = context
  return { ok: false, error }
}

export class ToolError extends Error {
  readonly body: ToolFail
  constructor(code: ErrorCode, message: string, hint?: string, context?: Record<string, unknown>) {
    super(message)
    this.name = 'ToolError'
    this.body = fail(code, message, hint, context)
  }
}

export function raise(code: ErrorCode, message: string, hint?: string, context?: Record<string, unknown>): never {
  throw new ToolError(code, message, hint, context)
}

export function asErrno(error: unknown): NodeJS.ErrnoException | null {
  if (error && typeof error === 'object' && 'code' in error) return error as NodeJS.ErrnoException
  return null
}

export function rethrowIo(error: unknown): never {
  if (error instanceof ToolError) throw error
  const err = asErrno(error)
  const code = err?.code
  const message = err?.message ?? (error instanceof Error ? error.message : 'Read or write failed.')
  if (code === 'ENOENT') raise('E_NOT_FOUND', 'Path does not exist.')
  if (code === 'EISDIR') raise('E_IS_DIR', 'Target is a directory.')
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    raise('E_ACCESS', `Access denied or the file is busy: ${message}`)
  }
  raise('E_IO', message)
}
