import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(proc: FakePiRpcProcess) {
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { conn, session }
}

test('PiAcpSession: mid-turn prompts are handed to pi as follow-ups', async () => {
  const proc = new FakePiRpcProcess()
  const { session } = makeSession(proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // Let the forward promises settle.
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(proc.prompts.length, 3)
  assert.equal(proc.prompts[0].streamingBehavior, undefined)
  assert.equal(proc.prompts[1].streamingBehavior, 'followUp')
  assert.equal(proc.prompts[2].streamingBehavior, 'followUp')

  // All three settle with the single run.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })

  assert.equal(await first, 'end_turn')
  assert.equal(await second, 'end_turn')
  assert.equal(await third, 'end_turn')
})

test('PiAcpSession: cancel clears pi queue and settles attached prompts', async () => {
  const proc = new FakePiRpcProcess()
  const { session } = makeSession(proc)

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proc.prompts.length, 3)

  await session.cancel()

  assert.equal(proc.abortCount, 1)
  assert.equal(proc.clearQueueCount, 1)

  // attached prompts resolve as cancelled
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  // finish first prompt as cancelled after abort
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'cancelled')
})

test('PiAcpSession: falls back to the local queue when pi refuses a mid-turn prompt', async () => {
  const proc = new FakePiRpcProcess()
  const { session } = makeSession(proc)

  const first = session.prompt('one')

  proc.promptFailure = new Error('Cannot submit a prompt while compaction is in progress')
  const second = session.prompt('two')

  await new Promise(resolve => setImmediate(resolve))

  // Only the first prompt reached pi; the second is held locally.
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')

  // The queued message starts as its own run.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1].message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})
