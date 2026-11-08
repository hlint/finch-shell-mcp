export const VERSION = '0.1.0'

export const HASH_HEX_LEN = 6
export const HASH_MAX_BYTES = 64 * 1024 * 1024
export const READ_MAX_BYTES = 2 * 1024 * 1024
export const EDIT_MAX_BYTES = 8 * 1024 * 1024
export const WRITE_MAX_BYTES = 32 * 1024 * 1024
export const HTTP_BODY_MAX = 32 * 1024 * 1024
export const STAT_ENCODING_MAX = 1 * 1024 * 1024
export const BINARY_SNIFF_BYTES = 8 * 1024
export const DETECT_SAMPLE_BYTES = 128 * 1024

export const MAX_JOBS = 64
export const RING_CHARS = 2_000_000
export const READ_MAX_CHARS = 16384
export const EXEC_TAIL_CHARS = 4096
export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_WAIT_MS = 60_000
export const DEFAULT_TTL_MS = 30 * 60 * 1000
export const MAX_TTL_MS = 24 * 60 * 60 * 1000
export const STANDBY_MS = 1500
export const RETAIN_MS = 10 * 60 * 1000
export const LOG_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_GRACE_MS = 3000
export const DEFAULT_HTTP_PORT = 7331
export const HTTP_PATH = '/mcp'

export const CHARSETS = [
  'utf-8',
  'utf-8-bom',
  'utf-16-le',
  'utf-16-be',
  'gbk',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'latin-1',
] as const

export type Charset = (typeof CHARSETS)[number]
