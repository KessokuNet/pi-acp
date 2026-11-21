import { bashResultText } from './bash.js'

type BgArgs = {
  action?: unknown
  command?: unknown
  id?: unknown
  cwd?: unknown
}

export function isBgTool(toolName: string): boolean {
  return toolName.toLowerCase() === 'bg'
}

export function bgAction(value: unknown): string | undefined {
  const action = (value as { action?: unknown } | null | undefined)?.action
  return typeof action === 'string' && action.trim() ? action.trim() : undefined
}

/** Only actions that wrap a journal log are drawn as ACP terminals; status/list/stop stay cards. */
export function isBgTerminalAction(value: unknown): boolean {
  const action = bgAction(value)
  return action === 'start' || action === 'output'
}

export function bgTerminalTitle(value: unknown): string {
  const record = value as BgArgs | null | undefined
  const action = bgAction(value) ?? 'bg'
  if (action === 'start') {
    const command = typeof record?.command === 'string' ? record.command.trim() : ''
    return command || 'bg start'
  }
  const id = typeof record?.id === 'string' ? record.id.trim() : ''
  return id ? `bg ${action} ${id}` : `bg ${action}`
}

/** A relative `cwd` is resolved by systemd, not by the adapter, so only absolute ones are shown. */
export function bgTerminalCwd(value: unknown, fallback: string): string {
  const cwd = (value as BgArgs | null | undefined)?.cwd
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : fallback
}

/** `bg` returns the journal lines as details.output; older results only carry the rendered body. */
export function bgTerminalText(result: unknown): string {
  const output = (result as { details?: { output?: unknown } } | null | undefined)?.details?.output
  if (Array.isArray(output)) {
    return output.filter((line): line is string => typeof line === 'string').join('\n')
  }
  return bashResultText(result)
}
