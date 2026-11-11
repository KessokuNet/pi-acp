import test from 'node:test'
import assert from 'node:assert/strict'
import { promptToPiMessage } from '../../src/acp/translate/prompt.js'

const CWD = '/work/project'

test('promptToPiMessage: keeps resource links inline as readable references', () => {
  const { message, images } = promptToPiMessage(
    [
      { type: 'text', text: 'Compare ' },
      { type: 'resource_link', uri: 'file:///work/project/src/a.ts', name: 'a.ts' },
      { type: 'text', text: ' with ' },
      { type: 'resource_link', uri: 'file:///etc/hosts', name: 'hosts' },
      { type: 'text', text: ' and ' },
      { type: 'resource_link', uri: 'file:///work/project/src/', name: 'src' }
    ],
    CWD
  )

  assert.equal(message, 'Compare @src/a.ts with @/etc/hosts and @src/')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: formats a Zed selection with lines and attaches its text', () => {
  const { message } = promptToPiMessage(
    [
      { type: 'text', text: 'Why does ' },
      {
        type: 'resource',
        resource: { uri: 'file:///work/project/src/my%20file.ts#L10:12', text: 'a\nb\nc' }
      },
      { type: 'text', text: ' fail?' }
    ],
    CWD
  )

  assert.equal(
    message,
    'Why does @src/my file.ts:10-12 fail?\n\n<file name="/work/project/src/my file.ts" lines="10-12">\na\nb\nc\n</file>'
  )
})

test('promptToPiMessage: formats a Zed symbol and a single-line selection', () => {
  const { message } = promptToPiMessage(
    [
      { type: 'text', text: 'Rename ' },
      {
        type: 'resource',
        resource: { uri: 'file:///work/project/lib.rs?symbol=parse_args#L3:9', text: 'fn parse_args() {}' }
      },
      { type: 'text', text: ' near ' },
      { type: 'resource_link', uri: 'file:///work/project/lib.rs#L4:4', name: 'lib.rs (4:4)' }
    ],
    CWD
  )

  assert.equal(
    message,
    'Rename `parse_args` (@lib.rs:3-9) near @lib.rs:4\n\n<file name="/work/project/lib.rs" lines="3-9" symbol="parse_args">\nfn parse_args() {}\n</file>'
  )
})

test('promptToPiMessage: labels Zed-only context and fetched URLs', () => {
  const { message } = promptToPiMessage(
    [
      { type: 'text', text: 'Fix ' },
      { type: 'resource', resource: { uri: 'zed:///agent/diagnostics?include_warnings=true', text: 'E1' } },
      { type: 'text', text: ' per ' },
      { type: 'resource', resource: { uri: 'zed:///agent/git-diff?base=main', text: '+x' } },
      { type: 'text', text: ' and ' },
      { type: 'resource_link', uri: 'zed:///agent/thread/abc?name=Old+chat', name: 'Old chat' },
      { type: 'text', text: ' and ' },
      { type: 'resource', resource: { uri: 'https://example.com/doc', text: 'docs' } }
    ],
    CWD
  )

  assert.equal(
    message,
    'Fix @diagnostics per @git diff against main and @thread "Old chat" and @https://example.com/doc' +
      '\n\n<context ref="diagnostics">\nE1\n</context>' +
      '\n\n<context ref="git diff against main">\n+x\n</context>' +
      '\n\n<context ref="https://example.com/doc">\ndocs\n</context>'
  )
})

test('promptToPiMessage: notes binary resources without inlining them', () => {
  const blob = Buffer.from('xyz', 'utf8').toString('base64')
  const { message } = promptToPiMessage(
    [{ type: 'resource', resource: { uri: 'file:///work/project/a.bin', mimeType: 'application/octet-stream', blob } }],
    CWD
  )

  assert.equal(
    message,
    '@a.bin\n\n<file name="/work/project/a.bin">\n(binary application/octet-stream, 3 bytes, not included)\n</file>'
  )
})

test('promptToPiMessage: escapes quotes in attribute values', () => {
  const { message } = promptToPiMessage(
    [{ type: 'resource', resource: { uri: 'file:///work/project/a.ts?symbol=%22q%22#L1:1', text: 'x' } }],
    CWD
  )
  assert.match(message, /symbol="&quot;q&quot;"/)
})

test('promptToPiMessage: includes audio as marker', () => {
  const data = Buffer.from('abc', 'utf8').toString('base64')

  const { message, images } = promptToPiMessage([{ type: 'audio', mimeType: 'audio/wav', data }] as any)

  assert.equal(message, '\n[Audio] (audio/wav, 3 bytes) not supported by pi-acp')
  assert.deepEqual(images, [])
})

test('promptToPiMessage: maps image to pi image content', () => {
  const base64 = Buffer.from('abc', 'utf8').toString('base64')

  const { message, images } = promptToPiMessage([
    { type: 'text', text: 'see' },
    { type: 'image', mimeType: 'image/png', data: base64, uri: 'img-1' }
  ])

  assert.equal(message, 'see')
  assert.equal(images.length, 1)
  assert.deepEqual(images[0], {
    type: 'image',
    mimeType: 'image/png',
    data: base64
  })
})
