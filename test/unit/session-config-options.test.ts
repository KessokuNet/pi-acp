import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

test('PiAcpAgent: newSession returns configOptions for model and thinking selectors', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return {
            models: [
              { provider: 'test', id: 'alpha', name: 'Alpha' },
              { provider: 'test', id: 'beta', name: 'Beta' }
            ]
          }
        },
        async getAvailableThinkingLevels() {
          return { levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }
        },
        async getState() {
          return {
            thinkingLevel: 'high',
            model: { provider: 'test', id: 'beta' }
          }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(result.models?.currentModelId, 'test/beta')
    assert.equal(result.modes?.currentModeId, 'high')
    assert.deepEqual(result.configOptions, [
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: 'test/beta',
        options: [
          { value: 'test/alpha', name: 'test/Alpha', description: null },
          { value: 'test/beta', name: 'test/Beta', description: null }
        ]
      },
      {
        type: 'select',
        id: 'thought_level',
        category: 'thought_level',
        name: 'Thinking',
        description: 'Set the reasoning effort for this session',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Thinking: off', description: null },
          { value: 'minimal', name: 'Thinking: minimal', description: null },
          { value: 'low', name: 'Thinking: low', description: null },
          { value: 'medium', name: 'Thinking: medium', description: null },
          { value: 'high', name: 'Thinking: high', description: null },
          { value: 'xhigh', name: 'Thinking: xhigh', description: null }
        ]
      }
    ])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: advertises boolean config options when the client supports them', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      autoRetryEnabled: true,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'beta', name: 'Beta' }] }
        },
        async getAvailableThinkingLevels() {
          return { levels: ['off', 'high'] }
        },
        async getState() {
          return { thinkingLevel: 'high', model: { provider: 'test', id: 'beta' }, autoCompactionEnabled: false }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { session: { configOptions: { boolean: {} } } }
    } as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.deepEqual(
      result.configOptions.map(option => option.id),
      ['model', 'thought_level', 'auto_compaction', 'auto_retry']
    )
    assert.deepEqual(
      result.configOptions.find(option => option.id === 'auto_compaction'),
      {
        type: 'boolean',
        id: 'auto_compaction',
        name: 'Auto-compaction',
        description: 'Compact the context automatically when it approaches the model limit',
        currentValue: false
      }
    )
    assert.deepEqual(
      result.configOptions.find(option => option.id === 'auto_retry'),
      {
        type: 'boolean',
        id: 'auto_retry',
        name: 'Auto-retry',
        description: 'Retry a failed model request automatically',
        currentValue: true
      }
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: omits boolean config options when the client lacks the capability', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      autoRetryEnabled: true,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'beta', name: 'Beta' }] }
        },
        async getAvailableThinkingLevels() {
          return { levels: ['off', 'high'] }
        },
        async getState() {
          return { thinkingLevel: 'high', model: { provider: 'test', id: 'beta' }, autoCompactionEnabled: false }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.deepEqual(
      result.configOptions.map(option => option.id),
      ['model', 'thought_level']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: setSessionConfigOption toggles auto-retry and auto-compaction', async () => {
  const conn = new FakeAgentSideConnection()
  const retryCalls: boolean[] = []
  const compactionCalls: boolean[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    autoRetryEnabled: true,
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'beta', name: 'Beta' }] }
      },
      async getAvailableThinkingLevels() {
        return { levels: ['off', 'high'] }
      },
      async getState() {
        return { thinkingLevel: 'high', model: { provider: 'test', id: 'beta' }, autoCompactionEnabled: true }
      },
      async setAutoRetry(enabled: boolean) {
        retryCalls.push(enabled)
      },
      async setAutoCompaction(enabled: boolean) {
        compactionCalls.push(enabled)
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { session: { configOptions: { boolean: {} } } }
  } as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const retryResult = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'auto_retry',
    type: 'boolean',
    value: false
  } as any)

  assert.deepEqual(retryCalls, [false])
  assert.equal(session.autoRetryEnabled, false)
  assert.equal(retryResult.configOptions.find(option => option.id === 'auto_retry')?.currentValue, false)

  await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'auto_compaction',
    type: 'boolean',
    value: false
  } as any)

  assert.deepEqual(compactionCalls, [false])
  assert.equal(conn.updates.at(-1)?.update.sessionUpdate, 'config_option_update')
})

test('PiAcpAgent: rejects a boolean value for a select config option', async () => {
  const conn = new FakeAgentSideConnection()
  const session = { sessionId: 's1', cwd: process.cwd(), proc: {} }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(
    agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', type: 'boolean', value: true } as any),
    /Config option does not take a boolean: model/
  )
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config_option_update', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const setModelCalls: Array<{ provider: string; modelId: string }> = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [
            { provider: 'test', id: 'alpha', name: 'Alpha' },
            { provider: 'test', id: 'beta', name: 'Beta' }
          ]
        }
      },
      async getState() {
        return state
      },
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/beta'
  } as any)

  assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
  assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})

test('PiAcpAgent: setSessionConfigOption maps thought level changes to pi and emits sync updates', async () => {
  const conn = new FakeAgentSideConnection()
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  const thinkingLevels: string[] = []

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return {
          models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }]
        }
      },
      async getState() {
        return state
      },
      async getAvailableThinkingLevels() {
        return { levels: ['off', 'medium', 'xhigh'] }
      },
      async setThinkingLevel(level: string) {
        thinkingLevels.push(level)
        state.thinkingLevel = level
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'thought_level',
    value: 'xhigh'
  } as any)

  assert.deepEqual(thinkingLevels, ['xhigh'])
  assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'xhigh')
  assert.deepEqual(conn.updates, [
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'xhigh'
      }
    },
    {
      sessionId: 's1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: result.configOptions
      }
    }
  ])
})
