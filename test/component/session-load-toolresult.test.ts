import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

// pi keeps a tool's input in the assistant message that requested it and the output in a separate
// toolResult message; these fixtures mirror that session shape.
function fakeSpawn(messages: unknown[]) {
  return {
    onExit: () => () => {},
    onEvent: () => () => {},
    getMessages: async () => ({ messages }),
    getAvailableModels: async () => ({ models: [] }),
    getState: async () => ({ thinkingLevel: 'medium' })
  } as any
}

const bashToolCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'echo hello', timeout: 30 } }]
}
const bashToolResult = {
  role: 'toolResult',
  toolCallId: 'call_1',
  toolName: 'bash',
  content: [{ type: 'text', text: 'hello from bash' }],
  isError: false
}

async function replay(messages: unknown[], clientCapabilities?: unknown) {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => fakeSpawn(messages)

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    if (clientCapabilities) await agent.initialize({ protocolVersion: 1, clientCapabilities } as any)
    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    return conn.updates.map(u => (u as any).update)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
}

test('PiAcpAgent: loadSession replays a historic bash call as a text card with its command', async () => {
  // Zed advertises terminals, but a restored call's terminal died with the previous connection, so
  // replaying it as terminal content would leave an empty card.
  const updates = await replay([bashToolCall, bashToolResult], { terminal: true })

  const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
  assert.ok(toolCall)
  assert.equal(toolCall.toolCallId, 'call_1')
  assert.equal(toolCall.title, 'echo hello')
  assert.equal(toolCall.kind, 'execute')
  assert.equal(toolCall.status, 'completed')
  assert.deepEqual(toolCall.content, [{ type: 'content', content: { type: 'text', text: 'hello from bash' } }])
  assert.deepEqual(toolCall.rawInput, { command: 'echo hello', timeout: 30 })
  assert.equal(toolCall.locations, undefined)
  assert.equal(toolCall._meta, undefined)

  // No terminal `_meta` channel on replay, and no separate update to carry output.
  assert.equal(
    updates.find(u => u?._meta?.terminal_output),
    undefined
  )
  assert.equal(updates.filter(u => u?.sessionUpdate === 'tool_call_update').length, 0)
})

test('PiAcpAgent: loadSession replays a bash failure with its exit code', async () => {
  const updates = await replay([
    bashToolCall,
    { ...bashToolResult, isError: true, content: [{ type: 'text', text: 'boom' }] }
  ])

  const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
  assert.ok(toolCall)
  assert.equal(toolCall.status, 'failed')
  assert.deepEqual(toolCall.content, [{ type: 'content', content: { type: 'text', text: 'boom\n\nexit code: 1' } }])
})

test('PiAcpAgent: loadSession replays a non-bash call with its input and result', async () => {
  const updates = await replay([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_2', name: 'read', arguments: { path: '/tmp/project/a.ts' } }]
    },
    { role: 'toolResult', toolCallId: 'call_2', toolName: 'read', content: [{ type: 'text', text: 'file body' }] }
  ])

  const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
  assert.ok(toolCall)
  assert.equal(toolCall.title, 'read')
  assert.equal(toolCall.kind, 'read')
  assert.deepEqual(toolCall.rawInput, { path: '/tmp/project/a.ts' })
  assert.deepEqual(toolCall.locations, [{ path: '/tmp/project/a.ts' }])

  const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
  assert.ok(toolCallUpdate)
  assert.equal(toolCallUpdate.status, 'completed')
  assert.deepEqual(toolCallUpdate.content, [{ type: 'content', content: { type: 'text', text: 'file body' } }])
})

test('PiAcpAgent: loadSession replays thinking and text blocks in order', async () => {
  const updates = await replay([
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'weighing options' },
        { type: 'text', text: 'here is the answer' }
      ]
    }
  ])

  const chunks = updates.filter(
    u => u?.sessionUpdate === 'agent_thought_chunk' || u?.sessionUpdate === 'agent_message_chunk'
  )
  assert.deepEqual(chunks, [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing options' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'here is the answer' } }
  ])
})

test('PiAcpAgent: loadSession still replays a toolResult whose input is gone', async () => {
  // A compacted history can drop the assistant message that held the arguments.
  const updates = await replay([bashToolResult])

  const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
  assert.ok(toolCall)
  assert.equal(toolCall.title, 'bash')
  assert.equal(toolCall.rawInput, undefined)
  assert.deepEqual(toolCall.content, [{ type: 'content', content: { type: 'text', text: 'hello from bash' } }])
})
