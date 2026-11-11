import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('thinking options follow Pi, including max and future levels, and reject unsupported xhigh', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  let current = 'high'
  let levels = ['off', 'high', 'max']
  const selected: string[] = []
  const proc = {
    getAvailableThinkingLevels: async () => ({ levels }),
    getState: async () => ({ thinkingLevel: current }),
    getAvailableModels: async () => ({ models: [] }),
    setThinkingLevel: async (level: string) => {
      selected.push(level)
      current = level
    }
  }
  Object.defineProperty(agent, 'sessions', { value: { maybeGet: () => ({ sessionId: 's1', proc }) } })
  const result = await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'max' })
  const option = result.configOptions.find(option => option.id === 'thought_level')
  assert.equal(option?.currentValue, 'max')
  assert.ok(option && 'options' in option)
  assert.deepEqual(
    option.options.map(option => ('value' in option ? option.value : undefined)),
    levels
  )
  await assert.rejects(agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'xhigh' }), {
    code: -32602
  })
  levels = ['off', 'adaptive']
  await agent.setSessionMode({ sessionId: 's1', modeId: 'adaptive' })
  assert.deepEqual(selected, ['max', 'adaptive'])
})
