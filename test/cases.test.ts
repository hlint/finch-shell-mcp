import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/client'
import { call, removeHome, startStdio, tempHome, unwrap, type ToolBody } from './helpers.ts'

let client: Client
let home = ''

before(async () => {
  home = await tempHome()
  client = (await startStdio(home)).client
})

after(async () => {
  await client?.close().catch(() => undefined)
  await removeHome(home)
})

function file(...parts: string[]): string {
  return path.join(home, ...parts)
}

async function expectCode(name: string, args: Record<string, unknown>, code: string): Promise<ToolBody> {
  const body = await call(client, name, args)
  assert.equal(body.ok, false, JSON.stringify(body))
  assert.equal(body.error?.code, code, body.error?.message ?? '')
  return body
}

async function commandLines(marker: string): Promise<string> {
  const stdout = await new Promise<string>((resolve) => {
    const command = process.platform === 'win32' ? 'powershell.exe' : 'ps'
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine']
      : ['-eo', 'args=']
    execFile(command, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (_error, out) => resolve(String(out ?? '')))
  })
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.includes(marker) && !line.includes('Get-CimInstance'))
    .join('\n')
}

test('T-R-01 PowerShell output has no CLIXML', { skip: process.platform !== 'win32' }, async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'shell',
    interpreter: 'powershell',
    script: "Write-Output 'hello-only'",
    timeout: 20000,
  }))
  assert.equal(result.text.includes('#< CLIXML'), false)
  assert.equal(result.text.includes('<Objs'), false)
  assert.match(result.text, /hello-only/)
})

test('T-R-02 Write-Error is not wrapped in XML', { skip: process.platform !== 'win32' }, async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'shell',
    interpreter: 'powershell',
    script: "Write-Error 'boom'",
    timeout: 20000,
  }))
  assert.equal(result.text.includes('#< CLIXML'), false)
  assert.equal(result.text.includes('<Objs'), false)
  assert.match(result.text, /boom/)
})

test('T-R-03 job_list.command keeps newlines', async () => {
  const shell = process.platform === 'win32'
    ? { interpreter: 'powershell', script: "Write-Output 'one'\nWrite-Output 'two'\nWrite-Output 'three'" }
    : { interpreter: 'sh', script: "printf '%s\\n' one\nprintf '%s\\n' two\nprintf '%s\\n' three" }
  const result = unwrap(await call(client, 'exec', {
    mode: 'shell',
    ...shell,
    timeout: 20000,
  }))
  const listed = unwrap(await call(client, 'job_list', { include_finished: true }))
  const row = (listed.jobs as { job_id: string; command: string }[]).find((item) => item.job_id === result.job_id)
  assert.ok(row)
  assert.match(row.command, process.platform === 'win32'
    ? /Write-Output 'one'\nWrite-Output 'two'\nWrite-Output 'three'/
    : /printf '%s\\n' one\nprintf '%s\\n' two\nprintf/)
})

test('T-R-04 capped and truncated can both be true', async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('x'.repeat(100))"],
    timeout: 10000,
  }))
  const page = unwrap(await call(client, 'job_read', { job_id: result.job_id, cursor: 0, max_chars: 10 }))
  assert.equal(page.capped, true)
  assert.equal(page.truncated, true)
  const tail = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('y'.repeat(5000))"],
    timeout: 10000,
  }))
  assert.equal(tail.capped, true)
  assert.equal(tail.truncated, false)
})

test('T-R-05 elapsed_ms freezes after a terminal state', async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('done')"],
    timeout: 10000,
  }))
  const listed = unwrap(await call(client, 'job_list', { include_finished: true }))
  const row = (listed.jobs as { job_id: string; elapsed_ms: number }[]).find((item) => item.job_id === result.job_id)
  assert.ok(row)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const again = unwrap(await call(client, 'job_list', { include_finished: true }))
  const later = (again.jobs as { job_id: string; elapsed_ms: number }[]).find((item) => item.job_id === result.job_id)
  assert.equal(later?.elapsed_ms, row.elapsed_ms)
})

test('T-R-06 children is the live count and is zero after kill', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'}); process.stdout.write('up\\n'); setInterval(()=>{},1e9)"],
    timeout: 4000,
    ttl_ms: 60_000,
  }))
  const listed = unwrap(await call(client, 'job_list', {}))
  const row = (listed.jobs as { job_id: string; children: number }[]).find((item) => item.job_id === job.job_id)
  assert.equal(row?.children, 1)
  const killed = unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
  assert.equal(killed.remaining_children, 0)
  const finished = unwrap(await call(client, 'job_list', { include_finished: true }))
  const afterKill = (finished.jobs as { job_id: string; children: number }[]).find((item) => item.job_id === job.job_id)
  assert.equal(afterKill?.children, 0)
})

test('T-R-07 fs_read returns offset_aligned and the contract names both edges', async () => {
  const target = file('aligned.txt')
  unwrap(await call(client, 'fs_write', { path: target, text: '甲' }))
  const page = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(typeof page.offset_aligned, 'boolean')
  assert.equal(page.offset_aligned, true)
  const doc = await readFile(new URL('../docs/01-contract.md', import.meta.url), 'utf8')
  assert.match(doc, /offset_aligned/)
  assert.match(doc, /start and the end/)
})

test('T-C-01 an emoji counts as one code point', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('A中B文C🚀D\\r\\n')"],
    timeout: 10000,
  }))
  assert.equal(job.total_chars, 9)
})

test('T-C-02 a cursor does not split a surrogate pair', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('A中B文C🚀D\\r\\n')"],
    timeout: 10000,
  }))
  const atFive = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 5 }))
  const atSix = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 6 }))
  const tail = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: -3 }))
  assert.equal(atFive.text, '🚀D\r\n')
  assert.equal(atSix.text, 'D\r\n')
  assert.equal(tail.text, 'D\r\n')
})

test('T-C-03 a negative cursor counts code points', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('A中B文C🚀D\\r\\n')"],
    timeout: 10000,
  }))
  const tail = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: -3 }))
  assert.equal(tail.cursor_start, 6)
  assert.equal(tail.text, 'D\r\n')
})

test('T-C-04 / T-S-08 a full ring can still be read from cursor 0', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('HEAD\\n'); const chunk='x'.repeat(100000); for (let i=0;i<21;i++) process.stdout.write(chunk); process.stdout.write('\\nTAIL')"],
    timeout: 30000,
  }))
  assert.ok(job.dropped_chars > 0, `dropped_chars=${job.dropped_chars}`)
  const head = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 0, max_chars: 16 }))
  assert.equal(head.text.startsWith('HEAD\n'), true)
  assert.equal(head.dropped_chars > 0, true)
  const doc = await readFile(new URL('../docs/01-contract.md', import.meta.url), 'utf8')
  assert.match(doc, /dropped_chars/)
  assert.match(doc, /does not mean/)
})

test('T-C-05 fs_read offset and length are bytes', async () => {
  const target = file('bytes.txt')
  unwrap(await call(client, 'fs_write', { path: target, text: 'A中B', preserve: { eol: 'as_is' } }))
  const page = unwrap(await call(client, 'fs_read', {
    path: target,
    mode: 'text',
    encoding: 'utf-8',
    offset: 1,
    length: 3,
  }))
  assert.equal(page.bytes_read, 3)
  assert.equal(page.text, '中')
  await expectCode('fs_read', { path: target, offset: 99 }, 'E_RANGE')
})

test('T-S-01 ttl_ms expiry becomes timeout and keeps output', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "let n=0; setInterval(()=>{ process.stdout.write('L'+n+'\\n'); n++ }, 100)"],
    ttl_ms: 4000,
    grace_ms: 200,
    timeout: 15000,
  }))
  assert.equal(job.status, 'timeout')
  assert.match(job.text, /L\d+/)
})

test('T-S-02 exceeding mem_limit_mb sets status to killed', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "const b=Buffer.alloc(200*1024*1024); b.fill(1); setInterval(()=>{},1e9)"],
    mem_limit_mb: 80,
    ttl_ms: 60_000,
    grace_ms: 200,
    timeout: 25000,
  }))
  assert.equal(job.status, 'killed')
})

test('T-S-03 a write after close_after is E_STDIN_CLOSED', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdin.on('end',()=>process.stdout.write('EOF reached\\n')); process.stdin.resume(); setInterval(()=>{},1e9)"],
    timeout: 4000,
    ttl_ms: 60_000,
  }))
  unwrap(await call(client, 'job_send', { job_id: job.job_id, input: 'hi', cursor: 0, close_after: true, wait_ms: 5000 }))
  const ready = unwrap(await call(client, 'job_read', { job_id: job.job_id, wait_ms: 5000 }))
  assert.equal(ready.status, 'standing_by')
  await expectCode('job_send', { job_id: job.job_id, input: 'again', cursor: ready.cursor }, 'E_STDIN_CLOSED')
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('T-S-04 closing stdin makes the reader see EOF', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdin.on('end',()=>process.stdout.write('EOF reached\\n')); process.stdin.resume(); setInterval(()=>{},1e9)"],
    timeout: 4000,
    ttl_ms: 60_000,
  }))
  const sent = unwrap(await call(client, 'job_send', {
    job_id: job.job_id,
    input: 'hi',
    cursor: 0,
    close_after: true,
    wait_ms: 5000,
  }))
  assert.match(sent.text, /EOF reached/)
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('T-S-05 wait_ms returns when the job leaves running', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('hi\\n'); setInterval(()=>{},1e9)"],
    timeout: 0,
    ttl_ms: 60_000,
  }))
  const page = unwrap(await call(client, 'job_read', { job_id: job.job_id, wait_ms: 10000 }))
  assert.equal(page.status, 'standing_by')
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('T-S-06 exec returns in about 10 seconds and does not kill the job', async () => {
  const started = Date.now()
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "let n=0; setInterval(()=>{ process.stdout.write('tick'+n+'\\n'); n++ }, 1000)"],
    ttl_ms: 60_000,
  }))
  const waited = Date.now() - started
  assert.ok(waited >= 8000 && waited < 20000, `waited ${waited}`)
  assert.equal(job.status, 'running')
  assert.match(job.text, /tick/)
  const page = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 0 }))
  assert.match(page.text, /tick/)
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('T-S-07 stdout and stderr are one text stream', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('OUT\\n'); process.stderr.write('ERR\\n')"],
    timeout: 10000,
  }))
  assert.match(job.text, /OUT/)
  assert.match(job.text, /ERR/)
  assert.equal(job.text.includes('stdout'), false)
  assert.equal(job.text.includes('stderr'), false)
})

test('T-K-01 a direct child is fully stopped', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', 'setInterval(()=>{},1e9)'],
    timeout: 0,
    ttl_ms: 60_000,
  }))
  const killed = unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
  assert.equal(killed.killed, true)
  assert.equal(killed.escalated, process.platform === 'win32')
  assert.equal(killed.remaining_children, 0)
})

test('T-K-02 a two-level tree is fully stopped', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1e9);globalThis.finchKeepK02=1'],{stdio:'ignore'}); setInterval(()=>{},1e9)"],
    timeout: 1500,
    ttl_ms: 60_000,
  }))
  const killed = unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
  assert.equal(killed.remaining_children, 0)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal((await commandLines('finchKeepK02')).trim(), '')
})

test('T-K-03 a three-level tree is fully stopped', async () => {
  const leaf = "setInterval(()=>{},1e9);globalThis.finchKeepK03=1"
  const mid = `const {spawn}=require('child_process'); spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{stdio:'ignore'}); setInterval(()=>{},1e9)`
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', mid],
    timeout: 2000,
    ttl_ms: 60_000,
  }))
  const killed = unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
  assert.equal(killed.killed, true)
  assert.equal(killed.remaining_children, 0)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal((await commandLines('finchKeepK03')).trim(), '')
})

test('T-K-04 killing a finished job returns killed false', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('ok')"],
    timeout: 10000,
  }))
  const first = unwrap(await call(client, 'job_kill', { job_id: job.job_id }))
  const second = unwrap(await call(client, 'job_kill', { job_id: job.job_id }))
  assert.equal(first.killed, false)
  assert.equal(first.escalated, false)
  assert.equal(first.remaining_children, 0)
  assert.equal(second.killed, false)
  assert.equal(second.status === 'finished' || second.status === 'killed', true)
})

test('T-K-05 killing a missing job', async () => {
  await expectCode('job_kill', { job_id: 'j_missing' }, 'E_NOT_FOUND')
})

test('T-A-01 max_chars above 16384', async () => {
  await expectCode('job_read', { job_id: 'j_missing', max_chars: 20000 }, 'E_INVALID_ARG')
})

test('T-A-02 wait_ms above 60000', async () => {
  await expectCode('job_read', { job_id: 'j_missing', wait_ms: 60001 }, 'E_INVALID_ARG')
})

test('T-A-03 exec without mode', async () => {
  await expectCode('exec', { program: 'node', args: ['-e', '0'] }, 'E_INVALID_ARG')
})

test('T-A-04 tty is unavailable', async () => {
  await expectCode('exec', { mode: 'argv', program: 'node', args: ['-v'], tty: true }, 'E_TTY_UNAVAILABLE')
})

test('T-A-05 job_send without cursor', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', 'setInterval(()=>{},1e9)'],
    timeout: 0,
    ttl_ms: 60_000,
  }))
  await expectCode('job_send', { job_id: job.job_id, input: 'x' }, 'E_INVALID_ARG')
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
})

test('T-A-06 cwd does not exist', async () => {
  await expectCode('exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', '0'],
    cwd: process.platform === 'win32' ? 'D:\\no-such-dir-finch' : '/no-such-dir-finch',
  }, 'E_NOT_FOUND')
})

test('T-A-07 the program does not exist', async () => {
  await expectCode('exec', { mode: 'argv', program: 'no-such-exe', args: [] }, 'E_NOT_FOUND')
})

test('T-A-08 tags filter by subset', async () => {
  const alpha = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('a')"],
    tags: { suite: 'cases', role: 'alpha' },
    timeout: 10000,
  }))
  const beta = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('b')"],
    tags: { suite: 'cases', role: 'beta' },
    timeout: 10000,
  }))
  const listed = unwrap(await call(client, 'job_list', { include_finished: true, tags: { role: 'alpha' } }))
  const ids = (listed.jobs as { job_id: string }[]).map((item) => item.job_id)
  assert.equal(ids.includes(alpha.job_id), true)
  assert.equal(ids.includes(beta.job_id), false)
})

test('T-F-01 splice and hex write of an existing file require expect_hash', async () => {
  const target = file('locked.bin')
  unwrap(await call(client, 'fs_write', { path: target, hex: '61' }))
  await expectCode('fs_splice', { path: target, offset: 'end', insert_hex: '62' }, 'E_HASH_REQUIRED')
  await expectCode('fs_write', { path: target, hex: '63' }, 'E_HASH_REQUIRED')
})

test('T-F-02 expect_hash absent creates a new file', async () => {
  const target = file('fresh.txt')
  const written = unwrap(await call(client, 'fs_write', { path: target, text: 'new', expect_hash: 'absent' }))
  assert.equal(written.created, true)
})

test('T-F-03 fs_patch rejects a file over 8 MB', async () => {
  const target = file('big.txt')
  await writeFile(target, Buffer.alloc(9 * 1024 * 1024, 0x61))
  await expectCode('fs_patch', {
    path: target,
    edits: [{ old_text: 'a', new_text: 'b', count: 1 }],
  }, 'E_TOO_LARGE')
})

test('T-F-04 fs_read rejects an offset past the end', async () => {
  const target = file('range.txt')
  unwrap(await call(client, 'fs_write', { path: target, text: 'ab' }))
  await expectCode('fs_read', { path: target, offset: 50 }, 'E_RANGE')
})

test('T-F-05 GBK cannot store an emoji', async () => {
  const target = file('gbk.txt')
  const rejected = await expectCode('fs_write', { path: target, text: 'abc🚀', encoding: 'gbk' }, 'E_ENCODING_UNREPRESENTABLE')
  assert.equal(rejected.error?.context?.codepoint, 'U+1F680')
  assert.equal(rejected.error?.context?.index, 3)
})

test('T-F-06 preserve writes a BOM and CRLF', async () => {
  const target = file('bom.txt')
  unwrap(await call(client, 'fs_write', {
    path: target,
    text: '甲\n乙',
    encoding: 'utf-8',
    preserve: { bom: 'add', eol: 'crlf' },
  }))
  const page = unwrap(await call(client, 'fs_read', { path: target, mode: 'text', include_bom: true }))
  assert.equal(page.bom, true)
  assert.equal(page.eol, 'crlf')
  assert.equal(page.text.startsWith('\uFEFF'), true)
  assert.match(page.text, /甲\r\n乙/)
})

test('T-F-07 a write is checked by reading it back', async () => {
  const target = file('verified.txt')
  const written = unwrap(await call(client, 'fs_write', { path: target, text: 'same' }))
  assert.equal(written.verified, true)
  assert.equal(typeof written.hash_after, 'string')
  const page = unwrap(await call(client, 'fs_read', { path: target, mode: 'text' }))
  assert.equal(page.hash, written.hash_after)
  assert.equal(page.text, 'same')
})

test('T-F-08 fs_stat returns many paths in one call', async () => {
  const target = file('stated.txt')
  unwrap(await call(client, 'fs_write', { path: target, text: 's' }))
  const stat = unwrap(await call(client, 'fs_stat', { paths: [target, file('missing.txt')] }))
  const entries = stat.entries as { path: string; exists: boolean; hash?: string; is_binary?: boolean }[]
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.exists, true)
  assert.equal(typeof entries[0]?.hash, 'string')
  assert.equal(entries[0]?.is_binary, false)
  assert.equal(entries[1]?.exists, false)
})

test('T-F-09 fs_write rejects an unknown argument', async () => {
  const rejected = await expectCode('fs_write', { path: file('x.txt'), text: 'a', mode: 'text' }, 'E_INVALID_ARG')
  assert.match(rejected.error?.message ?? '', /mode/)
})

test('T-D-01 a full read of valid UTF-8 has lossy false', async () => {
  const target = file('fffd.txt')
  const text = '合法\uFFFD结尾'
  unwrap(await call(client, 'fs_write', { path: target, text, preserve: { eol: 'as_is' } }))
  const page = unwrap(await call(client, 'fs_read', {
    path: target,
    mode: 'text',
    encoding: 'utf-8',
  }))
  assert.equal(page.lossy, false)
  assert.equal(page.eof, true)
  assert.equal(page.remaining, 0)
  assert.equal(page.text, text)
  const reportPath = 'D:\\workspace\\test\\测试报告-2.md'
  if (existsSync(reportPath)) {
    const raw = await readFile(reportPath)
    let expected = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    if (expected.startsWith('\uFEFF')) expected = expected.slice(1)
    const report = unwrap(await call(client, 'fs_read', {
      path: reportPath,
      mode: 'text',
      encoding: 'utf-8',
      length: raw.length,
    }))
    assert.equal(report.lossy, false)
    assert.equal(report.eof, true)
    assert.equal(report.remaining, 0)
    assert.equal(report.text, expected)
  }
})

test('T-D-02 offset_aligned is false when the window ends mid-character', async () => {
  const target = file('bigcjk.txt')
  const body = Buffer.concat([Buffer.alloc(4095, 0x41), Buffer.from('中END', 'utf8')])
  await writeFile(target, body)
  const page = unwrap(await call(client, 'fs_read', {
    path: target,
    mode: 'text',
    encoding: 'utf-8',
    offset: 0,
    length: 4097,
  }))
  assert.equal(page.offset_aligned, false)
  assert.equal(page.lossy, true)
  assert.equal(String(page.text).endsWith('\uFFFD'), true)
  assert.equal(page.eof, false)
  const whole = unwrap(await call(client, 'fs_read', {
    path: target,
    mode: 'text',
    encoding: 'utf-8',
    length: body.length,
  }))
  assert.equal(whole.offset_aligned, true)
  assert.equal(whole.lossy, false)
  assert.equal(whole.text.endsWith('中END'), true)
})

test('T-D-03 the contract describes offset_aligned and dropped_chars', async () => {
  const fileDoc = await readFile(new URL('../docs/01-contract.md', import.meta.url), 'utf8')
  const execDoc = await readFile(new URL('../docs/01-contract.md', import.meta.url), 'utf8')
  assert.match(fileDoc, /offset_aligned/)
  assert.match(fileDoc, /dropped_chars/)
  assert.match(execDoc, /can be true together with `capped`/)
  assert.match(execDoc, /cursor: 0/)
})
