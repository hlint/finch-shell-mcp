import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClixmlGate } from '../src/clixml.ts'

const sample =
  '#< CLIXML\r\nhello-only\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><AV>Preparing modules for first use.</AV></Obj></Objs>'

test('text between CLIXML blocks is kept', () => {
  const gate = new ClixmlGate()
  assert.equal(gate.push(sample, true), 'hello-only\r\n')
})

test('a banner split across chunks is still stripped', () => {
  const gate = new ClixmlGate()
  const cut = sample.indexOf('<Ob') + 3
  assert.equal(gate.push(sample.slice(0, cut)), 'hello-only\r\n')
  assert.equal(gate.push(sample.slice(cut) + 'tail', true), 'tail')
})

test('XML in the body is kept when there is no banner', () => {
  const gate = new ClixmlGate()
  const text = 'see <Objs>kept</Objs>\n'
  assert.equal(gate.push(text, true), text)
})
