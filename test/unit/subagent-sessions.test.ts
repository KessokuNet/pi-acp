import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, appendFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import {
  SubagentSessions,
  childSessionId,
  subagentOutputPath,
  type TranscriptReader
} from '../../src/acp/subagent-sessions.js'
import { piMessageToUpdates } from '../../src/acp/translate/pi-transcript.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const CWD = '/work/project'

test('piMessageToUpdates: translates user, assistant blocks and tool results', () => {
  assert.deepEqual(piMessageToUpdates({ role: 'user', content: 'Find the bug' }, CWD), [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Find the bug' } }
  ])

  const assistant = piMessageToUpdates(
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Looking.' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/a.ts' } }
      ]
    },
    CWD
  )
  assert.deepEqual(assistant, [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'read src/a.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'src/a.ts' },
      locations: [{ path: '/work/project/src/a.ts' }]
    }
  ])

  assert.deepEqual(
    piMessageToUpdates(
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: 'ok' }],
        isError: false
      },
      CWD
    ),
    [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
      }
    ]
  )
  assert.deepEqual(piMessageToUpdates({ role: 'system', content: 'x' }, CWD), [])
})

function harness(opts: { supportsSubagents: boolean; files?: Record<string, string> }) {
  const emitted: Array<{ sessionId: string; update: SessionUpdate }> = []
  const files = opts.files ?? {}
  const read: TranscriptReader = (path, offset) => {
    const text = files[path]
    if (text === undefined) return null
    return { text: text.slice(offset), size: text.length }
  }
  const bridge = new SubagentSessions({
    parentSessionId: 'parent',
    cwd: CWD,
    supportsSubagents: opts.supportsSubagents,
    emit: (sessionId, update) => emitted.push({ sessionId, update }),
    read,
    manualPolling: true
  })
  return { bridge, emitted, files }
}

const line = (message: unknown) => JSON.stringify({ isSidechain: true, agentId: 'a1', message }) + '\n'

test('SubagentSessions: links the Agent tool call by description and announces the child', () => {
  const { bridge, emitted } = harness({ supportsSubagents: true })

  bridge.onAgentToolStart('t-other', { description: 'Other task' })
  bridge.onAgentToolStart('t1', { description: 'Explore repo' })
  bridge.onAgent({ id: 'a1', type: 'Explore', description: 'Explore repo', status: 'created' })

  assert.deepEqual(emitted[0], {
    sessionId: 'parent',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      _meta: { subagent_session_info: { session_id: childSessionId('a1'), message_start_index: 0 } }
    }
  })
  assert.deepEqual(emitted[1], {
    sessionId: 'parent',
    update: {
      sessionUpdate: 'subagent_update',
      sessionId: childSessionId('a1'),
      title: 'Explore repo',
      description: 'Explore',
      cwd: CWD,
      state: { state: 'running' }
    }
  })
})

test('SubagentSessions: replays the transcript into the child session, handling split lines', () => {
  const path = subagentOutputPath(CWD, 'parent', 'a1')
  const { bridge, emitted, files } = harness({ supportsSubagents: true, files: {} })

  bridge.onAgent({ id: 'a1', description: 'Explore repo', status: 'started' })
  emitted.length = 0

  const full =
    line({ role: 'user', content: 'Explore' }) + line({ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] })
  files[path] = full.slice(0, full.length - 10)
  bridge.poll()
  files[path] = full
  bridge.poll()

  assert.deepEqual(
    emitted.map(e => [e.sessionId, e.update.sessionUpdate]),
    [
      [childSessionId('a1'), 'user_message_chunk'],
      [childSessionId('a1'), 'agent_message_chunk']
    ]
  )
})

test('SubagentSessions: completion drains the transcript, then reports idle', () => {
  const path = subagentOutputPath(CWD, 'parent', 'a1')
  const { bridge, emitted, files } = harness({ supportsSubagents: true, files: {} })

  bridge.onAgent({ id: 'a1', description: 'Explore repo', status: 'started' })
  files[path] = line({ role: 'assistant', content: [{ type: 'text', text: 'Final.' }] })
  emitted.length = 0
  bridge.onAgent({ id: 'a1', status: 'completed' })

  assert.deepEqual(
    emitted.map(e => e.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final.' } },
      {
        sessionUpdate: 'subagent_update',
        sessionId: childSessionId('a1'),
        state: { state: 'idle', stopReason: 'end_turn' }
      }
    ]
  )
})

test('SubagentSessions: the tool result agentId fixes the link', () => {
  const { bridge, emitted } = harness({ supportsSubagents: false })

  bridge.onAgentToolStart('t1', { description: 'Same' })
  bridge.onAgentToolStart('t2', { description: 'Same' })
  bridge.onAgent({ id: 'a2', description: 'Same', status: 'created' })
  bridge.onAgentToolEnd('t2', { details: { agentId: 'a2' } })

  const links = emitted.map(e => (e.update as { toolCallId?: string }).toolCallId)
  assert.deepEqual(links, ['t1', 't2'])
})

test('SubagentSessions: without the client capability, only the card link is sent', () => {
  const { bridge, emitted } = harness({ supportsSubagents: false })
  bridge.onAgentToolStart('t1', { description: 'Explore repo' })
  bridge.onAgent({ id: 'a1', description: 'Explore repo', status: 'started' })
  bridge.onAgent({ id: 'a1', status: 'completed' })

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]!.update.sessionUpdate, 'tool_call_update')
})

test('PiAcpSession: Agent tool + bridge entries + transcript file produce a native subagent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const sessionId = `test-${process.pid}-${Date.now()}`
  const cwd = process.cwd()
  const path = subagentOutputPath(cwd, sessionId, 'a1')
  mkdirSync(dirname(path), { recursive: true })

  const session = new PiAcpSession({
    sessionId,
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCapabilities: { subagents: {} }
  })

  try {
    proc.emit({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'Agent',
      args: { description: 'Explore repo' }
    })
    proc.emit({
      type: 'entry_appended',
      entry: {
        type: 'custom',
        customType: 'acp:subagents',
        data: { id: 'a1', description: 'Explore repo', status: 'started' }
      }
    })
    appendFileSync(path, line({ role: 'user', content: 'Explore' }))
    proc.emit({
      type: 'entry_appended',
      entry: { type: 'custom', customType: 'acp:subagents', data: { id: 'a1', status: 'completed' } }
    })
    await new Promise(r => setTimeout(r, 0))

    const kinds = conn.updates.map(u => [u.sessionId, u.update.sessionUpdate])
    assert.deepEqual(kinds, [
      [sessionId, 'tool_call'],
      [sessionId, 'tool_call_update'],
      [sessionId, 'subagent_update'],
      [childSessionId('a1'), 'user_message_chunk'],
      [sessionId, 'subagent_update']
    ])
  } finally {
    session.dispose()
    rmSync(dirname(dirname(path)), { recursive: true, force: true })
  }
})
