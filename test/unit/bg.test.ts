import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bgTerminalCwd,
  bgTerminalText,
  bgTerminalTitle,
  isBgTerminalAction,
  isBgTool
} from '../../src/acp/translate/bg.js'

test('bg: recognises the bg tool and its log actions', () => {
  assert.equal(isBgTool('bg'), true)
  assert.equal(isBgTool('bash'), false)
  assert.equal(isBgTerminalAction({ action: 'start' }), true)
  assert.equal(isBgTerminalAction({ action: 'output' }), true)
  assert.equal(isBgTerminalAction({ action: 'status' }), false)
  assert.equal(isBgTerminalAction({}), false)
})

test('bg: titles a start with its command and an output with its unit', () => {
  assert.equal(bgTerminalTitle({ action: 'start', command: 'just test' }), 'just test')
  assert.equal(bgTerminalTitle({ action: 'start' }), 'bg start')
  assert.equal(bgTerminalTitle({ action: 'output', id: 'pi-systemd-tests-ab12' }), 'bg output pi-systemd-tests-ab12')
  assert.equal(bgTerminalTitle({ action: 'output' }), 'bg output')
})

test('bg: uses an absolute start cwd and falls back for relative ones', () => {
  assert.equal(bgTerminalCwd({ cwd: '/tmp/build' }, '/work'), '/tmp/build')
  assert.equal(bgTerminalCwd({ cwd: 'build' }, '/work'), '/work')
  assert.equal(bgTerminalCwd({}, '/work'), '/work')
})

test('bg: streams details.output instead of the model-facing body', () => {
  const text = bgTerminalText({
    content: [{ type: 'text', text: 'unit: active\nline 1\nline 2' }],
    details: { output: ['line 1', 'line 2'] }
  })
  assert.equal(text, 'line 1\nline 2')
})

test('bg: falls back to the rendered body without details.output', () => {
  const text = bgTerminalText({ content: [{ type: 'text', text: 'unit: active\nline 1' }] })
  assert.equal(text, 'unit: active\nline 1')
})
