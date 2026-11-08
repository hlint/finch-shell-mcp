import { raise, type ToolFail } from './errors.ts'

export type Args = Record<string, unknown>

export function asArgs(value: unknown): Args {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    raise('E_INVALID_ARG', 'Arguments must be an object.')
  }
  return value as Args
}

export function rejectUnknown(args: Args, allowed: readonly string[]): void {
  if ('tty' in args) {
    raise(
      'E_TTY_UNAVAILABLE',
      'This server is a pipe. It does not provide a terminal.',
      'Remove tty. Pass secrets with a key file or --password-stdin, not an interactive terminal.',
    )
  }
  for (const key of Object.keys(args)) {
    if (key === 'data_base64' || key === 'insert_base64' || key.endsWith('_base64')) {
      raise('E_INVALID_ARG', 'Base64 is not accepted. Pass bytes as a hexadecimal string.')
    }
    if (!allowed.includes(key)) raise('E_INVALID_ARG', `Unknown argument ${key}.`)
  }
}

export function optBool(args: Args, key: string, fallback: boolean): boolean {
  if (!(key in args) || args[key] === undefined) return fallback
  if (typeof args[key] !== 'boolean') raise('E_INVALID_ARG', `${key} must be a boolean.`)
  return args[key] as boolean
}

export function optString(args: Args, key: string): string | undefined {
  if (!(key in args) || args[key] === undefined || args[key] === null) return undefined
  if (typeof args[key] !== 'string') raise('E_INVALID_ARG', `${key} must be a string.`)
  return args[key] as string
}

export function reqString(args: Args, key: string): string {
  const value = optString(args, key)
  if (!value) raise('E_INVALID_ARG', `Missing ${key}.`)
  return value
}

export function optInt(
  args: Args,
  key: string,
  fallback: number | null,
  min?: number,
  max?: number,
): number | null {
  if (!(key in args) || args[key] === undefined || args[key] === null) return fallback
  const value = args[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    raise('E_INVALID_ARG', `${key} must be an integer.`)
  }
  if (min !== undefined && value < min) raise('E_INVALID_ARG', `${key} must be at least ${min}.`)
  if (max !== undefined && value > max) raise('E_INVALID_ARG', `${key} must be at most ${max}.`)
  return value
}

export function toolText(body: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] }
}

export function errorText(error: unknown): { content: [{ type: 'text'; text: string }] } {
  if (error && typeof error === 'object' && 'body' in error) {
    return toolText((error as { body: ToolFail }).body)
  }
  const message = error instanceof Error ? error.message : 'Internal error.'
  console.error(error)
  return toolText({ ok: false, error: { code: 'E_IO', message } })
}
