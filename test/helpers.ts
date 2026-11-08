import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const exec = promisify(execFile)

export const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))

export interface ToolBody {
  ok: boolean
  data?: Record<string, any>
  error?: { code: string; message: string; hint?: string; context?: Record<string, unknown> }
}

export function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.FINCH_SHELL_HOME = home
  return env
}

export async function tempHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'finch-mcp-'))
}

export async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true })
}

export async function startStdio(home: string): Promise<{ client: Client; transport: StdioClientTransport; home: string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', entry],
    env: childEnv(home),
    stderr: 'pipe',
    cwd: path.dirname(entry),
  })
  const client = new Client({ name: 'finch-test', version: '0.0.0' })
  await client.connect(transport)
  return { client, transport, home }
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolBody> {
  const result = await client.callTool({ name, arguments: args }, { timeout: 120_000 })
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  const block = content.find((item) => item.type === 'text' && item.text)
  if (!block?.text) throw new Error(`${name} returned no text：${JSON.stringify(result)}`)
  return JSON.parse(block.text) as ToolBody
}

export function unwrap(body: ToolBody): Record<string, any> {
  if (!body.ok) throw new Error(`${body.error?.code ?? 'ERR'}: ${body.error?.message ?? ''}`)
  return body.data ?? {}
}

export async function killPid(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await exec('taskkill', ['/F', '/T', '/PID', String(pid)]).catch(() => undefined)
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process is already gone.
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function connectHttp(port: number): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const deadline = Date.now() + 10_000
  let last: unknown
  while (Date.now() < deadline) {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    const client = new Client({ name: 'finch-http-test', version: '0.0.0' })
    try {
      await client.connect(transport)
      return { client, transport }
    } catch (error) {
      last = error
      await transport.close().catch(() => undefined)
      await delay(100)
    }
  }
  throw last instanceof Error ? last : new Error('HTTP connection failed')
}
