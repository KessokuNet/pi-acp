import test from 'node:test'
import assert from 'node:assert/strict'
import { terminalOutputDelta } from '../../src/acp/translate/bash.js'

test('terminalOutputDelta: appends accumulated output', () => {
  assert.equal(terminalOutputDelta('', 'one\n'), 'one\n')
  assert.equal(terminalOutputDelta('one\n', 'one\ntwo\n'), 'two\n')
  assert.equal(terminalOutputDelta('one\ntwo\n', 'one\ntwo\n'), '')
})

test('terminalOutputDelta: follows a sliding line window', () => {
  assert.equal(terminalOutputDelta('one\ntwo\nthree', 'two\nthree\nfour'), '\nfour')
  assert.equal(terminalOutputDelta('one\ntwo\nthree', 'three\nfour'), '\nfour')
})

test('terminalOutputDelta: sends everything when the snapshots do not overlap', () => {
  assert.equal(terminalOutputDelta('old', 'new'), 'new')
})
