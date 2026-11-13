import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultContent, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultContent: keeps text and image blocks in order', () => {
  const content = toolResultContent({
    content: [
      { type: 'text', text: 'read screenshot.png' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    ]
  })

  assert.deepEqual(content, [
    { type: 'content', content: { type: 'text', text: 'read screenshot.png' } },
    { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }
  ])
})

test('toolResultContent: renders an image-only result', () => {
  const content = toolResultContent({ content: [{ type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }] })
  assert.deepEqual(content, [{ type: 'content', content: { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' } }])
})

test('toolResultContent: falls back to text and skips unusable blocks', () => {
  assert.deepEqual(toolResultContent({ details: { stdout: 'ok\n', exitCode: 0 } }), [
    { type: 'content', content: { type: 'text', text: 'ok\n\n\nexit code: 0' } }
  ])
  assert.deepEqual(toolResultContent({ content: [{ type: 'image', data: 'CCCC' }] }), [])
  assert.deepEqual(toolResultContent(undefined), [])
})
