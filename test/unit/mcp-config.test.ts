import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import {
  MCP_SERVERS_ENV,
  translateMcpServers,
  mcpForwardingFor,
  buildMcpNotice,
  loadMcpPolicy,
  cleanupStaleGeneratedConfig,
  combinerEnvFor
} from '../../src/acp/mcp-config.js'

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
}

test('combinerEnvFor: passes the tokened combiner URL through when the client sends one', () => {
  const header = (token: string) => [{ name: 'X-MCP-Combiner-Session', value: token }]
  assert.deepEqual(
    combinerEnvFor([
      { type: 'http', name: 'mcp-combiner', url: 'http://127.0.0.1:9741/mcp/tok', headers: header('tok') }
    ]),
    { MCP_COMPANION_COMBINER_URL: 'http://127.0.0.1:9741/mcp/tok' }
  )
  assert.deepEqual(
    combinerEnvFor([{ type: 'http', name: 'mcp-combiner', url: 'http://127.0.0.1:9741/mcp/', headers: header('tok') }]),
    { MCP_COMPANION_COMBINER_URL: 'http://127.0.0.1:9741/mcp/tok' }
  )
  assert.deepEqual(combinerEnvFor([{ type: 'http', name: 'other', url: 'http://x/mcp', headers: [] }]), {})
  assert.deepEqual(combinerEnvFor(undefined), {})
})

test('translateMcpServers: stdio server → command/args/env', () => {
  const { servers, skipped } = translateMcpServers([
    { name: 'chrome', command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: [{ name: 'KEY', value: 'v' }] }
  ])
  assert.deepEqual(skipped, [])
  assert.deepEqual(servers.chrome, { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: { KEY: 'v' } })
})

test('translateMcpServers: http server → url/headers', () => {
  const { servers } = translateMcpServers([
    {
      type: 'http',
      name: 'remote',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }]
    }
  ])
  assert.deepEqual(servers.remote, { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } })
})

test('translateMcpServers: sse/acp are skipped', () => {
  const { servers, skipped } = translateMcpServers([
    { type: 'sse', name: 'streamy', url: 'https://example.com/sse', headers: [] } as unknown as McpServer
  ])
  assert.deepEqual(skipped, ['streamy'])
  assert.deepEqual(servers, {})
})

test('mcpForwardingFor: passes servers to pi as JSON in the env, alongside the combiner URL', () => {
  const { env } = mcpForwardingFor(
    [
      { name: 'local', command: 'srv', args: [], env: [] },
      {
        type: 'http',
        name: 'mcp-combiner',
        url: 'http://127.0.0.1:9741/mcp/tok',
        headers: [{ name: 'X-MCP-Combiner-Session', value: 'tok' }]
      }
    ],
    {}
  )
  assert.equal(env.MCP_COMPANION_COMBINER_URL, 'http://127.0.0.1:9741/mcp/tok')
  const servers = JSON.parse(env[MCP_SERVERS_ENV]!) as Record<string, unknown>
  assert.deepEqual(Object.keys(servers), ['local', 'mcp-combiner'])
})

test('mcpForwardingFor: no servers → no env var', () => {
  assert.deepEqual(mcpForwardingFor([], {}).env, {})
  assert.deepEqual(mcpForwardingFor(undefined, {}).env, {})
})

test('cleanupStaleGeneratedConfig: removes a pi-acp-generated <cwd>/.pi/mcp.json, leaves a hand-authored one', () => {
  const cwd = tmpCwd()
  try {
    mkdirSync(join(cwd, '.pi'))
    const path = join(cwd, '.pi', 'mcp.json')

    writeFileSync(path, JSON.stringify({ mcpServers: {}, _generatedBy: 'pi-acp' }))
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(existsSync(path), false)

    writeFileSync(path, JSON.stringify({ mcpServers: { mine: { command: 'x' } } }))
    cleanupStaleGeneratedConfig(cwd)
    assert.equal(existsSync(path), true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('buildMcpNotice: lists preserved and skipped servers, silent otherwise', () => {
  const notice = buildMcpNotice({ skipped: ['streamy'], preserved: ['mcp-combiner'] })
  assert.match(notice!, /left to your pi config/)
  assert.match(notice!, /mcp-combiner/)
  assert.match(notice!, /streamy/)
  assert.equal(buildMcpNotice({ skipped: [], preserved: [] }), null)
})

test('policy: exclude keeps the user config; others still registered', () => {
  const { servers, preserved } = translateMcpServers(
    [
      { type: 'http', name: 'mcp-combiner', url: 'http://127.0.0.1:9741/mcp/tok', headers: [] },
      { type: 'http', name: 'other', url: 'http://localhost:1/mcp', headers: [] }
    ],
    { exclude: ['mcp-combiner'] }
  )
  assert.deepEqual(preserved, ['mcp-combiner'])
  assert.equal(servers['mcp-combiner'], undefined)
  assert.ok(servers.other)
})

test('policy: generate allowlist registers only named servers; case-insensitive', () => {
  const { servers, preserved } = translateMcpServers(
    [
      { type: 'http', name: 'Keep', url: 'http://localhost:1/mcp', headers: [] },
      { type: 'http', name: 'Drop', url: 'http://localhost:2/mcp', headers: [] }
    ],
    { generate: ['keep'] }
  )
  assert.ok(servers.Keep)
  assert.equal(servers.Drop, undefined)
  assert.deepEqual(preserved, ['Drop'])
})

test('policy: generate:false registers nothing', () => {
  const { servers, preserved } = translateMcpServers(
    [{ type: 'http', name: 'a', url: 'http://localhost:1/mcp', headers: [] }],
    { generate: false }
  )
  assert.deepEqual(servers, {})
  assert.deepEqual(preserved, ['a'])
})

test('policy.auth: bearerTokenEnv → a ${VAR} Authorization header that pi expands', () => {
  const { servers } = translateMcpServers(
    [{ type: 'http', name: 'foo', url: 'http://localhost:1/mcp', headers: [{ name: 'X-Session', value: 'tok' }] }],
    { auth: { foo: { bearerTokenEnv: 'FOO_TOKEN', headers: { 'X-Extra': 'e' } } } }
  )
  const entry = servers.foo as { headers: Record<string, string> }
  assert.equal(entry.headers['Authorization'], 'Bearer ${FOO_TOKEN}')
  assert.equal(entry.headers['X-Extra'], 'e')
  assert.equal(entry.headers['X-Session'], 'tok')
})

test('loadMcpPolicy: parses generate/exclude/auth; missing file → {}', () => {
  const dir = tmpCwd()
  try {
    const p = join(dir, 'policy.json')
    writeFileSync(
      p,
      JSON.stringify({
        generate: ['keep'],
        exclude: ['mcp-combiner'],
        auth: { foo: { bearerTokenEnv: 'T', headers: { A: 'b' } } }
      })
    )
    const loaded = loadMcpPolicy(p)
    assert.deepEqual(loaded.generate, ['keep'])
    assert.deepEqual(loaded.exclude, ['mcp-combiner'])
    assert.equal(loaded.auth?.foo.bearerTokenEnv, 'T')
    assert.deepEqual(loaded.auth?.foo.headers, { A: 'b' })

    const star = join(dir, 'star.json')
    writeFileSync(star, JSON.stringify({ generate: '*' }))
    assert.equal(loadMcpPolicy(star).generate, '*')

    assert.deepEqual(loadMcpPolicy(join(dir, 'nope.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
