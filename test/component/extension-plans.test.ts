import test from 'node:test'
import assert from 'node:assert/strict'
import type { PlanEntry } from '@agentclientprotocol/sdk/unstable'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function customEntry(customType: string, data: unknown) {
  return {
    type: 'entry_appended',
    entry: { type: 'custom', customType, data, id: 'e' + Math.random().toString(36).slice(2), timestamp: '' }
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function planUpdates(conn: FakeAgentSideConnection): PlanEntry[][] {
  return conn.updates
    .map(u => u.update)
    .filter((u): u is { sessionUpdate: 'plan'; entries: PlanEntry[] } => {
      return typeof u === 'object' && u !== null && 'sessionUpdate' in u && u.sessionUpdate === 'plan'
    })
    .map(u => u.entries)
}

function section(entry: PlanEntry): string | undefined {
  const meta = entry._meta as { piAcp?: { section?: string } } | undefined
  return meta?.piAcp?.section
}

function newSession() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { conn, proc }
}

test('pi-code todo entry surfaces as a plan section and its clear removes the rows', async () => {
  const { conn, proc } = newSession()

  proc.emit(
    customEntry('pi-code:todo', {
      nextId: 3,
      todos: [
        { id: 1, text: 'Read the spec', status: 'completed' },
        { id: 2, text: 'Write the decoder', status: 'in_progress', activeForm: 'Writing the decoder' }
      ]
    })
  )
  proc.emit(customEntry('pi-code:todo', { nextId: 3, todos: [] }))
  await flush()

  const plans = planUpdates(conn)
  assert.equal(plans.length, 2)
  assert.deepEqual(
    plans[0].map(e => [e.content, e.status, section(e)]),
    [
      ['Read the spec', 'completed', 'todos'],
      ['Writing the decoder', 'in_progress', 'todos']
    ]
  )
  assert.deepEqual(plans[1], [])
})

test('a goal entry leads the plan and completion flips the row', async () => {
  const { conn, proc } = newSession()

  proc.emit(customEntry('goal-state', { goal: { id: 'g1', text: 'Ship the decoder', status: 'active' } }))
  proc.emit(customEntry('pi-code:todo', { nextId: 1, todos: [{ id: 1, text: 'Run tests', status: 'pending' }] }))
  proc.emit(customEntry('goal-state', { goal: { id: 'g1', text: 'Ship the decoder', status: 'complete' } }))
  await flush()

  const plans = planUpdates(conn)
  assert.equal(plans.length, 3)
  assert.deepEqual(
    plans[1].map(e => e.content),
    ['Goal: Ship the decoder', 'Run tests']
  )
  assert.equal(plans[1][0].status, 'in_progress')
  assert.equal(section(plans[1][0]), 'goal')
  assert.equal(plans[2][0].status, 'completed')
})

test('goal producers replace each other, newest entry wins', async () => {
  const { conn, proc } = newSession()

  proc.emit(customEntry('goal-state', { goal: { text: 'From pi-goal', status: 'active' } }))
  proc.emit(customEntry('goal', { state: 'active', condition: 'From pi-code' }))
  proc.emit(customEntry('goal', { state: 'failed', condition: 'From pi-code' }))
  await flush()

  const plans = planUpdates(conn)
  assert.deepEqual(
    plans.map(p => p.length),
    [1, 1, 0]
  )
  assert.equal(plans[1][0].content, 'Goal: From pi-code')
})
