import { AsyncLocalStorage } from 'node:async_hooks'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, type WriteStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { asArgs, optBool, optInt, optString, rejectUnknown, type Args } from './args.ts'
import { ClixmlGate } from './clixml.ts'
import {
  DEFAULT_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  EXEC_TAIL_CHARS,
  MAX_JOBS,
  MAX_TTL_MS,
  MAX_WAIT_MS,
  READ_MAX_CHARS,
  RETAIN_MS,
  RING_CHARS,
  STANDBY_MS,
} from './constants.ts'
import { decodeBuffer, detectBuffer, encodeBody, incompleteBytes, type Charset } from './encoding.ts'
import { raise, ToolError } from './errors.ts'
import { ensureLayout, listActiveLogs, pidAlive, sweepOldLogs, type Layout } from './home.ts'

const EXEC_FIELDS = [
  'mode', 'program', 'args', 'script', 'interpreter', 'name', 'cwd', 'env', 'env_mode',
  'timeout', 'ttl_ms', 'tags', 'stdin', 'close_stdin', 'mem_limit_mb', 'cpu_limit_ms', 'grace_ms',
]
const READ_FIELDS = ['job_id', 'cursor', 'max_chars', 'wait_ms']
const SEND_FIELDS = ['job_id', 'input', 'input_hex', 'cursor', 'close_after', 'wait_ms']
const LIST_FIELDS = ['tags', 'include_finished', 'limit']
const KILL_FIELDS = ['job_id', 'grace_ms']

const ENFORCEMENT = {
  mem: 'monitor',
  tree_kill: process.platform === 'win32' ? 'walk' : 'kernel',
  cpu: 'none',
} as const
const TAG_TEXT = /^[A-Za-z0-9._:-]+$/
const DEFAULT_EXT = ['.COM', '.EXE', '.BAT', '.CMD', '.VBS', '.JS', '.WS', '.MSC']

type LiveStatus = 'running' | 'standing_by' | 'finished' | 'failed' | 'timeout' | 'killed'

interface Job {
  job_id: string
  name: string | null
  status: LiveStatus
  pid: number | null
  command: string
  cwd: string
  tags: Record<string, string>
  startedAt: string
  startedMs: number
  endedMs: number | null
  expiresAt: string
  logPath: string
  child: ChildProcess | null
  stdinClosed: boolean
  exitCode: number | null
  signal: string | null
  killReason: 'ttl' | 'kill' | 'mem' | null
  encoding: Charset | null
  lossy: boolean
  totalChars: number
  dropped: number
  ring: string[]
  ringChars: number
  tail: string
  lastOutputAt: number
  graceMs: number
  memLimitMb: number | null
  peakRssMb: number | null
  children: number
  retainUntil: number | null
  readAt: { char: number; byte: number }
  decoder: StreamDecoder
  clixml: ClixmlGate
  log: WriteStream | null
  timer: NodeJS.Timeout | null
  decodeTimer: NodeJS.Timeout | null
  queue: Promise<void>
}

interface ProcInfo {
  ppid: number
  rss: number
  name: string
  state: string
}

interface Lost {
  job_id: string
  log_path: string
  started_at: string | null
}

interface Bucket {
  jobs: Map<string, Job>
  lost: Map<string, Lost>
  gone: Map<string, string>
}

const sessions = new AsyncLocalStorage<string>()
const buckets = new Map<string, Bucket>()

export function runWithSession<T>(sessionId: string, fn: () => T): T {
  return sessions.run(sessionId, fn)
}

function currentKey(): string {
  return sessions.getStore() ?? ''
}

function bucketOf(key: string): Bucket {
  let found = buckets.get(key)
  if (!found) {
    found = { jobs: new Map(), lost: new Map(), gone: new Map() }
    buckets.set(key, found)
  }
  return found
}

function currentBucket(): Bucket {
  return bucketOf(currentKey())
}

function allJobs(): Job[] {
  const all: Job[] = []
  for (const bucket of buckets.values()) for (const job of bucket.jobs.values()) all.push(job)
  return all
}
let layoutPromise: Promise<Layout> | null = null
let snapCache: { at: number; map: Map<number, ProcInfo> } | null = null
let booted = false

function layout(): Promise<Layout> {
  layoutPromise ??= ensureLayout()
  return layoutPromise
}

export async function bootJobs(): Promise<void> {
  if (booted) return
  booted = true
  const home = await layout()
  await sweepOldLogs(home.finished, home.tmp)
  for (const item of await listActiveLogs(home.active)) {
    if (item.ownerPid === process.pid || pidAlive(item.ownerPid)) continue
    bucketOf('').lost.set(item.jobId, { job_id: item.jobId, log_path: item.logPath, started_at: item.startedAt })
  }
  const monitor = setInterval(() => {
    void sampleJobs().catch((error) => console.error(error))
  }, 1000)
  monitor.unref()
  const sweep = setInterval(() => {
    void layout().then((home) => sweepOldLogs(home.finished, home.tmp)).catch(() => undefined)
    expireJobs()
  }, 60_000)
  sweep.unref()
}

export async function shutdownJobs(): Promise<void> {
  const live = allJobs().filter((job) => job.status === 'running' || job.status === 'standing_by')
  await Promise.all(live.map((job) => killJob(job, 200)))
}

function expireJobs(): void {
  const now = Date.now()
  for (const bucket of buckets.values()) {
    for (const [id, job] of bucket.jobs) {
      if (job.retainUntil !== null && job.retainUntil <= now) {
        bucket.gone.set(id, job.logPath)
        bucket.jobs.delete(id)
      }
    }
  }
}

class StreamDecoder {
  private pending = Buffer.alloc(0)
  charset: Charset | null = null
  lossy = false
  push(chunk: Buffer): string {
    this.pending = Buffer.concat([this.pending, chunk])
    if (!this.charset && !ready(this.pending)) return ''
    this.charset ??= detectBuffer(this.pending).charset
    return this.drain(false)
  }
  flush(): string {
    if (!this.charset) {
      this.charset = this.pending.length ? detectBuffer(this.pending).charset : 'utf-8'
    }
    return this.drain(true)
  }
  private drain(final: boolean): string {
    const charset = this.charset ?? 'utf-8'
    const hold = final ? 0 : incompleteBytes(this.pending, charset)
    const slice = this.pending.subarray(0, this.pending.length - hold)
    this.pending = this.pending.subarray(this.pending.length - hold)
    if (slice.length === 0) return ''
    const decoded = decodeBuffer(slice, charset)
    if (decoded.lossy) this.lossy = true
    return decoded.text
  }
}

function ready(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return true
  if (buffer.length >= 2 && (buffer[0] === 0xff || buffer[0] === 0xfe) && (buffer[1] === 0xfe || buffer[1] === 0xff)) return true
  if (buffer.includes(0x0a) || buffer.length >= 64) return true
  return false
}

function isLive(status: LiveStatus): boolean {
  return status === 'running' || status === 'standing_by'
}

function refresh(job: Job): void {
  if (!isLive(job.status)) return
  if (Date.now() - job.lastOutputAt >= STANDBY_MS) job.status = 'standing_by'
}

function promptHint(tail: string): string | null {
  const patterns = ['\u8bf7\u6309\u4efb\u610f\u952e', 'Password:', '(y/n)', '> ', '$ ', '? ']
  for (const pattern of patterns) if (tail.includes(pattern)) return pattern
  return null
}

async function appendText(job: Job, text: string): Promise<void> {
  if (!text) return
  const points = countPoints(text)
  job.totalChars += points
  job.ring.push(text)
  job.ringChars += points
  while (job.ringChars > RING_CHARS && job.ring.length > 0) {
    const head = job.ring[0] ?? ''
    const extra = job.ringChars - RING_CHARS
    const headPoints = countPoints(head)
    if (headPoints <= extra) {
      job.ring.shift()
      job.ringChars -= headPoints
      job.dropped += headPoints
    } else {
      job.ring[0] = slicePoints(head, extra, headPoints)
      job.ringChars -= extra
      job.dropped += extra
      break
    }
  }
  job.tail = (job.tail + text).slice(-200)
  job.lastOutputAt = Date.now()
  if (!isTerminal(job.status)) job.status = 'running'
  await writeLog(job, text)
}

function emitText(job: Job, text: string, final = false): void {
  const cleaned = job.clixml.push(text, final)
  if (!cleaned) return
  job.queue = job.queue.then(() => appendText(job, cleaned))
}

function elapsedMs(job: Job): number {
  return (job.endedMs ?? Date.now()) - job.startedMs
}

function hintFor(job: Job): string | null {
  if (isTerminal(job.status)) return null
  return promptHint(job.tail)
}

function settle(job: Job): void {
  if (job.endedMs === null) job.endedMs = Date.now()
  job.children = 0
}

function isTerminal(status: LiveStatus): boolean {
  return status === 'finished' || status === 'failed' || status === 'timeout' || status === 'killed'
}

function writeLog(job: Job, text: string): Promise<void> {
  if (!job.log) return Promise.resolve()
  return new Promise((resolve, reject) => {
    job.log?.write(text, 'utf8', (error) => (error ? reject(error) : resolve()))
  })
}

async function endLog(job: Job): Promise<void> {
  const stream = job.log
  job.log = null
  if (!stream) return
  await new Promise<void>((resolve) => stream.end(() => resolve()))
  const home = await layout()
  const dest = path.join(home.finished, path.basename(job.logPath))
  try {
    await rename(job.logPath, dest)
    job.logPath = dest
  } catch {
    // A hard stop cannot move the file. It stays in active and is marked lost on the next start.
  }
}

function finish(job: Job, code: number | null, signal: NodeJS.Signals | null): void {
  if (isTerminal(job.status)) return
  job.exitCode = code
  job.signal = signal
  const flushed = job.decoder.flush()
  emitText(job, flushed, true)
  void job.queue.then(async () => {
    await endLog(job)
    if (isTerminal(job.status)) return
    if (job.killReason === 'ttl') job.status = 'timeout'
    else if (job.killReason === 'kill' || job.killReason === 'mem') job.status = 'killed'
    else if (code === 0) job.status = 'finished'
    else job.status = 'failed'
    job.retainUntil = Date.now() + RETAIN_MS
    job.encoding = job.decoder.charset
    job.lossy = job.decoder.lossy
    settle(job)
  })
}

export async function execJob(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, EXEC_FIELDS)
  if (args.cpu_limit_ms !== undefined && args.cpu_limit_ms !== null) {
    raise('E_INVALID_ARG', 'CPU time is not measured, so cpu_limit_ms cannot be set.', 'Remove cpu_limit_ms. Use ttl_ms to limit how long a job lives.')
  }
  const mode = optString(args, 'mode')
  if (mode !== 'argv' && mode !== 'shell') raise('E_INVALID_ARG', 'mode is required and must be argv or shell.')
  if (mode === 'argv' && ('script' in args || 'interpreter' in args)) {
    raise('E_INVALID_ARG', 'argv mode cannot include script or interpreter.')
  }
  if (mode === 'shell' && ('program' in args || 'args' in args)) {
    raise('E_INVALID_ARG', 'shell mode cannot include program or args.')
  }
  const timeout = optInt(args, 'timeout', DEFAULT_TIMEOUT_MS, 0, MAX_WAIT_MS) ?? DEFAULT_TIMEOUT_MS
  const ttl = optInt(args, 'ttl_ms', DEFAULT_TTL_MS, 0, MAX_TTL_MS) ?? DEFAULT_TTL_MS
  const graceMs = optInt(args, 'grace_ms', DEFAULT_GRACE_MS, 0, 60_000) ?? DEFAULT_GRACE_MS
  const memLimit = optInt(args, 'mem_limit_mb', null, 1, 1024 * 1024)
  const tags = parseTags(args.tags)
  const name = optString(args, 'name') ?? null
  const cwd = resolveCwd(optString(args, 'cwd'))
  const env = buildEnv(args.env, optString(args, 'env_mode') ?? 'merge')
  const closeStdin = optBool(args, 'close_stdin', false)
  const stdin = optString(args, 'stdin')
  if (liveCount() >= MAX_JOBS) {
    raise('E_TOO_MANY_JOBS', 'The job limit of 64 has been reached.', 'Finish some jobs before starting another.', {
      max_jobs: MAX_JOBS,
      by_tag: tagGroups(),
    })
  }
  const home = await layout()
  const mine = currentBucket()
  const jobId = newId()
  const logPath = path.join(home.active, `${jobId}.${process.pid}.log`)
  const command = mode === 'argv' ? argvCommand(args) : shellCommand(args)
  const job: Job = {
    job_id: jobId,
    name,
    status: 'running',
    pid: null,
    command,
    cwd,
    tags,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    endedMs: null,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    logPath,
    child: null,
    stdinClosed: false,
    exitCode: null,
    signal: null,
    killReason: null,
    encoding: null,
    lossy: false,
    totalChars: 0,
    dropped: 0,
    ring: [],
    ringChars: 0,
    tail: '',
    lastOutputAt: Date.now(),
    graceMs,
    memLimitMb: memLimit,
    peakRssMb: null,
    children: 0,
    retainUntil: null,
    readAt: { char: 0, byte: 0 },
    decoder: new StreamDecoder(),
    clixml: new ClixmlGate(),
    log: createWriteStream(logPath, { flags: 'a' }),
    timer: null,
    decodeTimer: null,
    queue: Promise.resolve(),
  }
  mine.jobs.set(jobId, job)
  let child: ChildProcess
  try {
    child = mode === 'argv' ? spawnArgv(args, cwd, env) : await spawnShell(args, cwd, env, home.tmp)
  } catch (error) {
    mine.jobs.delete(jobId)
    job.log?.end()
    if (error instanceof ToolError) throw error
    raise('E_SPAWN_FAILED', `Failed to start: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  job.child = child
  job.pid = child.pid ?? null
  wire(job, child)
  try {
    await waitSpawn(child)
  } catch (error) {
    job.status = 'failed'
    job.retainUntil = Date.now() + RETAIN_MS
    settle(job)
    raise('E_SPAWN_FAILED', `Failed to start: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
  if (stdin) {
    const payload = Buffer.from(stdin, 'utf8')
    await writeStdin(job, payload).catch((error) => {
      raise('E_SPAWN_FAILED', `Failed to write the initial stdin: ${error instanceof Error ? error.message : 'unknown error'}`)
    })
  }
  if (closeStdin) closeStdinOf(job)
  if (ttl >= 0) {
    job.timer = setTimeout(() => {
      job.killReason = 'ttl'
      void killJob(job, job.graceMs)
    }, ttl)
    job.timer.unref()
  }
  await waitNotRunning(job, timeout)
  return readView(job, -EXEC_TAIL_CHARS, EXEC_TAIL_CHARS, true)
}

function wire(job: Job, child: ChildProcess): void {
  const onChunk = (chunk: Buffer) => {
    const text = job.decoder.push(chunk)
    if (text) emitText(job, text)
    if (!job.decoder.charset) scheduleDecode(job)
  }
  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  child.on('error', () => {
    if (!isTerminal(job.status) && job.pid === null) {
      job.status = 'failed'
      settle(job)
    }
  })
  child.on('exit', (code, signal) => finish(job, code, signal))
}

function scheduleDecode(job: Job): void {
  if (job.decodeTimer || job.decoder.charset) return
  job.decodeTimer = setTimeout(() => {
    job.decodeTimer = null
    if (job.decoder.charset) return
    const text = job.decoder.flush()
    if (text) emitText(job, text)
    job.encoding = job.decoder.charset
    job.lossy = job.decoder.lossy
  }, 40)
  job.decodeTimer.unref()
}

function waitSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', (error) => reject(error))
  })
}

async function waitNotRunning(job: Job, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    refresh(job)
    if (job.status !== 'running') return
    await delay(Math.min(50, Math.max(1, deadline - Date.now())))
  }
  refresh(job)
}

export async function jobRead(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, READ_FIELDS)
  const id = reqId(args)
  const waitMs = optInt(args, 'wait_ms', 0, 0, MAX_WAIT_MS) ?? 0
  const maxChars = optInt(args, 'max_chars', READ_MAX_CHARS, 1, READ_MAX_CHARS) ?? READ_MAX_CHARS
  const cursor = optInt(args, 'cursor', 0)
  if (cursor === null) raise('E_INVALID_ARG', 'cursor must be an integer.')
  const mine = currentBucket()
  const lostJob = mine.lost.get(id)
  if (!mine.jobs.has(id) && lostJob) return lostView(lostJob)
  const job = requireJob(id)
  if (waitMs > 0) await waitNotRunning(job, waitMs)
  else refresh(job)
  return readView(job, cursor, maxChars, false)
}

export async function jobSend(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, SEND_FIELDS)
  const job = requireJob(reqId(args))
  refresh(job)
  if (!('cursor' in args)) raise('E_INVALID_ARG', 'job_send requires cursor.', 'Pass the cursor from the last read so old output is not returned again.')
  const cursor = optInt(args, 'cursor', null)
  if (cursor === null) raise('E_INVALID_ARG', 'cursor must be an integer.')
  const hasInput = 'input' in args && args.input !== undefined
  const hasHex = 'input_hex' in args && args.input_hex !== undefined
  if (hasInput === hasHex) raise('E_INVALID_ARG', 'Provide exactly one of input or input_hex.')
  if (job.status !== 'standing_by') {
    raise('E_NOT_INTERACTIVE', 'The job is not standing_by, so stdin cannot be written.', 'Use job_read and wait until it goes quiet.', { status: job.status })
  }
  if (job.stdinClosed || !job.child?.stdin || job.child.stdin.writableEnded) {
    raise('E_STDIN_CLOSED', 'Stdin for this job is already closed.')
  }
  const payload = hasHex ? parseHex(args.input_hex) : encodeBody(String(args.input), job.encoding ?? 'utf-8')
  try {
    await writeStdin(job, payload)
  } catch {
    raise('E_STDIN_CLOSED', 'Stdin for this job is already closed.')
  }
  if (optBool(args, 'close_after', false)) closeStdinOf(job)
  job.lastOutputAt = Date.now()
  job.status = 'running'
  const waitMs = optInt(args, 'wait_ms', DEFAULT_TIMEOUT_MS, 0, MAX_WAIT_MS) ?? DEFAULT_TIMEOUT_MS
  await waitNotRunning(job, waitMs)
  const view = await readView(job, cursor, READ_MAX_CHARS, false)
  view.input_bytes = payload.length
  view.stdin_closed = job.stdinClosed
  return view
}

export async function jobList(raw: unknown): Promise<Record<string, unknown>> {
  const args = raw === undefined || raw === null ? {} : asArgs(raw)
  rejectUnknown(args, LIST_FIELDS)
  const filter = parseTags(args.tags)
  const includeFinished = optBool(args, 'include_finished', false)
  const limit = optInt(args, 'limit', 50, 1, 200) ?? 50
  expireJobs()
  await sampleJobs().catch(() => undefined)
  const mine = currentBucket()
  const rows: Record<string, unknown>[] = []
  for (const job of mine.jobs.values()) {
    refresh(job)
    if (!includeFinished && isTerminal(job.status)) continue
    if (!tagsMatch(job.tags, filter)) continue
    rows.push(jobRow(job))
  }
  for (const item of mine.lost.values()) {
    if (mine.jobs.has(item.job_id)) continue
    if (Object.keys(filter).length > 0) continue
    rows.push({
      job_id: item.job_id,
      name: null,
      status: 'lost',
      pid: null,
      command: null,
      cwd: null,
      tags: {},
      started_at: item.started_at,
      expires_at: null,
      elapsed_ms: null,
      total_chars: null,
      peak_rss_mb: null,
      children: 0,
      log_path: item.log_path,
      last_output_at: null,
      prompt_hint: null,
    })
  }
  rows.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')))
  const running = [...mine.jobs.values()].filter((job) => isLive(job.status)).length
  return { jobs: rows.slice(0, limit), total: rows.length, running_count: running, max_jobs: MAX_JOBS }
}

export async function jobKill(raw: unknown): Promise<Record<string, unknown>> {
  const args = asArgs(raw)
  rejectUnknown(args, KILL_FIELDS)
  const job = requireJob(reqId(args))
  refresh(job)
  if (!isLive(job.status)) {
    return { killed: false, escalated: false, remaining_children: 0, exit_code: job.exitCode, status: job.status }
  }
  const grace = optInt(args, 'grace_ms', job.graceMs, 0, 60_000) ?? job.graceMs
  const result = await killJob(job, grace)
  if (result.remaining > 0) {
    raise('E_KILL_INCOMPLETE', 'The process tree was not fully stopped.', 'Call job_kill again.', {
      remaining_children: result.remaining,
    })
  }
  return { killed: true, escalated: result.escalated, remaining_children: 0, exit_code: job.exitCode }
}

async function killJob(job: Job, grace: number): Promise<{ escalated: boolean; remaining: number }> {
  if (!job.killReason) job.killReason = 'kill'
  closeStdinOf(job)
  const pid = job.pid
  if (!pid) {
    job.status = job.killReason === 'ttl' ? 'timeout' : 'killed'
    settle(job)
    return { escalated: false, remaining: 0 }
  }
  const result = await killTree(pid, grace)
  const deadline = Date.now() + 2000
  while (!isTerminal(job.status) && Date.now() < deadline) await delay(20)
  job.children = result.remaining
  return result
}

async function readView(job: Job, cursor: number, maxChars: number, summary: boolean): Promise<Record<string, unknown>> {
  refresh(job)
  const start = normalizeCursor(cursor, job.totalChars)
  const text = await sliceText(job, start, maxChars)
  const returned = countPoints(text)
  const cursorEnd = start + returned
  job.encoding = job.decoder.charset
  job.lossy = job.decoder.lossy
  const body: Record<string, unknown> = {
    job_id: job.job_id,
    status: job.status,
    text,
    cursor_start: start,
    cursor: cursorEnd,
    total_chars: job.totalChars,
    chars_returned: returned,
    truncated: cursorEnd < job.totalChars,
    capped: returned === maxChars && (start > 0 || cursorEnd < job.totalChars),
    eof: cursorEnd >= job.totalChars,
    dropped_chars: job.dropped,
    encoding_used: job.encoding,
    lossy: job.lossy,
    prompt_hint: hintFor(job),
    log_path: job.logPath,
  }
  if (summary) {
    body.name = job.name
    body.exit_code = isTerminal(job.status) ? job.exitCode : null
    body.signal = job.signal
    body.duration_ms = elapsedMs(job)
    body.peak_rss_mb = job.peakRssMb
    body.children = job.children
    body.enforcement = ENFORCEMENT
  }
  return body
}

function lostView(item: Lost): Record<string, unknown> {
  return {
    job_id: item.job_id,
    status: 'lost',
    text: '',
    cursor_start: 0,
    cursor: 0,
    total_chars: 0,
    chars_returned: 0,
    truncated: false,
    capped: false,
    eof: true,
    dropped_chars: 0,
    encoding_used: null,
    lossy: false,
    prompt_hint: null,
    log_path: item.log_path,
  }
}

async function sliceText(job: Job, start: number, maxChars: number): Promise<string> {
  const ringStart = job.totalChars - job.ringChars
  if (start >= ringStart) {
    const rel = start - ringStart
    return slicePoints(job.ring.join(''), rel, rel + maxChars)
  }
  return readLogChars(job, start, maxChars)
}

async function readLogChars(job: Job, start: number, maxChars: number): Promise<string> {
  if (start < job.readAt.char) job.readAt = { char: 0, byte: 0 }
  const handle = await open(job.logPath, 'r')
  try {
    const info = await handle.stat()
    const buf = Buffer.alloc(64 * 1024)
    let fileByte = job.readAt.byte
    let char = job.readAt.char
    let pending = Buffer.alloc(0)
    let pendingAt = fileByte
    let out = ''
    let outPoints = 0
    while (outPoints < maxChars) {
      if (pending.length < 8 && fileByte < info.size) {
        const n = Math.min(buf.length, info.size - fileByte)
        const { bytesRead } = await handle.read(buf, 0, n, fileByte)
        if (bytesRead <= 0) break
        fileByte += bytesRead
        pending = Buffer.concat([pending, buf.subarray(0, bytesRead)])
      }
      const step = nextUtf8(pending)
      if (!step) break
      if (char >= start) {
        out += step.char
        outPoints++
      }
      char += 1
      pending = pending.subarray(step.next)
      pendingAt += step.next
      if (char > start && outPoints >= maxChars) break
    }
    job.readAt = { char: start + outPoints, byte: pendingAt }
    return out
  } finally {
    await handle.close()
  }
}

function unitWidth(text: string, index: number): number {
  const code = text.charCodeAt(index)
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return 2
  }
  return 1
}

function countPoints(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += unitWidth(text, index)) count++
  return count
}

function slicePoints(text: string, start: number, end: number): string {
  if (start >= end) return ''
  let seen = 0
  let from = -1
  for (let index = 0; index < text.length; ) {
    if (seen === start) from = index
    if (seen === end) return text.slice(from, index)
    index += unitWidth(text, index)
    seen++
  }
  if (from < 0) return ''
  return text.slice(from)
}

function nextUtf8(buffer: Buffer): { char: string; next: number } | null {
  if (buffer.length === 0) return null
  const lead = buffer[0] ?? 0
  let need = 1
  if (lead < 0x80) need = 1
  else if ((lead & 0xe0) === 0xc0) need = 2
  else if ((lead & 0xf0) === 0xe0) need = 3
  else if ((lead & 0xf8) === 0xf0) need = 4
  else return { char: '\uFFFD', next: 1 }
  if (buffer.length < need) return null
  return { char: buffer.toString('utf8', 0, need), next: need }
}

function normalizeCursor(cursor: number, total: number): number {
  if (cursor < 0) {
    const resolved = total + cursor
    return resolved < 0 ? 0 : resolved
  }
  if (cursor > total) return 0
  return cursor
}

function jobRow(job: Job): Record<string, unknown> {
  return {
    job_id: job.job_id,
    name: job.name,
    status: job.status,
    pid: job.pid,
    command: job.command,
    cwd: job.cwd,
    tags: job.tags,
    started_at: job.startedAt,
    expires_at: job.expiresAt,
    elapsed_ms: elapsedMs(job),
    total_chars: job.totalChars,
    peak_rss_mb: job.peakRssMb,
    children: job.children,
    log_path: job.logPath,
    last_output_at: new Date(job.lastOutputAt).toISOString(),
    prompt_hint: hintFor(job),
  }
}

function requireJob(id: string): Job {
  const mine = currentBucket()
  const job = mine.jobs.get(id)
  if (job) return job
  const archived = mine.gone.get(id)
  if (archived) {
    raise('E_JOB_GONE', 'The retention window for this job has passed. It is no longer in memory.', 'Read the log file with fs_read.', { log_path: archived })
  }
  if (mine.lost.has(id)) raise('E_NOT_FOUND', 'This job was lost at restart. Only the log file remains.', undefined, { log_path: mine.lost.get(id)?.log_path })
  raise('E_NOT_FOUND', 'No such job_id.')
}

function reqId(args: Args): string {
  const id = optString(args, 'job_id')
  if (!id) raise('E_INVALID_ARG', 'Missing job_id.')
  return id
}

function newId(): string {
  let id = ''
  do id = `j_${randomBytes(4).toString('hex')}`
  while (idTaken(id))
  return id
}

function idTaken(id: string): boolean {
  for (const bucket of buckets.values()) {
    if (bucket.jobs.has(id) || bucket.lost.has(id)) return true
  }
  return false
}

function liveCount(): number {
  let count = 0
  for (const job of allJobs()) if (isLive(job.status)) count++
  return count
}

function tagGroups(): Record<string, number> {
  const key = currentKey()
  const groups: Record<string, number> = {}
  for (const [bucketKey, bucket] of buckets) {
    for (const job of bucket.jobs.values()) {
      if (!isLive(job.status)) continue
      const label = bucketKey === key ? (job.tags.project ?? job.tags.bot ?? '(none)') : '(other)'
      groups[label] = (groups[label] ?? 0) + 1
    }
  }
  return groups
}

function parseTags(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) raise('E_INVALID_ARG', 'tags must be an object.')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 16) raise('E_INVALID_ARG', 'tags accepts at most 16 pairs.')
  const tags: Record<string, string> = {}
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > 32 || !TAG_TEXT.test(key)) raise('E_INVALID_ARG', `Invalid tags key: ${key}.`)
    if (typeof item !== 'string' || item.length === 0 || item.length > 128 || !TAG_TEXT.test(item)) {
      raise('E_INVALID_ARG', `Invalid tags value: ${key}.`)
    }
    tags[key] = item
  }
  return tags
}

function tagsMatch(tags: Record<string, string>, filter: Record<string, string>): boolean {
  return Object.entries(filter).every(([key, value]) => tags[key] === value)
}

function resolveCwd(cwd: string | undefined): string {
  const target = cwd ? path.resolve(cwd) : process.cwd()
  if (!existsSync(target)) raise('E_NOT_FOUND', 'cwd does not exist.', 'Pass a directory that already exists.')
  return target
}

function argvCommand(args: Args): string {
  const program = reqProgram(args)
  const list = argList(args)
  return [program, ...list].join(' ')
}

function shellCommand(args: Args): string {
  const interpreter = optString(args, 'interpreter')
  const script = optString(args, 'script')
  if (!interpreter || script === undefined) raise('E_INVALID_ARG', 'shell mode requires interpreter and script.')
  const shown = script.length > 400 ? `${script.slice(0, 400)}…` : script
  return `${interpreter}: ${shown}`
}

function reqProgram(args: Args): string {
  const program = optString(args, 'program')
  if (!program) raise('E_INVALID_ARG', 'argv mode requires program.')
  return program
}

function argList(args: Args): string[] {
  if (!('args' in args) || args.args === undefined) return []
  if (!Array.isArray(args.args) || args.args.some((item) => typeof item !== 'string')) {
    raise('E_INVALID_ARG', 'args must be an array of strings.')
  }
  return args.args as string[]
}

function spawnArgv(args: Args, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const program = reqProgram(args)
  const resolved = resolveProgram(program)
  if (!resolved) raise('E_NOT_FOUND', `Program not found: ${program}.`, 'A bare name is resolved on PATH only, not in the current directory.')
  return spawnCommand(resolved, argList(args), cwd, env)
}

async function spawnShell(args: Args, cwd: string, env: NodeJS.ProcessEnv, tmp: string): Promise<ChildProcess> {
  const interpreter = optString(args, 'interpreter')
  const script = optString(args, 'script')
  if (!interpreter || script === undefined) raise('E_INVALID_ARG', 'shell mode requires interpreter and script.')
  const available = availableInterpreters()
  if (!available.includes(interpreter)) {
    raise('E_INVALID_ARG', `Interpreter is not available here: ${interpreter}.`, `Available: ${available.join(', ') || 'none'}`)
  }
  const exe = interpreterPath(interpreter)
  if (!exe) raise('E_NOT_FOUND', `Interpreter not found: ${interpreter}.`)
  if (interpreter === 'powershell' || interpreter === 'pwsh') {
    await mkdir(tmp, { recursive: true })
    const file = path.join(tmp, `${newId()}.ps1`)
    const { writeFile } = await import('node:fs/promises')
    const body =
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n" +
      "$OutputEncoding = [Console]::OutputEncoding\n" +
      "$ProgressPreference = 'SilentlyContinue'\n" +
      script
    await writeFile(file, `\uFEFF${body}`, 'utf8')
    return spawn(exe, ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-File', file], spawnOpts(cwd, env))
  }
  await mkdir(tmp, { recursive: true })
  const file = path.join(tmp, `${newId()}${scriptExt(interpreter)}`)
  const { writeFile } = await import('node:fs/promises')
  if (interpreter === 'cmd') {
    // cmd converts its command line to the OEM code page before chcp runs.
    // Switch the code page from an ASCII launcher, then call the UTF-8 script.
    const launcher = path.join(tmp, `${newId()}.cmd`)
    await writeFile(file, script.replaceAll('\n', '\r\n'), 'utf8')
    await writeFile(launcher, `@echo off\r\nchcp 65001 >nul\r\ncall "${file}"\r\n`, 'ascii')
    return spawnCommand(exe, ['/d', '/s', '/c', launcher], cwd, env)
  }
  await writeFile(file, script, 'utf8')
  return spawn(exe, [file], spawnOpts(cwd, env))
}

function scriptExt(interpreter: string): string {
  if (interpreter === 'cmd') return '.cmd'
  if (interpreter === 'powershell' || interpreter === 'pwsh') return '.ps1'
  if (interpreter === 'python' || interpreter === 'python3') return '.py'
  if (interpreter === 'node') return '.js'
  return '.sh'
}

function spawnCommand(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const cmd = /(?:^|\\)cmd\.exe$/i.test(exe)
  if (cmd && process.platform === 'win32') {
    return spawn(exe, [args.map(quoteCmd).join(' ')], { ...spawnOpts(cwd, env), windowsVerbatimArguments: true })
  }
  return spawn(exe, args, spawnOpts(cwd, env))
}

function quoteCmd(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"&|<>^]/.test(arg)) return arg
  return `"${arg.replaceAll('"', '""')}"`
}

function spawnOpts(cwd: string, env: NodeJS.ProcessEnv): {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  windowsHide: true
  detached: boolean
  stdio: ['pipe', 'pipe', 'pipe']
} {
  return {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  }
}

function writeStdin(job: Job, payload: Buffer): Promise<void> {
  const stdin = job.child?.stdin
  if (!stdin) return Promise.reject(new Error('closed'))
  return new Promise((resolve, reject) => {
    stdin.write(payload, (error) => (error ? reject(error) : resolve()))
  })
}

function closeStdinOf(job: Job): void {
  if (job.stdinClosed) return
  job.stdinClosed = true
  job.child?.stdin?.end()
}

function parseHex(value: unknown): Buffer {
  if (typeof value !== 'string') raise('E_INVALID_ARG', 'input_hex must be a hexadecimal string.')
  const compact = value.replace(/\s+/g, '').toLowerCase()
  if (compact.length % 2 !== 0 || !/^[0-9a-f]*$/.test(compact)) {
    raise('E_INVALID_ARG', 'input_hex must be hexadecimal with an even length.')
  }
  return Buffer.from(compact, 'hex')
}

function buildEnv(value: unknown, mode: string): NodeJS.ProcessEnv {
  if (mode !== 'merge' && mode !== 'replace') raise('E_INVALID_ARG', 'env_mode must be merge or replace.')
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
    raise('E_INVALID_ARG', 'env must be an object.')
  }
  const base: NodeJS.ProcessEnv = {}
  if (mode === 'merge') {
    for (const [key, item] of Object.entries(process.env)) if (item !== undefined) base[key] = item
  } else {
    for (const key of [
      'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'TEMP', 'TMP',
      'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
      'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    ]) {
      if (process.env[key]) base[key] = process.env[key]
    }
  }
  if (process.platform === 'win32' && !base.ProgramData) {
    base.ProgramData = path.join(process.env.SystemDrive || 'C:', 'ProgramData')
  }
  if (process.platform === 'win32') base.PATHEXT = repairedExt(base.PATHEXT)
  if (!base.PYTHONUTF8) base.PYTHONUTF8 = '1'
  if (!base.PYTHONIOENCODING) base.PYTHONIOENCODING = 'utf-8'
  if (!base.PYTHONUNBUFFERED) base.PYTHONUNBUFFERED = '1'
  base.FORCE_COLOR = '0'
  base.TERM = 'dumb'
  base.NO_COLOR = '1'
  for (const [key, item] of Object.entries((value as Record<string, unknown> | undefined) ?? {})) {
    if (typeof item !== 'string') raise('E_INVALID_ARG', `env.${key} must be a string.`)
    base[key] = item
  }
  return base
}

function repairedExt(current: string | undefined): string {
  const fallback = DEFAULT_EXT.join(';')
  if (!current) return fallback
  const upper = current.split(';').map((item) => item.toUpperCase())
  if (!upper.includes('.EXE') || !upper.includes('.CMD')) return fallback
  return current
}

function resolveProgram(name: string): string | null {
  if (name.includes('/') || name.includes('\\') || path.isAbsolute(name)) {
    const full = path.resolve(name)
    return existsSync(full) ? full : null
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => {
    if (!dir || dir === '.') return false
    try {
      return path.resolve(dir) !== path.resolve(process.cwd())
    } catch {
      return false
    }
  })
  const exts = process.platform === 'win32' && path.extname(name) === '' ? ['', ...pathExts()] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, ext ? name + ext : name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function pathExts(): string[] {
  const raw = process.env.PATHEXT
  if (!raw) return DEFAULT_EXT
  const parts = raw.split(';').filter(Boolean)
  const upper = parts.map((item) => item.toUpperCase())
  if (!upper.includes('.EXE') || !upper.includes('.CMD')) return DEFAULT_EXT
  return parts
}

let interpreterCache: string[] | null = null

function availableInterpreters(): string[] {
  if (interpreterCache) return interpreterCache
  const names = process.platform === 'win32'
    ? ['cmd', 'powershell', 'pwsh', 'bash', 'python', 'python3', 'node']
    : process.platform === 'darwin'
      ? ['sh', 'bash', 'zsh', 'fish', 'python', 'python3', 'node']
      : ['sh', 'bash', 'zsh', 'fish', 'dash', 'python', 'python3', 'node']
  interpreterCache = names.filter((name) => interpreterPath(name))
  return interpreterCache
}

function interpreterPath(name: string): string | null {
  if (process.platform === 'win32' && name === 'cmd') return systemExe('System32\\cmd.exe')
  if (process.platform === 'win32' && name === 'powershell') {
    return systemExe('System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  }
  return resolveProgram(name)
}

function systemExe(relative: string): string | null {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const full = path.join(root, relative)
  return existsSync(full) ? full : null
}

async function sampleJobs(): Promise<void> {
  const live = allJobs().filter((job) => isLive(job.status) && job.pid)
  if (live.length === 0) return
  const snap = await processSnapshot()
  for (const job of live) {
    if (!job.pid) continue
    const tree = collectTree(snap, job.pid)
    job.children = countInTree(snap, tree, job.pid)
    const rss = tree.reduce((sum, pid) => sum + (snap.get(pid)?.rss ?? 0), 0)
    const mb = rss / (1024 * 1024)
    if (mb > 0) job.peakRssMb = Math.max(job.peakRssMb ?? 0, Math.round(mb * 10) / 10)
    if (job.memLimitMb !== null && mb > job.memLimitMb && !job.killReason) {
      job.killReason = 'mem'
      void killJob(job, 200)
    }
  }
}

async function processSnapshot(): Promise<Map<number, ProcInfo>> {
  if (snapCache && Date.now() - snapCache.at < 800) return snapCache.map
  const map = process.platform === 'win32' ? await windowsSnapshot() : await posixSnapshot()
  snapCache = { at: Date.now(), map }
  return map
}

async function windowsSnapshot(): Promise<Map<number, ProcInfo>> {
  const stdout = await execBuffer('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name | ConvertTo-Json -Compress',
  ])
  const text = decodeCaptured(stdout).trim()
  if (!text) return new Map()
  const parsed = JSON.parse(text) as
    | { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; Name?: string }
    | { ProcessId: number; ParentProcessId: number; WorkingSetSize: number; Name?: string }[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const map = new Map<number, ProcInfo>()
  for (const row of rows) {
    map.set(Number(row.ProcessId), {
      ppid: Number(row.ParentProcessId),
      rss: Number(row.WorkingSetSize) || 0,
      name: String(row.Name ?? ''),
      state: '',
    })
  }
  return map
}

async function posixSnapshot(): Promise<Map<number, ProcInfo>> {
  const map = new Map<number, ProcInfo>()
  let names: string[] = []
  try {
    names = await readdir('/proc')
  } catch {
    return map
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const raw = await readFile(`/proc/${name}/stat`, 'utf8')
      const cut = raw.lastIndexOf(')')
      const rest = raw.slice(cut + 2).split(' ')
      map.set(Number(name), { ppid: Number(rest[1]), rss: Number(rest[21]) * 4096, name: '', state: rest[0] ?? '' })
    } catch {
      // The process exited during the snapshot.
    }
  }
  return map
}

function collectTree(snap: Map<number, ProcInfo>, root: number): number[] {
  const children = new Map<number, number[]>()
  for (const [pid, info] of snap) {
    const list = children.get(info.ppid) ?? []
    list.push(pid)
    children.set(info.ppid, list)
  }
  const out: number[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    if (seen.has(pid)) continue
    seen.add(pid)
    if (pid !== root && !snap.has(pid)) continue
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

function countInTree(snap: Map<number, ProcInfo>, tree: number[], root: number): number {
  let count = 0
  for (const pid of tree) {
    if (pid === root) continue
    const info = snap.get(pid)
    if (!info || info.state === 'Z' || info.state === 'X') continue
    if (info.name.toLowerCase() === 'conhost.exe') continue
    count++
  }
  return count
}

async function descendants(pid: number): Promise<number> {
  try {
    const snap = await processSnapshot()
    return Math.max(0, collectTree(snap, pid).length - 1)
  } catch {
    return 0
  }
}

async function killTree(pid: number, grace: number): Promise<{ escalated: boolean; remaining: number }> {
  const wait = grace > 0 ? delay(Math.min(grace, 5000)) : Promise.resolve()
  if (process.platform === 'win32') {
    await taskkillTree(pid)
    await wait
    snapCache = null
    let remaining = (pidAlive(pid) ? 1 : 0) + (await descendants(pid))
    if (remaining === 0) return { escalated: true, remaining: 0 }
    await taskkillTree(pid)
    await delay(200)
    snapCache = null
    remaining = (pidAlive(pid) ? 1 : 0) + (await descendants(pid))
    return { escalated: true, remaining }
  }
  snapCache = null
  const members = collectTree(await processSnapshot(), pid)
  signalGroup(pid, 'SIGTERM')
  await wait
  snapCache = null
  let remaining = aliveCount(await processSnapshot(), members)
  if (remaining === 0) return { escalated: false, remaining: 0 }
  signalGroup(pid, 'SIGKILL')
  for (const member of members) signalOne(member, 'SIGKILL')
  await delay(100)
  snapCache = null
  remaining = aliveCount(await processSnapshot(), members)
  return { escalated: true, remaining }
}

function aliveCount(snap: Map<number, ProcInfo>, pids: number[]): number {
  let count = 0
  for (const pid of pids) {
    const info = snap.get(pid)
    if (!info || info.state === 'Z' || info.state === 'X') continue
    count++
  }
  return count
}

function signalOne(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(pid, signal) } catch { /* already exited */ }
}

function taskkillTree(pid: number): Promise<void> {
  return execBuffer('taskkill.exe', ['/pid', String(pid), '/T', '/F']).then(() => undefined).catch(() => undefined)
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try { process.kill(pid, signal) } catch { /* already exited */ }
  }
}

function execBuffer(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error && !stdout) reject(error)
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
    })
  })
}

function decodeCaptured(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[1] === 0) return buffer.toString('utf16le')
  return buffer.toString('utf8')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
