import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStatusMeters } from '../../src/acp/usage-meters.js'

test('parseStatusMeters: reads window labels, percents and reset countdowns', () => {
  assert.deepEqual(parseStatusMeters('5h 88% ↻4h12m · 1w 89% ↻5d19h'), [
    { label: '5h', percent: 88, resetInMs: 15_120_000, text: '5h 88% ↻4h12m' },
    { label: '1w', percent: 89, resetInMs: 500_400_000, text: '1w 89% ↻5d19h' }
  ])
})

test('parseStatusMeters: keeps segments that carry no countdown', () => {
  assert.deepEqual(parseStatusMeters('5h 57%'), [{ label: '5h', percent: 57, text: '5h 57%' }])
})

test('parseStatusMeters: treats the under-a-minute countdown as its upper bound', () => {
  assert.deepEqual(parseStatusMeters('5h 3% ↻<1m'), [
    { label: '5h', percent: 3, resetInMs: 60_000, text: '5h 3% ↻<1m' }
  ])
})

test('parseStatusMeters: rejects text that is not a meter line', () => {
  assert.deepEqual(parseStatusMeters('auto-resume waiting for quota'), [])
  assert.deepEqual(parseStatusMeters('5h 88% ↻4h12m · waiting'), [])
  assert.deepEqual(parseStatusMeters(''), [])
})
