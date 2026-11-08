import assert from 'node:assert/strict'
import { test } from 'node:test'
import { call, killPid, removeHome, startStdio, tempHome, unwrap } from './helpers.ts'

test('after a hard stop, the next process marks the job lost', { timeout: 60_000 }, async () => {
  const home = await tempHome()
  const first = await startStdio(home)
  try {
    const job = unwrap(await call(first.client, 'exec', {
      mode: 'argv',
      program: 'node',
      args: ['-e', 'setInterval(()=>{}, 1e9)'],
      name: 'sleeping',
      timeout: 0,
      ttl_ms: 120_000,
      tags: { project: 'restart' },
    }))
    const listed = unwrap(await call(first.client, 'job_list', { tags: { project: 'restart' } }))
    const row = (listed.jobs as { pid: number }[])[0]
    const serverPid = first.transport.pid
    assert.ok(serverPid)
    await killPid(serverPid)
    if (row?.pid) await killPid(row.pid)
    const second = await startStdio(home)
    try {
      const again = unwrap(await call(second.client, 'job_list', {}))
      const lost = (again.jobs as { job_id: string; status: string; log_path: string }[])
        .find((item) => item.job_id === job.job_id)
      assert.ok(lost)
      assert.equal(lost?.status, 'lost')
      assert.equal(lost?.log_path, job.log_path)
    } finally {
      await second.client.close().catch(() => undefined)
    }
  } finally {
    await removeHome(home)
  }
})
