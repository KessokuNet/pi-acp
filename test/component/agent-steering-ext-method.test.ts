import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent, parseSteerParams } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

function makeAgent(session: any) {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  return { agent, conn }
}

test('PiAcpAgent: initialize advertises the steering extension', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const res = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {}
  } as any)

  assert.deepEqual(res._meta, { steering: { supported: true } })
})

test('PiAcpAgent: steerSession translates the prompt and forwards idleBehavior', async () => {
  const calls: Array<{ message: string; images: unknown[]; opts: unknown }> = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    steer: async (message: string, images: unknown[], opts: unknown) => {
      calls.push({ message, images, opts })
      return 'injected' as const
    }
  }
  const { agent } = makeAgent(session)

  const res = await agent.steerSession({
    sessionId: 's1',
    prompt: [
      { type: 'text', text: 'use a map instead' },
      { type: 'resource_link', uri: 'file:///tmp/a.ts', name: 'a.ts' }
    ],
    _meta: { steering: { idleBehavior: 'promptRequired' } }
  })

  assert.deepEqual(res, { outcome: 'injected' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].message, /use a map instead/)
  assert.match(calls[0].message, /a\.ts/)
  assert.deepEqual(calls[0].opts, { idleBehavior: 'promptRequired' })
})

test('PiAcpAgent: steerSession passes no idleBehavior when the client omits it', async () => {
  const calls: unknown[] = []
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    steer: async (_message: string, _images: unknown[], opts: unknown) => {
      calls.push(opts)
      return 'startedNewTurn' as const
    }
  }
  const { agent } = makeAgent(session)

  const res = await agent.steerSession({ sessionId: 's1', prompt: [{ type: 'text', text: 'go' }] })

  assert.deepEqual(res, { outcome: 'startedNewTurn' })
  assert.deepEqual(calls, [{ idleBehavior: undefined }])
})

test('parseSteerParams rejects malformed params', () => {
  assert.throws(() => parseSteerParams({}), /Missing sessionId/)
  assert.throws(() => parseSteerParams({ sessionId: 's1' }), /Missing prompt/)
})

test('parseSteerParams keeps idleBehavior and drops other meta', () => {
  const parsed = parseSteerParams({
    sessionId: 's1',
    prompt: [],
    _meta: { steering: { idleBehavior: 'promptRequired', other: true }, ignored: 1 }
  })

  assert.deepEqual(parsed, {
    sessionId: 's1',
    prompt: [],
    _meta: { steering: { idleBehavior: 'promptRequired' } }
  })
})
