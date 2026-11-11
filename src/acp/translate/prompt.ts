import type { ContentBlock } from '@agentclientprotocol/sdk/unstable'
import { isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PiImage = {
  type: 'image'
  mimeType: string
  data: string
}

/** A Zed mention, decoded from its URI (see Zed's `MentionUri::to_uri`). */
type Mention =
  | { kind: 'file'; path: string; lines?: [number, number]; symbol?: string; directory: boolean }
  | { kind: 'other'; label: string }

/** Parses Zed's `#L<start>:<end>` fragment; Zed already writes 1-based line numbers. */
function parseLines(hash: string): [number, number] | undefined {
  const match = /^#L(\d+)(?::(\d+))?$/.exec(hash)
  if (!match) return undefined
  const start = Number(match[1])
  return [start, match[2] ? Number(match[2]) : start]
}

function parseMention(uri: string, name: string | undefined): Mention {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return { kind: 'other', label: name ?? uri }
  }

  if (url.protocol === 'file:') {
    const bare = new URL(url.href)
    bare.search = ''
    bare.hash = ''
    let path: string
    try {
      path = fileURLToPath(bare)
    } catch {
      return { kind: 'other', label: name ?? uri }
    }
    return {
      kind: 'file',
      path,
      lines: parseLines(url.hash),
      symbol: url.searchParams.get('symbol') ?? undefined,
      directory: url.pathname.endsWith('/')
    }
  }

  if (url.protocol === 'zed:') {
    const segments = url.pathname.split('/').filter(Boolean)
    const kind = segments[1] ?? segments[0] ?? 'context'
    switch (kind) {
      case 'untitled-buffer': {
        const lines = parseLines(url.hash)
        return { kind: 'other', label: lines ? `untitled buffer${formatLines(lines)}` : 'untitled buffer' }
      }
      case 'thread':
        return { kind: 'other', label: `thread "${url.searchParams.get('name') ?? segments[2] ?? ''}"` }
      case 'git-diff':
        return { kind: 'other', label: `git diff against ${url.searchParams.get('base') ?? 'HEAD'}` }
      case 'merge-conflict':
        return { kind: 'other', label: `merge conflict in ${url.searchParams.get('path') ?? 'file'}` }
      case 'terminal-selection':
        return { kind: 'other', label: 'terminal selection' }
      case 'diagnostics':
        return { kind: 'other', label: 'diagnostics' }
      default:
        return { kind: 'other', label: name ?? kind.replace(/-/g, ' ') }
    }
  }

  // Fetched URLs and anything else: the URI is the most useful reference.
  return { kind: 'other', label: uri }
}

function formatLines([start, end]: [number, number]): string {
  return start === end ? `:${start}` : `:${start}-${end}`
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

/** The short reference that stays inline in the user's sentence. */
function inlineReference(mention: Mention, cwd: string): string {
  if (mention.kind === 'other') return `@${mention.label}`
  let ref = `@${displayPath(mention.path, cwd)}`
  if (mention.directory && !ref.endsWith('/')) ref += '/'
  if (mention.lines) ref += formatLines(mention.lines)
  return mention.symbol ? `\`${mention.symbol}\` (${ref})` : ref
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** The attached content, in the same `<file name="…">` form pi uses for its own `@file` mentions. */
function contextBlock(mention: Mention, body: string): string {
  if (mention.kind === 'other') return `<context ref="${attr(mention.label)}">\n${body}\n</context>`
  const attrs = [`name="${attr(mention.path)}"`]
  if (mention.lines) attrs.push(`lines="${mention.lines[0]}-${mention.lines[1]}"`)
  if (mention.symbol) attrs.push(`symbol="${attr(mention.symbol)}"`)
  return `<file ${attrs.join(' ')}>\n${body}\n</file>`
}

/**
 * Flattens an ACP prompt into pi's message text. Mentions stay inline as short readable
 * references, and their embedded contents follow the message as `<file>`/`<context>` blocks.
 */
export function promptToPiMessage(
  blocks: ContentBlock[],
  cwd: string = process.cwd()
): {
  message: string
  images: PiImage[]
} {
  let message = ''
  const attachments: string[] = []
  const images: PiImage[] = []

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        message += b.text
        break

      case 'resource_link':
        message += inlineReference(parseMention(b.uri, b.name), cwd)
        break

      case 'image':
        // pi expects base64 image bytes in `data` without a data-url prefix.
        images.push({ type: 'image', mimeType: b.mimeType, data: b.data })
        break

      case 'resource': {
        const resource = b.resource
        const mention = parseMention(resource.uri, undefined)
        message += inlineReference(mention, cwd)
        if ('text' in resource && typeof resource.text === 'string') {
          attachments.push(contextBlock(mention, resource.text))
        } else if ('blob' in resource && typeof resource.blob === 'string') {
          const mime = resource.mimeType ?? 'application/octet-stream'
          const bytes = Buffer.byteLength(resource.blob, 'base64')
          attachments.push(contextBlock(mention, `(binary ${mime}, ${bytes} bytes, not included)`))
        }
        break
      }

      case 'audio': {
        const bytes = Buffer.byteLength(b.data, 'base64')
        message += `\n[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`
        break
      }

      default:
        break
    }
  }

  if (attachments.length) message += `\n\n${attachments.join('\n\n')}`
  return { message, images }
}
