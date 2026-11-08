import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { open, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import type { Client } from '@modelcontextprotocol/client'
import type { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { call, removeHome, startStdio, tempHome, unwrap } from './helpers.ts'

const exec = promisify(execFile)
let client: Client
let transport: StdioClientTransport
let home = ''

before(async () => {
  home = await tempHome()
  const started = await startStdio(home)
  client = started.client
  transport = started.transport
})

after(async () => {
  await client?.close().catch(() => undefined)
  await removeHome(home)
})

function file(...parts: string[]): string {
  return path.join(home, ...parts)
}

test('BOM and CRLF round-trip as bytes', async () => {
  const target = file('bom.txt')
  const written = unwrap(await call(client, 'fs_write', {
    path: target,
    text: '甲\r\n乙\r\n',
    encoding: 'utf-8',
    preserve: { bom: 'add', eol: 'as_is' },
  }))
  const hex = unwrap(await call(client, 'fs_read', { path: target, mode: 'hex' }))
  assert.equal(hex.hex.startsWith('efbbbf'), true)
  assert.match(hex.hex, /0d0a/)
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.bom, true)
  assert.equal(text.text, '甲\r\n乙\r\n')
  assert.equal(text.hash, written.hash_after)
  assert.equal(written.verified, true)
})

test('append does not add a newline', async () => {
  const target = file('append.txt')
  const created = unwrap(await call(client, 'fs_write', { path: target, text: 'a' }))
  const joined = unwrap(await call(client, 'fs_splice', {
    path: target,
    offset: 'end',
    insert: '\r\nb',
    expect_hash: created.hash_after,
  }))
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.text, 'a\r\nb')
  const stuck = unwrap(await call(client, 'fs_splice', {
    path: target,
    offset: 'end',
    insert: 'c',
    expect_hash: joined.hash_after,
  }))
  const again = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(again.text, 'a\r\nbc')
  assert.equal(stuck.verified, true)
})

test('a stale hash is rejected and the file is unchanged', async () => {
  const target = file('hash.txt')
  const created = unwrap(await call(client, 'fs_write', { path: target, text: 'AAA' }))
  const rejected = await call(client, 'fs_write', {
    path: target,
    text: 'BBB',
    expect_hash: '000000',
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error?.code, 'E_HASH_MISMATCH')
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.text, 'AAA')
  assert.equal(text.hash, created.hash_after)
})

test('the hash after a write matches an independent read', async () => {
  const target = file('verify.txt')
  const written = unwrap(await call(client, 'fs_write', { path: target, text: 'verified\n' }))
  const stat = unwrap(await call(client, 'fs_stat', { paths: [target] }))
  const read = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(written.verified, true)
  assert.equal(written.hash_after, read.hash)
  assert.equal(stat.entries[0].hash, written.hash_after)
})

test('binary hex round-trips', async () => {
  const target = file('random.bin')
  const hex = randomBytes(1024).toString('hex')
  const written = unwrap(await call(client, 'fs_write', { path: target, hex }))
  const read = unwrap(await call(client, 'fs_read', { path: target, mode: 'hex' }))
  assert.equal(read.hex, hex)
  assert.equal(read.hash, written.hash_after)
})

test('concurrent reads see a complete old or new version', async () => {
  const target = file('atomic.txt')
  const chunkA = 'A'.repeat(64 * 1024)
  const chunkB = 'B'.repeat(64 * 1024)
  unwrap(await call(client, 'fs_write', { path: target, text: chunkA }))
  let bad = 0
  const writer = (async () => {
    for (let i = 0; i < 12; i++) {
      await call(client, 'fs_write', { path: target, text: i % 2 === 0 ? chunkA : chunkB })
    }
  })()
  const reader = (async () => {
    for (let i = 0; i < 24; i++) {
      const body = await call(client, 'fs_read', { path: target, mode: 'text' })
      if (!body.ok) continue
      const text = String(body.data?.text ?? '')
      if (text !== chunkA && text !== chunkB) bad++
    }
  })()
  await Promise.all([writer, reader])
  assert.equal(bad, 0)
})

test('a missing parent directory is created', async () => {
  const target = file('新目录', 'a.txt')
  const written = unwrap(await call(client, 'fs_write', { path: target, text: 'ok' }))
  assert.equal(written.created, true)
  assert.ok((written.dirs_created as string[]).some((dir) => dir.includes('新目录')))
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.text, 'ok')
})

test('non-ASCII paths and paths with spaces can be read and written', async () => {
  const target = file('中文 目录', '文件 名.txt')
  unwrap(await call(client, 'fs_write', { path: target, text: '你好\r\n' }))
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.text, '你好\r\n')
})

test('non-ASCII command output is not corrupted', async () => {
  const fromNode = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "console.log('中文')"],
    timeout: 10000,
  }))
  assert.match(fromNode.text, /中文/)
  assert.equal(fromNode.encoding_used, 'utf-8')
  assert.equal(fromNode.lossy, false)
  const shell = process.platform === 'win32'
    ? { interpreter: 'cmd', script: 'echo 中文' }
    : { interpreter: 'sh', script: "printf '%s\\n' '中文'" }
  const fromCmd = unwrap(await call(client, 'exec', {
    mode: 'shell',
    ...shell,
    timeout: 10000,
  }))
  assert.match(String(fromCmd.text), /中文/)
})

test('GBK bytes do not fail the call when decoding is imperfect', async () => {
  const script = file('gbk-out.cjs')
  await writeFile(script, "require('fs').writeSync(1, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))\n")
  const result = await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: [script],
    timeout: 10000,
  })
  assert.equal(result.ok, true, result.error?.message ?? '')
  assert.equal(typeof result.data?.encoding_used, 'string')
  assert.equal(result.data?.text.includes('\uFFFD') || result.data?.text.includes('中文'), true)
})

test('a binary edit of an existing file requires expect_hash', async () => {
  const target = file('need-hash.bin')
  const created = unwrap(await call(client, 'fs_write', { path: target, hex: '0001' }))
  const spliced = await call(client, 'fs_splice', { path: target, offset: 'end', insert_hex: 'ff' })
  assert.equal(spliced.ok, false)
  assert.equal(spliced.error?.code, 'E_HASH_REQUIRED')
  assert.equal(spliced.error?.context?.hash, created.hash_after)
  assert.equal(spliced.error?.context?.size, 2)
  const overwritten = await call(client, 'fs_write', { path: target, hex: 'ffff' })
  assert.equal(overwritten.ok, false)
  assert.equal(overwritten.error?.code, 'E_HASH_REQUIRED')
})

test('the same server lists tags and the log path', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', 'setInterval(()=>{}, 1e9)'],
    name: 'visible',
    timeout: 0,
    ttl_ms: 60_000,
    tags: { project: 'finch', bot: 'test' },
  }))
  const listed = unwrap(await call(client, 'job_list', { tags: { project: 'finch' } }))
  const found = (listed.jobs as { job_id: string; name: string; tags: { bot: string }; log_path: string }[])
    .find((item) => item.job_id === job.job_id)
  assert.ok(found)
  assert.equal(found?.name, 'visible')
  assert.equal(found?.tags.bot, 'test')
  assert.equal(found?.log_path, job.log_path)
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('kill takes child processes with it', async () => {
  const pidfile = file('pids.json')
  const script = file('tree.cjs')
  await writeFile(script, `
    const { spawn } = require('child_process')
    const fs = require('fs')
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1e9)'], { stdio: 'ignore' })
    fs.writeFileSync(process.env.PIDFILE, JSON.stringify({ parent: process.pid, child: child.pid }))
    setInterval(() => {}, 1e9)
  `)
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: [script],
    env: { PIDFILE: pidfile },
    timeout: 3000,
    ttl_ms: 60_000,
  }))
  const raw = await import('node:fs/promises').then((fs) => fs.readFile(pidfile, 'utf8'))
  const pids = JSON.parse(raw) as { parent: number; child: number }
  const killed = await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 })
  assert.equal(killed.ok, true, killed.error?.message ?? '')
  for (const pid of [pids.parent, pids.child]) {
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    assert.equal(alive, false, `pid ${pid} still alive`)
  }
})

test('other calls stay fast after a long wait returns', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', 'setInterval(()=>{}, 1e9)'],
    timeout: 200,
    ttl_ms: 60_000,
    tags: { project: 'block' },
  }))
  assert.equal(job.status === 'running' || job.status === 'standing_by', true)
  const started = Date.now()
  const text = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "console.log('fast')"],
    timeout: 10000,
  }))
  assert.match(text.text, /fast/)
  assert.ok(Date.now() - started < 8000)
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('two writers with the same old hash, only one succeeds', async () => {
  const target = file('race.txt')
  const created = unwrap(await call(client, 'fs_write', { path: target, text: 'A' }))
  const [left, right] = await Promise.all([
    call(client, 'fs_write', { path: target, text: 'B', expect_hash: created.hash_after }),
    call(client, 'fs_write', { path: target, text: 'C', expect_hash: created.hash_after }),
  ])
  const wins = [left, right].filter((item) => item.ok)
  const losses = [left, right].filter((item) => !item.ok)
  assert.equal(wins.length, 1)
  assert.equal(losses.length, 1)
  assert.equal(losses[0]?.error?.code, 'E_HASH_MISMATCH')
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(text.text === 'B' || text.text === 'C', true)
})

test('paging a 500 MB file does not inflate process memory', { timeout: 180_000 }, async () => {
  const target = file('big.bin')
  const handle = await open(target, 'w')
  const chunk = Buffer.alloc(1024 * 1024, 0x61)
  for (let i = 0; i < 500; i++) await handle.write(chunk)
  await handle.close()
  const beforeRss = await rssOfServer()
  const stat = unwrap(await call(client, 'fs_stat', { paths: [target], hash: true }))
  assert.equal(stat.entries[0].hash, null)
  assert.equal(stat.entries[0].hash_skipped, 'too_large')
  const head = unwrap(await call(client, 'fs_read', { path: target, mode: 'hex', offset: 0, length: 8 }))
  assert.equal(head.hex, '6161616161616161')
  assert.equal(head.hash, undefined)
  const tail = unwrap(await call(client, 'fs_read', { path: target, mode: 'hex', offset: -4, length: 4 }))
  assert.equal(tail.hex, '61616161')
  assert.equal(tail.eof, true)
  const afterRss = await rssOfServer()
  assert.ok(afterRss - beforeRss < 80 * 1024 * 1024, `rss grew ${afterRss - beforeRss}`)
})

test('tty is rejected', async () => {
  const result = await call(client, 'exec', { mode: 'argv', program: 'node', args: ['-e', '0'], tty: true })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'E_TTY_UNAVAILABLE')
  const unknown = await call(client, 'fs_stat', { paths: [file('missing-unknown.txt')], extra: 1 })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error?.code, 'E_INVALID_ARG')
})

test('long output can be read by cursor and matches the log', { timeout: 180_000 }, async () => {
  const script = file('flood.cjs')
  await writeFile(script, "const chunk = 'x'.repeat(100000); for (let i = 0; i < 80; i++) process.stdout.write(chunk)\n")
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: [script],
    timeout: 30000,
  }))
  assert.equal(job.status, 'finished')
  let cursor = 0
  let merged = ''
  for (let i = 0; i < 600; i++) {
    const page = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor, max_chars: 16384 }))
    assert.ok(page.text.length <= 16384)
    assert.equal(page.text.length, page.chars_returned)
    merged += page.text
    cursor = page.cursor
    if (page.eof && page.truncated === false) break
  }
  const log = await import('node:fs/promises').then((fs) => fs.readFile(job.log_path, 'utf8'))
  assert.equal(merged, log)
  assert.equal(merged.length, 8_000_000)
})

test('exact text replacement', async () => {
  const target = file('config.json')
  const created = unwrap(await call(client, 'fs_write', {
    path: target,
    text: '{ "port": 8080 }\n',
    preserve: { eol: 'as_is', bom: 'strip' },
  }))
  const patched = unwrap(await call(client, 'fs_patch', {
    path: target,
    expect_hash: created.hash_after,
    edits: [{ old_text: '"port": 8080', new_text: '"port": 9090', count: 1 }],
  }))
  assert.equal(patched.verified, true)
  const text = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.match(text.text, /9090/)
  assert.equal(text.hash, patched.hash_after)
})

test('stdin can be written after the job goes quiet', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('? '); let s=''; process.stdin.on('data', d => { s += d; if (s.includes('\\n')) { process.stdout.write('got:' + s); process.exit(0) } })"],
    timeout: 4000,
    ttl_ms: 30_000,
  }))
  assert.equal(job.status, 'standing_by')
  const sent = unwrap(await call(client, 'job_send', {
    job_id: job.job_id,
    input: 'y\n',
    cursor: job.cursor,
    wait_ms: 5000,
  }))
  assert.match(sent.text, /got:y/)
})

async function rssOfServer(): Promise<number> {
  const pid = transport.pid ?? process.pid
  if (process.platform !== 'win32') {
    const stat = await import('node:fs/promises').then((fs) => fs.readFile(`/proc/${pid}/stat`, 'utf8'))
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(rest[21] ?? 0) * 4096
  }
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-Process -Id ${pid}).WorkingSet64`,
  ], { windowsHide: true })
  const digits = String(stdout).replace(/\D/g, '')
  return Number(digits || 0)
}
