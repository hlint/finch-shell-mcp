# Development

For people changing this repository. Tool behavior is defined by the [interface contract](01-contract.md).

## Repository

```
src/index.ts      entry: stdio or HTTP
tsdown.config.ts  publish build
src/server.ts     registration of the ten tools
src/fs-tools.ts   file tools
src/jobs.ts       jobs, logs, and stopping a process tree
src/encoding.ts   detection and codecs
src/atomic.ts     per-path serial writes and atomic replace
src/home.ts       log directories
test/             functional tests through the official MCP client
```

Node.js 22.18 or newer. No native addons. Development and tests run the TypeScript source with `node --experimental-strip-types src/index.ts`. The published entry is `dist/index.mjs`, built by tsdown. `iconv-lite`, `jschardet`, `zod`, and the MCP SDK stay in `node_modules`. `bin` points at that file, so the process the client starts is the server.

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Architecture

Each request builds an MCP server object. Jobs are not stored on that object.

- stdio: one job table for the process.
- HTTP: one table per `Mcp-Session-Id`. Requests without that header share the anonymous table. `initialize` without the header writes a new id on the response. That call itself still uses the anonymous table.
- Files, file locks, and `max_jobs` (64) are process-wide. Two sessions cannot see each other's jobs, and they can read and write the same path.

HTTP defaults to `127.0.0.1:7331/mcp`. Loopback checks Host and Origin. Other addresses are not authenticated. The body limit is 32 MB.

## Disk

The root is `FINCH_SHELL_HOME`. Windows defaults to `%LOCALAPPDATA%\finch-shell-mcp`. Other systems default to `~/.finch-shell-mcp`.

```
jobs/active/{jobId}.{serverPid}.log
jobs/finished/{jobId}.{serverPid}.log
tmp/
```

Only job output is stored. There is no database. Command, tags, and working directory stay in memory. After a hard stop, the next process marks `active` logs whose owner pid is dead as `lost`, puts them in the anonymous table, and does not delete them. Finished logs are kept for 7 days. Temp scripts are kept for 1 day. A finished job object stays in memory for 10 minutes.

## Files

Paths are normalized for the current system. Windows accepts a drive or UNC path. POSIX accepts an absolute path starting with `/`. Writes to the same path are serialized with an in-process promise chain: check `expect_hash`, write a temp file in the same directory and `sync` it, `rename` over the target, then read back and compare the short hash. On Windows a busy target is retried up to 5 times.

The short hash is the first 6 hex characters of sha256. Files larger than 64 MB are hashed as a stream. Reads and writes are still allowed when the hash is skipped.

Detection order is in the contract. Codecs use `iconv-lite`. `TextDecoder` is used only to test strict UTF-8 and, at startup, to confirm the runtime includes ICU. `lossy` means encoding the text back with the same charset does not reproduce the bytes.

## Jobs

`argv` starts the program directly. A bare name is resolved on `PATH` only, not in the current directory.

`shell` writes the script under `tmp` and leaves stdin for `job_send`. PowerShell uses a `.ps1` with a UTF-8 BOM, starts it with `-File`, and strips the CLIXML wrapper. Stdout and stderr are stripped separately, so an unfinished stderr record cannot discard stdout. Removed CLIXML still counts as activity for the 1500 ms quiet clock, and that clock starts when the process exists. `cmd` runs `chcp 65001` from an ASCII launcher, then calls the script saved as UTF-8. The command line itself is not used for the script, because cmd would convert it to the system code page first. The system code page is not changed.

On POSIX the child is `detached` and becomes its own process group. Stopping a job closes stdin first. Windows uses `taskkill /T /F`. POSIX sends `SIGTERM` to the group, waits at most 5 seconds, then `SIGKILL`, and also signals every process that was in the tree before the kill. The process snapshot is cached. The cache is dropped before the result is checked. Zombies are not counted as survivors.

Output is decoded before the cursor is assigned. The unit is a Unicode code point. The ring keeps the latest 2,000,000 code points. An earlier `job_read` reads the log file. The memory limit samples the process-tree working set about once a second and stops the job when it is exceeded.

## Constants

| Item | Value |
|---|---|
| `fs_read` | 2 MB |
| `fs_patch` / `fs_splice` | 8 MB |
| `fs_write` | 32 MB |
| Live jobs | 64 |
| Ring buffer | 2,000,000 code points |
| `job_read` / `exec` tail | 16384 / 4096 code points |
| Default wait | 10 seconds, maximum 60 seconds |
| `ttl_ms` | 30 minutes, maximum 24 hours |
| Enter `standing_by` | 1500 ms without output |
| Default `grace_ms` | 3 seconds |
