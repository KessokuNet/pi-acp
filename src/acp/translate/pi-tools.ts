import type { ToolCallContent, ToolKind } from '@agentclientprotocol/sdk/unstable'

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
    case 'ls':
    case 'list':
      return 'read'
    case 'write':
    case 'edit':
    case 'patch':
      return 'edit'
    case 'bash':
      return 'execute'
    case 'grep':
    case 'find':
    case 'search':
      return 'search'
    case 'web_fetch':
    case 'webfetch':
    case 'fetch':
      return 'fetch'
    case 'think':
      return 'think'
    default:
      return 'other'
  }
}

/**
 * Tool-call content for a pi tool result: text and image blocks in the order pi emitted them.
 * pi's read tool returns image blocks as `{type:"image", data, mimeType}` alongside text.
 */
export function toolResultContent(result: unknown): ToolCallContent[] {
  const content = (result as { content?: unknown } | null | undefined)?.content
  const blocks: ToolCallContent[] = []

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const b = block as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
      if (b.type === 'text' && typeof b.text === 'string' && b.text) {
        blocks.push({ type: 'content', content: { type: 'text', text: b.text } })
      } else if (b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string') {
        blocks.push({ type: 'content', content: { type: 'image', data: b.data, mimeType: b.mimeType } })
      }
    }
  }

  if (blocks.length) return blocks
  // pi sent structured content we could not render (e.g. an image without a mime type); never
  // fall back to dumping the raw payload, which would leak base64 into the card.
  if (Array.isArray(content) && content.length) return []

  const text = toolResultToText(result)
  return text ? [{ type: 'content', content: { type: 'text', text } }] : []
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
