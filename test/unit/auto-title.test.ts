import test from 'node:test'
import assert from 'node:assert/strict'
import { installAutoTitle, normalizeTitle, type TitleApi } from '../../src/auto-title.js'

function fixture(existing = false) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
  const names: string[] = []
  let name: string | undefined
  let calls = 0
  let finish: (response: { content: Array<{ type: string; text: string }> }) => void = () => {}
  const pi: TitleApi = {
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    getSessionName: () => name,
    setSessionName: title => {
      name = title
      names.push(title)
      handlers.get('session_info_changed')?.({}, ctx)
    }
  }
  const ctx = {
    model: {},
    modelRegistry: {
      complete: () => {
        calls += 1
        return new Promise(resolve => {
          finish = resolve
        })
      }
    },
    sessionManager: { getSessionId: () => 's1', getBranch: () => (existing ? [{ message: { role: 'user' } }] : []) }
  }
  installAutoTitle(pi)
  const emit = (event: string, data: unknown = {}) => handlers.get(event)?.(data, ctx)
  emit('session_start')
  return {
    emit,
    pi,
    names,
    calls: () => calls,
    finish: () => finish({ content: [{ type: 'text', text: 'Fix parser errors' }] })
  }
}

async function inAcp(run: () => Promise<void>) {
  const previous = process.env.PI_ACP
  process.env.PI_ACP = '1'
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.PI_ACP
    else process.env.PI_ACP = previous
  }
}

test('auto titles run once outside the conversation after the first settled turn', () =>
  inAcp(async () => {
    const f = fixture()
    f.emit('before_agent_start', { prompt: 'Fix the parser' })
    f.emit('agent_settled', { aborted: false })
    f.finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    f.emit('agent_settled', { aborted: false })
    assert.equal(f.calls(), 1)
    assert.deepEqual(f.names, ['Fix parser errors'])
  }))

test('manual renames during generation win', () =>
  inAcp(async () => {
    const f = fixture()
    f.emit('before_agent_start', { prompt: 'Fix the parser' })
    f.emit('agent_settled', { aborted: false })
    f.pi.setSessionName?.('My title')
    f.finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(f.names, ['My title'])
  }))

test('existing sessions and aborted turns do not generate titles', () =>
  inAcp(async () => {
    for (const existing of [false, true]) {
      const f = fixture(existing)
      f.emit('before_agent_start', { prompt: 'Fix the parser' })
      f.emit('agent_settled', { aborted: true })
      assert.equal(f.calls(), 0)
    }
  }))

test('normalization rejects errors and bounds generated titles', () => {
  assert.equal(normalizeTitle({ content: [{ type: 'text', text: '"Fix parser"\nExplanation' }] }), 'Fix parser')
  assert.equal(normalizeTitle({ content: [{ type: 'text', text: 'bad' }], stopReason: 'error' }), undefined)
  assert.equal(normalizeTitle({ content: [{ type: 'text', text: 'x'.repeat(100) }] })?.length, 80)
})
