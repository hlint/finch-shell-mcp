import { McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod/v4'
import { errorText, toolText } from './args.ts'
import { VERSION } from './constants.ts'
import { ToolError } from './errors.ts'
import { fsPatch, fsRead, fsSplice, fsStat, fsWrite } from './fs-tools.ts'
import { execJob, jobKill, jobList, jobRead, jobSend } from './jobs.ts'

const INSTRUCTIONS = [
  'Tools for files and commands on this machine. ',
  'Writes to an existing file need expect_hash. A binary write without it is rejected. ',
  'Tools do not add a newline for you. ',
  'exec requires mode. timeout does not stop the job. Use ttl_ms or job_kill to stop it. ',
  'There is no terminal. Passing tty returns E_TTY_UNAVAILABLE. ',
  'Over HTTP, jobs with Mcp-Session-Id belong to that session. Calls without the header share a separate table.',
].join('')

const tagsShape = z.record(z.string(), z.string()).optional().describe('String keys and values. At most 16 pairs. Keys up to 32 characters, values up to 128.')
const preserveShape = z.looseObject({
  bom: z.string().optional().describe('keep, add, strip, or as_is. Default keep'),
  eol: z.string().optional().describe('keep, crlf, lf, or as_is. Default as_is'),
}).optional()
const editsShape = z.array(z.looseObject({
  old_text: z.string().optional().describe('Exact text to replace. Must be non-empty'),
  new_text: z.string().optional().describe('Replacement text. May be empty'),
  count: z.number().optional().describe('Must equal the number of times old_text occurs'),
})).optional().describe('Replacements in order. Each item is old_text, new_text, and count')

function loose(fields: readonly string[], shaped: Record<string, z.ZodType> = {}) {
  const shape: Record<string, z.ZodType> = {}
  for (const field of fields) shape[field] = shaped[field] ?? z.any().optional().describe(field)
  return z.looseObject(shape)
}

async function run(fn: () => Promise<unknown>) {
  try {
    return toolText({ ok: true, data: await fn() })
  } catch (error) {
    if (error instanceof ToolError) return toolText(error.body)
    return errorText(error)
  }
}

export function createAppServer(): McpServer {
  const server = new McpServer({ name: 'finch-shell-mcp', version: VERSION }, { instructions: INSTRUCTIONS })

  server.registerTool(
    'fs_stat',
    {
      title: 'Stat files',
      description: 'Size, times, short hash, and an encoding guess for 1 to 200 absolute paths. hash defaults to true.',
      inputSchema: loose(['paths', 'hash']),
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => fsStat(args)),
  )
  server.registerTool(
    'fs_read',
    {
      title: 'Read a file by bytes',
      description: 'Read from a byte offset. mode is text, hex, or auto. At most 2 MB per call. A failed decode does not fail the call. hash is the short hash of the whole file.',
      inputSchema: loose(['path', 'offset', 'length', 'mode', 'encoding', 'include_bom', 'max_bytes']),
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => fsRead(args)),
  )
  server.registerTool(
    'fs_write',
    {
      title: 'Write a whole file',
      description: 'Provide exactly one of text or hex. A hex write to an existing file requires expect_hash unless force is set. The write is read back. Parent directories are created by default.',
      inputSchema: loose(['path', 'text', 'hex', 'encoding', 'expect_hash', 'preserve', 'create_dirs', 'force'], { preserve: preserveShape }),
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => fsWrite(args)),
  )
  server.registerTool(
    'fs_patch',
    {
      title: 'Replace exact text',
      description: 'Replace exact text, not a regular expression. Each edit has old_text, new_text, and count, and count must equal the number of matches. Files over 8 MB are rejected.',
      inputSchema: loose(['path', 'expect_hash', 'encoding', 'bom', 'edits'], { edits: editsShape }),
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => fsPatch(args)),
  )
  server.registerTool(
    'fs_splice',
    {
      title: 'Insert or delete bytes',
      description: 'offset is a byte count, start, or end. Provide exactly one of insert or insert_hex. No newline is added. An existing file requires expect_hash unless force is set.',
      inputSchema: loose(['path', 'offset', 'delete_bytes', 'insert', 'insert_hex', 'encoding', 'expect_hash', 'force', 'create_dirs']),
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => fsSplice(args)),
  )
  server.registerTool(
    'exec',
    {
      title: 'Start a job',
      description: 'mode is required. argv uses program and args. shell uses script and interpreter. The default wait is 10 seconds and does not kill the job. The response is the last 4096 characters.',
      inputSchema: loose([
        'mode', 'program', 'args', 'script', 'interpreter', 'name', 'cwd', 'env', 'env_mode',
        'timeout', 'ttl_ms', 'tags', 'stdin', 'close_stdin', 'mem_limit_mb', 'cpu_limit_ms', 'grace_ms',
      ], { tags: tagsShape }),
    },
    async (args) => run(() => execJob(args)),
  )
  server.registerTool(
    'job_read',
    {
      title: 'Read job output',
      description: 'cursor is a character index and may be negative. At most 16384 characters per call. wait_ms waits until the job leaves running.',
      inputSchema: loose(['job_id', 'cursor', 'max_chars', 'wait_ms']),
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => jobRead(args)),
  )
  server.registerTool(
    'job_send',
    {
      title: 'Write to a job stdin',
      description: 'Accepted only while standing_by. cursor is required. No newline is added. Provide exactly one of input or input_hex.',
      inputSchema: loose(['job_id', 'input', 'input_hex', 'cursor', 'close_after', 'wait_ms']),
    },
    async (args) => run(() => jobSend(args)),
  )
  server.registerTool(
    'job_list',
    {
      title: 'List jobs',
      description: 'Lists live jobs and jobs marked lost after a restart. tags is a subset match.',
      inputSchema: loose(['tags', 'include_finished', 'limit'], { tags: tagsShape }),
      annotations: { readOnlyHint: true },
    },
    async (args) => run(() => jobList(args)),
  )
  server.registerTool(
    'job_kill',
    {
      title: 'Stop a job',
      description: 'Windows uses taskkill /T /F on the parent chain. Other systems send SIGTERM to the process group, then SIGKILL after the grace period. A partial stop returns E_KILL_INCOMPLETE.',
      inputSchema: loose(['job_id', 'grace_ms']),
      annotations: { destructiveHint: true },
    },
    async (args) => run(() => jobKill(args)),
  )
  return server
}
