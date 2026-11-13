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

test('PiAcpSession: steer injects into the running turn', async () => {
  const proc = new FakePiRpcProcess()
  const { conn, session } = makeSession(proc)

  const first = session.prompt('one')
  const outcome = await session.steer('actually do this instead')

  assert.equal(outcome, 'injected')
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1].message, 'actually do this instead')
  assert.equal(proc.prompts[1].streamingBehavior, 'steer')

  // The client sent the steer outside `session/prompt`, so the adapter echoes it into the thread.
  await new Promise(resolve => setImmediate(resolve))
  const echo = conn.updates.find(u => u.update?.sessionUpdate === 'user_message_chunk')
  assert.ok(echo, 'expected a user_message_chunk echo')

  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
})

test('PiAcpSession: steer reports promptRequired when idle and asked to', async () => {
  const proc = new FakePiRpcProcess()
  const { session } = makeSession(proc)

  const outcome = await session.steer('later', [], { idleBehavior: 'promptRequired' })

  assert.equal(outcome, 'promptRequired')
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: steer starts a turn when idle and not asked to hold', async () => {
  const proc = new FakePiRpcProcess()
  const { session } = makeSession(proc)

  const outcome = await session.steer('do it now')

  assert.equal(outcome, 'startedNewTurn')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0].message, 'do it now')
  assert.equal(proc.prompts[0].streamingBehavior, undefined)

  // The detached turn has no ACP request waiting on it, but it must still track state.
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(proc.abortCount, 0)
})
