import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable'
import { bashCommand } from './bash.js'
import { toToolKind, toolResultContent } from './pi-tools.js'
import { getToolPath, toToolCallLocations } from './tool-args.js'

/**
 * Translates finished pi messages (as stored in a session or a pi-subagents `.output` transcript)
 * into ACP session updates. Used to replay a subagent's transcript into its child session.
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      const b = asRecord(block)
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

function toolTitle(name: string, args: unknown): string {
  if (name === 'bash') return bashCommand(args) ?? name
  const path = getToolPath(args)
  return path ? `${name} ${path}` : name
}

/** Convert one pi message into the ACP updates that render it. Unknown roles yield nothing. */
export function piMessageToUpdates(message: unknown, cwd: string): SessionUpdate[] {
  const m = asRecord(message)
  if (!m) return []

  if (m.role === 'user') {
    const text = textOf(m.content)
    return text ? [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }] : []
  }

  if (m.role === 'assistant') {
    if (!Array.isArray(m.content)) return []
    const updates: SessionUpdate[] = []
    for (const block of m.content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
        updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: b.text } })
      } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        updates.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: b.thinking } })
      } else if (b?.type === 'toolCall' && typeof b.id === 'string' && typeof b.name === 'string') {
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: b.id,
          title: toolTitle(b.name, b.arguments),
          kind: toToolKind(b.name),
          status: 'in_progress',
          rawInput: b.arguments,
          locations: toToolCallLocations(b.arguments, cwd)
        })
      }
    }
    return updates
  }

  if (m.role === 'toolResult' && typeof m.toolCallId === 'string') {
    const content = toolResultContent(m)
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: m.toolCallId,
        status: m.isError === true ? 'failed' : 'completed',
        content: content.length ? content : undefined
      }
    ]
  }

  return []
}
