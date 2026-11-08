import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { Client } from '@modelcontextprotocol/client'
import { call, removeHome, startStdio, tempHome, unwrap } from './helpers.ts'

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

test('powershell shell mode returns plain text', { skip: process.platform !== 'win32' }, async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'shell',
    interpreter: 'powershell',
    script: "Write-Output 'hello-only'\nWrite-Output '中文'",
    timeout: 20000,
  }))
  assert.equal(result.text.includes('#< CLIXML'), false)
  assert.equal(result.text.includes('<Objs'), false)
  assert.match(result.text, /hello-only/)
  assert.match(result.text, /中文/)
  assert.equal(result.prompt_hint, null)
  const listed = unwrap(await call(client, 'job_list', { include_finished: true }))
  const row = (listed.jobs as { job_id: string; command: string; elapsed_ms: number; prompt_hint: string | null }[])
    .find((item) => item.job_id === result.job_id)
  assert.ok(row)
  assert.match(row.command, /Write-Output 'hello-only'\nWrite-Output/)
  await new Promise((resolve) => setTimeout(resolve, 300))
  const again = unwrap(await call(client, 'job_list', { include_finished: true }))
  const later = (again.jobs as { job_id: string; elapsed_ms: number }[]).find((item) => item.job_id === result.job_id)
  assert.equal(later?.elapsed_ms, row.elapsed_ms)
})

test('children excludes conhost when the job did not spawn one', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', 'setInterval(()=>{}, 1e9)'],
    timeout: 0,
    ttl_ms: 60_000,
  }))
  const listed = unwrap(await call(client, 'job_list', {}))
  const row = (listed.jobs as { job_id: string; children: number; status: string }[])
    .find((item) => item.job_id === job.job_id)
  assert.equal(row?.children, 0)
  unwrap(await call(client, 'job_kill', { job_id: job.job_id, grace_ms: 200 }))
  const finished = unwrap(await call(client, 'job_list', { include_finished: true }))
  const afterKill = (finished.jobs as { job_id: string; children: number }[])
    .find((item) => item.job_id === job.job_id)
  assert.equal(afterKill?.children, 0)
})

test('a 4096 tail is capped and not truncated', async () => {
  const result = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('x'.repeat(5000))"],
    timeout: 10000,
  }))
  assert.equal(result.chars_returned, 4096)
  assert.equal(result.truncated, false)
  assert.equal(result.capped, true)
  assert.equal(result.eof, true)
})

test('the schema describes patch, preserve, and tags', async () => {
  const listed = await client.listTools()
  const patch = listed.tools.find((tool) => tool.name === 'fs_patch')
  const write = listed.tools.find((tool) => tool.name === 'fs_write')
  const execTool = listed.tools.find((tool) => tool.name === 'exec')
  const patchSchema = JSON.stringify(patch?.inputSchema)
  const writeSchema = JSON.stringify(write?.inputSchema)
  const execSchema = JSON.stringify(execTool?.inputSchema)
  assert.match(patchSchema, /old_text/)
  assert.match(patchSchema, /new_text/)
  assert.match(patchSchema, /count/)
  assert.match(writeSchema, /preserve/)
  assert.match(writeSchema, /as_is/)
  assert.match(execSchema, /tags/)
})

test('emoji is counted in code points and a cursor does not split a surrogate', async () => {
  const job = unwrap(await call(client, 'exec', {
    mode: 'argv',
    program: 'node',
    args: ['-e', "process.stdout.write('A中B文C🚀D\\n')"],
    timeout: 10000,
  }))
  assert.equal(job.total_chars, 8)
  const whole = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 0 }))
  assert.equal(whole.text, 'A中B文C🚀D\n')
  const atRocket = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 5 }))
  assert.equal(atRocket.text, '🚀D\n')
  const afterRocket = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor: 6 }))
  assert.equal(afterRocket.text, 'D\n')
  for (let cursor = 0; cursor <= 8; cursor++) {
    const page = unwrap(await call(client, 'job_read', { job_id: job.job_id, cursor }))
    assert.equal(hasLoneSurrogate(String(page.text)), false, `cursor ${cursor}`)
  }
})

test('include_bom true keeps the BOM in the text', async () => {
  const target = path.join(home, 'bom.txt')
  unwrap(await call(client, 'fs_write', {
    path: target,
    text: '甲',
    encoding: 'utf-8',
    preserve: { bom: 'add', eol: 'as_is' },
  }))
  const hidden = unwrap(await call(client, 'fs_read', { path: target, mode: 'text', include_bom: false }))
  assert.equal(hidden.text, '甲')
  assert.equal(hidden.bom, true)
  const shown = unwrap(await call(client, 'fs_read', { path: target, mode: 'text', include_bom: true }))
  assert.equal(shown.text, '\uFEFF甲')
  assert.equal(shown.offset_aligned, true)
})

test('a boolean bom explains the allowed values', async () => {
  const target = path.join(home, 'patch.txt')
  const written = unwrap(await call(client, 'fs_write', { path: target, text: 'X' }))
  const rejected = await call(client, 'fs_patch', {
    path: target,
    expect_hash: written.hash_after,
    bom: false,
    edits: [{ old_text: 'X', new_text: 'Y', count: 1 }],
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error?.code, 'E_INVALID_ARG')
  assert.match(rejected.error?.message ?? '', /keep/)
  assert.match(rejected.error?.message ?? '', /add/)
  assert.match(rejected.error?.message ?? '', /strip/)
})

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
