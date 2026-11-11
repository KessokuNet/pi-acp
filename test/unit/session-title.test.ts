import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function fixture() {
  const conn = new FakeAgentSideConnection()
  const names: string[] = []
  const proc = new FakePiRpcProcess()
  Object.assign(proc, {
    setSessionName: async (name: string) => {
      names.push(name)
      proc.emit({ type: 'session_info_changed', name })
    }
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as import('../../src/pi-rpc/process.js').PiRpcProcess,
    conn: asAgentConn(conn)
  })
  Object.defineProperty(agent, 'sessions', { value: { maybeGet: () => session } })
  return { agent, conn, proc, names }
}

test('session/set_title saves a normalized title and forwards the Pi change', async () => {
  const { agent, conn, names } = fixture()
  assert.deepEqual(await agent.setSessionTitle({ sessionId: 's1', title: '  Fix parser  ' }), { title: 'Fix parser' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(names, ['Fix parser'])
  assert.equal(conn.updates[0]?.update.sessionUpdate, 'session_info_update')
  assert.equal(conn.updates[0]?.update.title, 'Fix parser')
})

test('session/set_title rejects blank titles without changing Pi', async () => {
  const { agent, names } = fixture()
  await assert.rejects(agent.setSessionTitle({ sessionId: 's1', title: '   ' }), { code: -32602 })
  assert.deepEqual(names, [])
})

test('Pi title changes and clearing propagate without an ACP rename request', async () => {
  const { proc, conn } = fixture()
  proc.emit({ type: 'session_info_changed', name: 'New name' })
  proc.emit({ type: 'session_info_changed', name: undefined })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(
    conn.updates.map(({ update }) => (update.sessionUpdate === 'session_info_update' ? update.title : undefined)),
    ['New name', null]
  )
})
