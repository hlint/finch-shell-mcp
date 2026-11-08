import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import { call, childEnv, connectHttp, entry, removeHome, killPid, tempHome, unwrap } from './helpers.ts'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

test('HTTP sessions cannot see each others jobs, and files are shared', async () => {
  const home = await tempHome()
  const port = await freePort()
  const child = spawn(process.execPath, ['--experimental-strip-types', entry, '--http', `127.0.0.1:${port}`], {
    env: childEnv(home),
    cwd: path.dirname(entry),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  try {
    const first = await connectHttp(port)
    const second = await connectHttp(port)
    const file = path.join(home, 'http.txt')
    const written = unwrap(await call(first.client, 'fs_write', { path: file, text: 'from-http\n' }))
    const read = unwrap(await call(second.client, 'fs_read', { path: file, mode: 'text' }))
    assert.equal(read.text, 'from-http\n')
    assert.equal(read.hash, written.hash_after)

    assert.ok(first.transport.sessionId)
    assert.notEqual(first.transport.sessionId, second.transport.sessionId)
    const job = unwrap(await call(first.client, 'exec', {
      mode: 'argv',
      program: 'node',
      args: ['-e', 'setInterval(()=>{}, 1e9)'],
      name: 'http-sleep',
      timeout: 0,
      ttl_ms: 60_000,
      tags: { project: 'http-demo' },
    }))
    const hidden = unwrap(await call(second.client, 'job_list', { tags: { project: 'http-demo' } }))
    const leaked = (hidden.jobs as { job_id: string }[]).find((item) => item.job_id === job.job_id)
    assert.equal(leaked, undefined)
    const listed = unwrap(await call(first.client, 'job_list', { tags: { project: 'http-demo' } }))
    const found = (listed.jobs as { job_id: string; name: string; log_path: string }[]).find((item) => item.job_id === job.job_id)
    assert.ok(found, stderr)
    assert.equal(found?.name, 'http-sleep')
    assert.equal(found?.log_path, job.log_path)
    const denied = await call(second.client, 'job_kill', { job_id: job.job_id, grace_ms: 200 })
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'E_NOT_FOUND')
    await call(first.client, 'job_kill', { job_id: job.job_id, grace_ms: 200 })
    await first.client.close()
    await second.client.close()
  } finally {
    if (child.pid) await killPid(child.pid)
    await removeHome(home)
  }
})

test('calls without a session header share one job table and cannot see a session job', async () => {
  const home = await tempHome()
  const port = await freePort()
  const child = spawn(process.execPath, ['--experimental-strip-types', entry, '--http', `127.0.0.1:${port}`], {
    env: childEnv(home),
    cwd: path.dirname(entry),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    const opened = await postMcp(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    })
    assert.equal(opened.status, 200)
    assert.match(opened.session ?? '', /^[0-9a-f-]{36}$/i)
    await postMcp(port, { jsonrpc: '2.0', method: 'notifications/initialized' })
    const anonymous = await toolCall(port, 'exec', {
      mode: 'argv',
      program: 'node',
      args: ['-e', 'setInterval(()=>{}, 1e9)'],
      name: 'plain',
      timeout: 0,
      ttl_ms: 60_000,
      tags: { project: 'plain' },
    })
    const headed = await toolCall(port, 'exec', {
      mode: 'argv',
      program: 'node',
      args: ['-e', 'setInterval(()=>{}, 1e9)'],
      name: 'headed',
      timeout: 0,
      ttl_ms: 60_000,
      tags: { project: 'headed' },
    }, 'sess-a')
    const same = await toolCall(port, 'job_list', {}, 'sess-a')
    assert.ok(jobIds(same).includes(String(headed.job_id)))
    assert.equal(jobIds(same).includes(String(anonymous.job_id)), false)
    const other = await toolCall(port, 'job_list', {}, 'sess-b')
    assert.equal(jobIds(other).includes(String(headed.job_id)), false)
    const plain = await toolCall(port, 'job_list', {})
    assert.ok(jobIds(plain).includes(String(anonymous.job_id)))
    assert.equal(jobIds(plain).includes(String(headed.job_id)), false)
    await toolCall(port, 'job_kill', { job_id: anonymous.job_id, grace_ms: 200 })
    await toolCall(port, 'job_kill', { job_id: headed.job_id, grace_ms: 200 }, 'sess-a')
  } finally {
    if (child.pid) await killPid(child.pid)
    await removeHome(home)
  }
})

async function postMcp(port: number, body: unknown, session?: string): Promise<{ status: number; session: string | null; json: unknown }> {
  const deadline = Date.now() + 10_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      if (session) headers['mcp-session-id'] = session
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
      const text = await response.text()
      return { status: response.status, session: response.headers.get('mcp-session-id'), json: decodeRpc(text) }
    } catch (error) {
      last = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw last instanceof Error ? last : new Error('HTTP connection failed')
}

function decodeRpc(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed)
  const data = trimmed.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
  return JSON.parse(data.at(-1) ?? '{}')
}

async function toolCall(port: number, name: string, args: Record<string, unknown>, session?: string): Promise<Record<string, unknown>> {
  const response = await postMcp(port, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  }, session)
  const json = response.json as { result?: { content?: { text?: string }[] }; error?: { message?: string } }
  const text = json.result?.content?.find((item) => item.text)?.text
  if (!text) throw new Error(`${name} returned no text：${JSON.stringify(response.json)}`)
  const body = JSON.parse(text) as { ok: boolean; data?: Record<string, unknown>; error?: { message?: string } }
  if (!body.ok) throw new Error(body.error?.message ?? name)
  return body.data ?? {}
}

function jobIds(data: Record<string, unknown>): string[] {
  return (data.jobs as { job_id: string }[]).map((item) => item.job_id)
}

