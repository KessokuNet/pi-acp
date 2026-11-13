import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession, toUsageUpdate } from '../../src/acp/session.js'
import { toToolKind } from '../../src/acp/translate/pi-tools.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('toUsageUpdate: maps contextUsage to used/size', () => {
  assert.deepEqual(toUsageUpdate({ contextUsage: { tokens: 1234, contextWindow: 200000 } }), {
    sessionUpdate: 'usage_update',
    used: 1234,
    size: 200000
  })
})

test('toUsageUpdate: rejects missing or unusable counts', () => {
  const cases: unknown[] = [
    undefined,
    null,
    {},
    { contextUsage: null },
    { contextUsage: { tokens: null, contextWindow: 200000 } },
    { contextUsage: { tokens: 10, contextWindow: 0 } },
    { contextUsage: { tokens: 10, contextWindow: -1 } },
    { contextUsage: { tokens: -1, contextWindow: 100 } },
    { contextUsage: { tokens: 1.5, contextWindow: 100 } },
    { contextUsage: { tokens: '10', contextWindow: 100 } }
  ]

  for (const stats of cases) {
    assert.equal(toUsageUpdate(stats), null, `expected null for ${JSON.stringify(stats)}`)
  }
})

test("toUsageUpdate: carries pi's cumulative cost in USD", () => {
  assert.deepEqual(toUsageUpdate({ contextUsage: { tokens: 10, contextWindow: 100 }, cost: 0.25 }), {
    sessionUpdate: 'usage_update',
    used: 10,
    size: 100,
    cost: { amount: 0.25, currency: 'USD' }
  })
})

test('toUsageUpdate: omits cost when pi reports none or a non-number', () => {
  const base = { contextUsage: { tokens: 10, contextWindow: 100 } }

  for (const stats of [base, { ...base, cost: null }, { ...base, cost: '1.00' }, { ...base, cost: -1 }]) {
    assert.deepEqual(toUsageUpdate(stats), { sessionUpdate: 'usage_update', used: 10, size: 100 })
  }
})

test('toToolKind: maps pi tool names to ACP tool kinds', () => {
  assert.equal(toToolKind('read'), 'read')
  assert.equal(toToolKind('ls'), 'read')
  assert.equal(toToolKind('write'), 'edit')
  assert.equal(toToolKind('edit'), 'edit')
  assert.equal(toToolKind('bash'), 'execute')
  assert.equal(toToolKind('grep'), 'search')
  assert.equal(toToolKind('find'), 'search')
  assert.equal(toToolKind('web_fetch'), 'fetch')
  assert.equal(toToolKind('mcp__server__tool'), 'other')
})

test('PiAcpSession: publishes usage_update when a turn settles', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 1000 } }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  await turn

  const usage = conn.updates.filter(u => u.update.sessionUpdate === 'usage_update')
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0]!.update, { sessionUpdate: 'usage_update', used: 500, size: 1000 })
})

test('PiAcpSession: republishes quota meters on usage_update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 1000 } }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  await turn

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-status',
    method: 'setStatus',
    statusKey: 'subscription-usage',
    statusText: '5h 88% ↻4h12m · 1w 89% ↻5d19h'
  })
  await new Promise(r => setTimeout(r, 0))

  const usage = conn.updates.filter(u => u.update.sessionUpdate === 'usage_update')
  assert.equal(usage.length, 2)
  assert.deepEqual(usage[1]!.update._meta, {
    piAcp: {
      meters: [
        { label: '5h', percent: 88, resetInMs: 15_120_000, text: '5h 88% ↻4h12m' },
        { label: '1w', percent: 89, resetInMs: 500_400_000, text: '1w 89% ↻5d19h' }
      ]
    }
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-status-clear',
    method: 'setStatus',
    statusKey: 'subscription-usage',
    statusText: ''
  })
  await new Promise(r => setTimeout(r, 0))

  const cleared = conn.updates.filter(u => u.update.sessionUpdate === 'usage_update')
  assert.equal(cleared.length, 3)
  assert.equal(cleared[2]!.update._meta, undefined)
})

test('PiAcpSession: skips usage_update when pi reports no usable count', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const turn = session.prompt('hello')
  proc.emit({ type: 'agent_settled' })
  await turn

  assert.equal(conn.updates.filter(u => u.update.sessionUpdate === 'usage_update').length, 0)
})
