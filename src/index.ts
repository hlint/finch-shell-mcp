#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { DEFAULT_HTTP_PORT, HTTP_BODY_MAX, HTTP_PATH } from './constants.ts'
import { assertIcu } from './encoding.ts'
import { bootJobs, runWithSession, shutdownJobs } from './jobs.ts'
import { createAppServer } from './server.ts'

assertIcu()

interface Bind {
  host: string
  port: number
}

function parseBind(argv: string[]): Bind | null {
  const http = argv.includes('--http') || process.env.FINCH_TRANSPORT === 'http'
  if (!http) return null
  const index = argv.indexOf('--http')
  const spec = index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith('-') ? argv[index + 1]! : ''
  if (!spec) {
    return {
      host: process.env.FINCH_SHELL_HTTP_HOST ?? '127.0.0.1',
      port: Number(process.env.FINCH_SHELL_HTTP_PORT ?? DEFAULT_HTTP_PORT),
    }
  }
  if (/^\d+$/.test(spec)) return { host: '127.0.0.1', port: Number(spec) }
  const matched = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(spec)
  if (!matched) {
    console.error('Usage: --http [port | host:port]')
    process.exit(2)
  }
  return { host: matched[1] ?? matched[2] ?? '127.0.0.1', port: Number(matched[3]) }
}

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

function sessionHeader(req: IncomingMessage): string {
  const value = req.headers['mcp-session-id']
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? ''
}

function validSession(id: string): boolean {
  return id.length <= 128 && /^[\x21-\x7E]+$/.test(id)
}

function isInitialize(body: unknown): boolean {
  if (Array.isArray(body)) return body.some((item) => isInitialize(item))
  return !!body && typeof body === 'object' && (body as { method?: unknown }).method === 'initialize'
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buf.length
    if (size > HTTP_BODY_MAX) {
      const error = new Error('Request body exceeds 32 MB.')
      error.name = 'RequestBodyTooLargeError'
      throw error
    }
    chunks.push(buf)
  }
  if (size === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function routeHttp(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (req: IncomingMessage, res: ServerResponse, parsedBody?: unknown) => Promise<void>,
): Promise<void> {
  const incoming = sessionHeader(req)
  if (incoming && !validSession(incoming)) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Invalid Mcp-Session-Id.\n')
    return
  }
  if ((req.method ?? 'GET') === 'POST') {
    const parsed = await readBody(req)
    if (!incoming && isInitialize(parsed)) res.setHeader('mcp-session-id', randomUUID())
    if (incoming) res.setHeader('mcp-session-id', incoming)
    await runWithSession(incoming, () => handle(req, res, parsed))
    return
  }
  if (incoming) res.setHeader('mcp-session-id', incoming)
  await runWithSession(incoming, () => handle(req, res))
}

async function serveHttp(bind: Bind): Promise<void> {
  const handler = createMcpHandler(() => createAppServer(), { maxRequestBodySize: HTTP_BODY_MAX })
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: HTTP_BODY_MAX })
  const local = loopback(bind.host)
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()
  if (!local) {
    console.error('Warning: HTTP is bound to a non-loopback address. This version does not authenticate callers.')
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? '/').split('?')[0]
    if (pathname !== HTTP_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('The MCP endpoint is /mcp\n')
      return
    }
    if (local && (!validateHost(req, res) || !validateOrigin(req, res))) return
    void routeHttp(req, res, nodeHandler).catch((error) => {
      if (res.headersSent) return
      const tooLarge = error instanceof Error && error.name === 'RequestBodyTooLargeError'
      res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(tooLarge ? 'Request body exceeds 32 MB.\n' : 'Request body is not JSON.\n')
    })
  })
  server.requestTimeout = 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(bind.port, bind.host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : bind.port
  console.error(`finch-shell-mcp http://${bind.host}:${port}${HTTP_PATH}`)
  const stop = () => {
    void shutdownJobs().finally(() => {
      server.close(() => process.exit(0))
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function servePipe(): Promise<void> {
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    void shutdownJobs().finally(() => process.exit(0))
  }
  serveStdio(() => createAppServer())
  process.stdin.on('end', stop)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

async function main(): Promise<void> {
  await bootJobs()
  const bind = parseBind(process.argv.slice(2))
  if (bind) await serveHttp(bind)
  else await servePipe()
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
