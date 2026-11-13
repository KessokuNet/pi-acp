import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GOAL_STATE_CUSTOM_TYPE,
  PI_CODE_GOAL_CUSTOM_TYPE,
  parseGoalEntry,
  toGoalPlanEntries
} from '../../src/acp/goal-plan.js'
import { PI_CODE_TODO_CUSTOM_TYPE, parseTodoEntry, toTodoPlanEntries } from '../../src/acp/todo-plan.js'

test('pi-code todo: parses the list and keeps the running item text', () => {
  const todos = parseTodoEntry({
    nextId: 3,
    todos: [
      { id: 1, text: 'Read the spec', status: 'completed' },
      { id: 2, text: 'Write the decoder', status: 'in_progress', activeForm: 'Writing the decoder' },
      { id: 3, text: 'Run tests', status: 'pending' }
    ]
  })

  assert.ok(todos)
  assert.equal(todos.length, 3)
  const entries = toTodoPlanEntries(todos)
  assert.deepEqual(
    entries.map(e => [e.content, e.status]),
    [
      ['Read the spec', 'completed'],
      ['Writing the decoder', 'in_progress'],
      ['Run tests', 'pending']
    ]
  )
  assert.equal((entries[0]._meta as { piAcp: { section: string } }).piAcp.section, 'todos')
})

test('pi-code todo: empty list clears, bad shape is ignored', () => {
  assert.deepEqual(parseTodoEntry({ todos: [] }), [])
  assert.equal(parseTodoEntry({}), undefined)
  assert.equal(parseTodoEntry(null), undefined)
  assert.equal(parseTodoEntry({ todos: 'nope' }), undefined)
})

test('pi-code todo: entries with unknown status are skipped', () => {
  const todos = parseTodoEntry({ todos: [{ id: 1, text: 'x', status: 'done' }] })
  assert.deepEqual(todos, [])
})

test('pi-goal: active goal surfaces as in_progress and complete as completed', () => {
  const active = parseGoalEntry(GOAL_STATE_CUSTOM_TYPE, { goal: { id: 'g1', text: 'Ship it', status: 'active' } })
  assert.deepEqual(active, { goal: { text: 'Ship it', state: 'active', source: 'pi-goal', status: 'in_progress' } })

  const entries = toGoalPlanEntries(active!.goal)
  assert.equal(entries[0].content, 'Goal: Ship it')
  assert.equal(entries[0].status, 'in_progress')
  assert.equal(entries[0].priority, 'high')

  const complete = parseGoalEntry(GOAL_STATE_CUSTOM_TYPE, { goal: { text: 'Ship it', status: 'complete' } })
  assert.equal(complete!.goal!.status, 'completed')
})

test('pi-goal: cleared goal drops the row, malformed data is ignored', () => {
  assert.deepEqual(parseGoalEntry(GOAL_STATE_CUSTOM_TYPE, { goal: null }), { goal: null })
  assert.deepEqual(toGoalPlanEntries(null), [])
  assert.equal(parseGoalEntry(GOAL_STATE_CUSTOM_TYPE, { goal: { status: 'active' } }), undefined)
})

test('pi-code goal: active and achieved map, failed and cleared drop the row', () => {
  const active = parseGoalEntry(PI_CODE_GOAL_CUSTOM_TYPE, { state: 'active', condition: 'Land the todo plan' })
  assert.equal(active!.goal!.source, 'pi-code')
  assert.equal(active!.goal!.status, 'in_progress')

  const achieved = parseGoalEntry(PI_CODE_GOAL_CUSTOM_TYPE, { state: 'achieved', condition: 'Land the todo plan' })
  assert.equal(achieved!.goal!.status, 'completed')

  assert.deepEqual(parseGoalEntry(PI_CODE_GOAL_CUSTOM_TYPE, { state: 'failed', condition: 'x' }), { goal: null })
  assert.deepEqual(parseGoalEntry(PI_CODE_GOAL_CUSTOM_TYPE, { state: 'cleared' }), { goal: null })
})

test('goal entries from an unknown producer are ignored', () => {
  assert.equal(parseGoalEntry('acp:plan', { state: 'active' }), undefined)
  assert.equal(PI_CODE_TODO_CUSTOM_TYPE, 'pi-code:todo')
})
