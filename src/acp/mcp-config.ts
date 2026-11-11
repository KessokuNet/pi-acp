import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk/unstable'
import { getPiAcpMcpPolicyPath } from './paths.js'

/** Env var carrying the client's MCP servers to the bundled pi extension, which registers them. */
export const MCP_SERVERS_ENV = 'PI_ACP_MCP_SERVERS'

// Marker older pi-acp versions wrote into a generated `<cwd>/.pi/mcp.json`.
const GENERATED_MARKER = 'pi-acp'

type PiMcpStdioEntry = { command: string; args?: string[]; env?: Record<string, string> }
type PiMcpHttpEntry = { url: string; headers?: Record<string, string> }
export type PiMcpEntry = PiMcpStdioEntry | PiMcpHttpEntry

export type McpTranslation = {
  /** Entries in pi's `mcpServers` shape, keyed by server name. */
  servers: Record<string, PiMcpEntry>
  /** Names of servers pi cannot express (sse / acp). */
  skipped: string[]
  /** Names left to the user's own `mcp.json` by the policy. */
  preserved: string[]
}

/**
 * Policy from `<pi-acp dataDir>/mcp-policy.json` (default `~/.pi/pi-acp/mcp-policy.json`):
 *
 *  - `generate`: which client servers pi-acp registers. `true`/`"*"`/omitted = all, `string[]` = only
 *    those names, `false` = none. Names are case-insensitive.
 *  - `exclude`: denylist applied after `generate`.
 *  - `auth`: for a registered server, add `Authorization: Bearer ${VAR}` and extra headers. pi expands
 *    `${VAR}` when it connects, so the token never appears in the adapter's process arguments.
 *
 * A server named in the user's `mcp.json` always wins over a registered one, so excluded servers and
 * same-named servers both keep the user's own entry and credentials.
 */
export type McpServerAuth = { bearerTokenEnv?: string; headers?: Record<string, string> }
export type McpPolicy = {
  generate?: boolean | '*' | string[]
  exclude?: string[]
  auth?: Record<string, McpServerAuth>
}

type NameValue = { name: string; value: string }

/** Load the MCP policy. Missing or invalid file → `{}` (register everything). */
export function loadMcpPolicy(path: string = getPiAcpMcpPolicyPath()): McpPolicy {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object') return {}
    const obj = raw as { generate?: unknown; exclude?: unknown; auth?: unknown }
    const out: McpPolicy = {}

    if (typeof obj.generate === 'boolean' || obj.generate === '*') out.generate = obj.generate
    else if (Array.isArray(obj.generate)) out.generate = obj.generate.filter((x): x is string => typeof x === 'string')

    if (Array.isArray(obj.exclude)) out.exclude = obj.exclude.filter((x): x is string => typeof x === 'string')

    if (obj.auth && typeof obj.auth === 'object') {
      const auth: Record<string, McpServerAuth> = {}
      for (const [name, val] of Object.entries(obj.auth as Record<string, unknown>)) {
        if (!val || typeof val !== 'object') continue
        const v = val as { bearerTokenEnv?: unknown; headers?: unknown }
        const entry: McpServerAuth = {}
        if (typeof v.bearerTokenEnv === 'string' && v.bearerTokenEnv) entry.bearerTokenEnv = v.bearerTokenEnv
        if (v.headers && typeof v.headers === 'object') {
          const headers: Record<string, string> = {}
          for (const [k, hv] of Object.entries(v.headers as Record<string, unknown>)) headers[k] = String(hv)
          if (Object.keys(headers).length) entry.headers = headers
        }
        auth[name] = entry
      }
      out.auth = auth
    }

    return out
  } catch {
    return {}
  }
}

function shouldRegister(name: string, policy: McpPolicy): boolean {
  const lc = name.toLowerCase()
  if ((policy.exclude ?? []).some(n => n.toLowerCase() === lc)) return false
  const gen = policy.generate
  if (gen === false) return false
  if (gen === undefined || gen === true || gen === '*') return true
  return gen.some(n => n.toLowerCase() === lc)
}

function toRecord(pairs: readonly NameValue[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of pairs ?? []) {
    if (p && typeof p.name === 'string') out[p.name] = String(p.value ?? '')
  }
  return out
}

/** Translate ACP `McpServer[]` into pi's built-in `mcpServers` entries. sse and acp are skipped. */
export function translateMcpServers(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = {}
): McpTranslation {
  const out: Record<string, PiMcpEntry> = {}
  const skipped: string[] = []
  const preserved: string[] = []

  for (const server of servers ?? []) {
    const name = String(server.name ?? '').trim()
    if (!name) continue

    if (!shouldRegister(name, policy)) {
      preserved.push(name)
      continue
    }

    const rule = policy.auth?.[name]
    const type = (server as { type?: string }).type

    if (!type || type === 'stdio') {
      const stdio = server as { command?: string; args?: string[]; env?: NameValue[] }
      const command = String(stdio.command ?? '').trim()
      if (!command) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpStdioEntry = { command, args: Array.isArray(stdio.args) ? stdio.args.map(String) : [] }
      const env = toRecord(stdio.env)
      if (Object.keys(env).length) entry.env = env
      out[name] = entry
    } else if (type === 'http') {
      const http = server as { url?: string; headers?: NameValue[] }
      const url = String(http.url ?? '').trim()
      if (!url) {
        skipped.push(name)
        continue
      }
      const entry: PiMcpHttpEntry = { url }
      const headers: Record<string, string> = { ...toRecord(http.headers), ...(rule?.headers ?? {}) }
      if (rule?.bearerTokenEnv) headers['Authorization'] = `Bearer \${${rule.bearerTokenEnv}}`
      if (Object.keys(headers).length) entry.headers = headers
      out[name] = entry
    } else {
      skipped.push(name)
    }
  }

  return { servers: out, skipped, preserved }
}

export type McpForwarding = {
  /** Env for the pi child: the server list for the bundled extension, plus the combiner URL. */
  env: Record<string, string>
  skipped: string[]
  preserved: string[]
}

/** Build the pi child's env so the bundled extension registers the client's MCP servers. */
export function mcpForwardingFor(
  servers: readonly McpServer[] | undefined | null,
  policy: McpPolicy = loadMcpPolicy()
): McpForwarding {
  const { servers: entries, skipped, preserved } = translateMcpServers(servers, policy)
  const env: Record<string, string> = { ...combinerEnvFor(servers) }
  if (Object.keys(entries).length) env[MCP_SERVERS_ENV] = JSON.stringify(entries)
  return { env, skipped, preserved }
}

/**
 * Best-effort removal of a `<cwd>/.pi/mcp.json` that an older pi-acp version generated (marked
 * `_generatedBy: pi-acp`). Never touches a hand-written file.
 */
export function cleanupStaleGeneratedConfig(cwd: string): void {
  const path = join(cwd, '.pi', 'mcp.json')
  try {
    if (!existsSync(path)) return
    const existing = JSON.parse(readFileSync(path, 'utf-8')) as { _generatedBy?: unknown }
    if (existing?._generatedBy === GENERATED_MARKER) rmSync(path, { force: true })
  } catch {
    // best effort
  }
}

const COMBINER_SESSION_HEADER = 'x-mcp-combiner-session'

/**
 * Env for the pi child when the client injected an mcp-combiner entry (mcp-companion does this per
 * chat): pi-mcp-combiner then joins the editor's per-chat combiner session. pi-mcp-combiner reads the
 * token only from the URL path, so a header-only token is folded into `/mcp/<token>`.
 */
export function combinerEnvFor(servers: readonly McpServer[] | undefined | null): Record<string, string> {
  for (const server of servers ?? []) {
    if ((server as { type?: string }).type !== 'http') continue
    const http = server as { url?: string; headers?: NameValue[] }
    const token = (http.headers ?? []).find(h => h?.name?.toLowerCase() === COMBINER_SESSION_HEADER)?.value
    const url = String(http.url ?? '')
      .trim()
      .replace(/\/+$/, '')
    if (!token || !url) continue
    return { MCP_COMPANION_COMBINER_URL: url.endsWith(`/${token}`) ? url : `${url}/${token}` }
  }
  return {}
}

/** Chat notice for servers pi-acp did not register. Null when there is nothing to report. */
export function buildMcpNotice(result: Pick<McpForwarding, 'skipped' | 'preserved'>): string | null {
  const lines: string[] = []
  if (result.preserved.length) {
    lines.push(`MCP servers left to your pi config (mcp-policy): ${result.preserved.join(', ')}.`)
  }
  if (result.skipped.length) {
    lines.push(`Skipped MCP servers pi cannot use (sse/acp): ${result.skipped.join(', ')}.`)
  }
  return lines.length ? lines.join('\n') : null
}
