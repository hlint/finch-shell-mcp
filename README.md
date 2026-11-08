# finch-shell-mcp

MCP server for local files and shell jobs.

An MCP server that gives an agent ten tools: five for files, five for commands. Writes can be checked against a hash and are read back after they land. Command output is one text stream, read with a Unicode code-point cursor.

## Features

- Files: stat, read by byte offset, replace a whole file, exact text replace, insert or delete at a byte offset. A successful write is read back.
- Commands: `argv`, or a script for a named interpreter. The default wait is 10 seconds. When it elapses, the call returns the output so far and the job keeps running.
- A long job has a `job_id`, a log file, and a status. You can keep reading, write to stdin, or stop the process tree.
- stdio and Streamable HTTP. On HTTP, jobs for different `Mcp-Session-Id` values are not visible to each other. Files are shared.
- Output is not assumed to be UTF-8. Bytes that cannot be decoded become the replacement character and `lossy` is set. The call itself still succeeds.
- No dependency needs a native compile step.

## Requirements

Node.js 22.18 or newer.

## Quick start

This version is not on npm yet. Download the release tarball and install it globally:

[hlint-finch-shell-mcp-0.1.1.tgz](https://github.com/hlint/finch-shell-mcp/releases/download/v0.1.1/hlint-finch-shell-mcp-0.1.1.tgz)

Linux:

```bash
curl -fsSL -o hlint-finch-shell-mcp-0.1.1.tgz https://github.com/hlint/finch-shell-mcp/releases/download/v0.1.1/hlint-finch-shell-mcp-0.1.1.tgz && npm install -g ./hlint-finch-shell-mcp-0.1.1.tgz
```

Windows (PowerShell):

```powershell
Invoke-WebRequest -Uri https://github.com/hlint/finch-shell-mcp/releases/download/v0.1.1/hlint-finch-shell-mcp-0.1.1.tgz -OutFile hlint-finch-shell-mcp-0.1.1.tgz; npm install -g .\hlint-finch-shell-mcp-0.1.1.tgz
```

That puts `finch-shell-mcp` on your PATH. Add this to an MCP client:

```json
{
  "mcpServers": {
    "finch-shell": {
      "command": "finch-shell-mcp"
    }
  }
}
```

Or run it from a checkout:

```bash
npm install
npx finch-shell-mcp
```

HTTP:

```bash
finch-shell-mcp --http
finch-shell-mcp --http 0.0.0.0:8787
```

The default URL is `http://127.0.0.1:7331/mcp`. `--http 8787` changes only the port and still binds to loopback. `FINCH_SHELL_HTTP_HOST` and `FINCH_SHELL_HTTP_PORT` apply when no address is passed. `FINCH_TRANSPORT=http` also starts HTTP.

Loopback checks Host and Origin. Any other address has no caller authentication and should stay on a network you trust.

Job logs live in `FINCH_SHELL_HOME`. When unset, Windows uses `%LOCALAPPDATA%\finch-shell-mcp` and other systems use `~/.finch-shell-mcp`.

## Tools

| Tool | What it does |
|---|---|
| `fs_stat` | Size, times, and a short hash for many paths |
| `fs_read` | Read text or hexadecimal bytes |
| `fs_write` | Replace a whole file |
| `fs_patch` | Replace exact text |
| `fs_splice` | Insert or delete at a byte offset |
| `exec` | Start a job and wait |
| `job_read` | Continue reading output |
| `job_send` | Write stdin after the job goes quiet |
| `job_list` | List jobs for this session |
| `job_kill` | Stop a job and its process tree |

A tool result is one JSON text block. On failure, `ok` is `false` and `error.code` is stable. A non-zero command exit is not a failed call. Read `status`.

Fields, error codes, and limits are in the [interface contract](docs/01-contract.md).

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run pack
```

`npm install` runs tsdown and writes `dist/index.mjs`. That file is the command. `npm run pack` typechecks, then builds a `.tgz`. Publishing runs the tests again. Layout and implementation notes are in the [development guide](docs/02-development.md).

## License

[ISC](LICENSE)
