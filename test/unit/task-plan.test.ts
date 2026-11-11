import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { applyTaskToolResult, newTaskPlanState, toTaskPlanEntries } from '../../src/acp/task-plan.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('task plan: TaskCreate adds a pending entry from the tool result', () => {
  const state = newTaskPlanState()
  const changed = applyTaskToolResult(
    state,
    'TaskCreate',
    { subject: 'Fix login' },
    'Task #7 created successfully: Fix login'
  )

  assert.equal(changed, true)
  assert.deepEqual([...state.entries()], [['7', { title: 'Fix login', status: 'pending' }]])
})

test('task plan: TaskUpdate moves status and renames, deletes drop the entry', () => {
  const state = newTaskPlanState()
  applyTaskToolResult(state, 'TaskCreate', {}, 'Task #1 created successfully: First')
  applyTaskToolResult(state, 'TaskCreate', {}, 'Task #2 created successfully: Second')

  assert.equal(applyTaskToolResult(state, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, ''), true)
  assert.equal(state.get('1')?.status, 'in_progress')

  assert.equal(applyTaskToolResult(state, 'TaskUpdate', { taskId: '1', subject: 'Renamed' }, ''), true)
  assert.equal(state.get('1')?.title, 'Renamed')

  assert.equal(applyTaskToolResult(state, 'TaskUpdate', { taskId: '2', status: 'deleted' }, ''), true)
  assert.equal(state.has('2'), false)

  // A no-op update reports no change so the adapter skips the redundant plan emission.
  assert.equal(applyTaskToolResult(state, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, ''), false)
})

test('task plan: ignores unparsable create results and unknown tools', () => {
  const state = newTaskPlanState()
  assert.equal(applyTaskToolResult(state, 'TaskCreate', {}, 'nope'), false)
  assert.equal(applyTaskToolResult(state, 'TaskCreate', {}, 'Task #3 created successfully: '), true)
  assert.equal(state.get('3')?.title, 'Task #3')
  assert.equal(applyTaskToolResult(state, 'TaskGet', { taskId: '3' }, 'Task #3: x'), false)
  assert.equal(state.size, 1)
})

test('task plan: entries are tagged with the tasks section', () => {
  const state = newTaskPlanState()
  applyTaskToolResult(state, 'TaskCreate', {}, 'Task #1 created successfully: Only')
  assert.deepEqual(toTaskPlanEntries(state), [
    { content: 'Only', priority: 'medium', status: 'pending', _meta: { piAcp: { section: 'tasks' } } }
  ])
})

test('PiAcpSession: emits a plan update from pi-tasks tool calls', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'TaskCreate',
    args: { subject: 'Write tests' }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'TaskCreate',
    result: { content: [{ type: 'text', text: 'Task #1 created successfully: Write tests' }] },
    isError: false
  })

  await new Promise(r => setTimeout(r, 0))

  const plans = conn.updates.filter(u => u.update.sessionUpdate === 'plan')
  assert.equal(plans.length, 1)
  const update = plans[0]!.update as { entries: Array<{ content: string; status: string }> }
  assert.deepEqual(
    update.entries.map(e => [e.content, e.status]),
    [['Write tests', 'pending']]
  )
})

test('PiAcpSession: plan merges pi-tasks entries ahead of the subagent fleet', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'TaskCreate', args: {} })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'TaskCreate',
    result: { content: [{ type: 'text', text: 'Task #1 created successfully: Task one' }] },
    isError: false
  })
  proc.emit({
    type: 'entry_appended',
    entry: {
      type: 'custom',
      customType: 'acp:subagents',
      data: { id: 'abc12345', description: 'Explore repo', status: 'started' }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  const plans = conn.updates.filter(u => u.update.sessionUpdate === 'plan')
  const last = plans.at(-1)!.update as { entries: Array<{ content: string }> }
  assert.equal(last.entries.length, 2)
  assert.match(last.entries[0]!.content, /Task one/)
  assert.match(last.entries[1]!.content, /Explore repo/)
})
