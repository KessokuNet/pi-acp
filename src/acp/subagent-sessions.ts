import type { SessionUpdate, StateUpdate } from '@agentclientprotocol/sdk/unstable'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BridgeSubagent } from './subagent-plan.js'
import { piMessageToUpdates } from './translate/pi-transcript.js'

/** pi-subagents' spawning tool. */
export const AGENT_TOOL_NAME = 'Agent'

/** Zed's tool-call `_meta` key that turns a tool call into a subagent card. */
const SUBAGENT_SESSION_INFO_META_KEY = 'subagent_session_info'

const POLL_MS = 500

/** Reads bytes appended to a file since `offset`; returns null when the file doesn't exist yet. */
export type TranscriptReader = (path: string, offset: number) => { text: string; size: number } | null

export const readAppended: TranscriptReader = (path, offset) => {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (size <= offset) return { text: '', size: offset }
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - offset)
    const read = readSync(fd, buffer, 0, buffer.length, offset)
    return { text: buffer.subarray(0, read).toString('utf8'), size: offset + read }
  } finally {
    closeSync(fd)
  }
}

/** Mirrors pi-subagents' `createOutputFilePath` (output-file.ts). */
export function subagentOutputPath(cwd: string, parentSessionId: string, agentId: string): string {
  const encoded = cwd
    .replace(/[/\\]/g, '-')
    .replace(/^[A-Za-z]:-/, '')
    .replace(/^-+/, '')
  return join(
    tmpdir(),
    `pi-subagents-${process.getuid?.() ?? 0}`,
    encoded,
    parentSessionId,
    'tasks',
    `${agentId}.output`
  )
}

export function childSessionId(agentId: string): string {
  return `pi-subagent-${agentId}`
}

type Child = {
  agentId: string
  toolCallId?: string
  title?: string
  description?: string
  status?: string
  /** Failure detail from pi-subagents, surfaced to the client as the stop reason's error. */
  error?: string
  announced: boolean
  offset: number
  partialLine: string
  finished: boolean
}

export type SubagentSessionsOptions = {
  parentSessionId: string
  cwd: string
  /** Whether the client accepts `subagent_update` and child-session traffic. */
  supportsSubagents: boolean
  emit: (sessionId: string, update: SessionUpdate) => void
  read?: TranscriptReader
  /** Disables the poll timer; tests drive `poll()` directly. */
  manualPolling?: boolean
}

const DONE = new Set(['completed', 'failed', 'error', 'aborted', 'stopped', 'cancelled'])

/** JSON-RPC error code for a failure pi did not classify; clients only read `message`. */
const SUBAGENT_ERROR_CODE = -32603

function idleState(status: string | undefined, error?: string): StateUpdate {
  if (status === 'completed') return { state: 'idle', stopReason: 'end_turn' }
  if (status === 'failed' || status === 'error') {
    return {
      state: 'idle',
      stopReason: 'error',
      ...(error ? { error: { code: SUBAGENT_ERROR_CODE, message: error } } : {})
    }
  }
  return { state: 'idle', stopReason: 'cancelled' }
}

/**
 * Presents pi-subagents children as ACP subagent sessions: links each `Agent` tool call to its child
 * so the client draws a subagent card, announces the child with `subagent_update`, and replays the
 * child's `.output` JSONL transcript as that child's session updates.
 */
export class SubagentSessions {
  private readonly children = new Map<string, Child>()
  private readonly pendingCalls: Array<{ toolCallId: string; description?: string }> = []
  private readonly read: TranscriptReader
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly opts: SubagentSessionsOptions) {
    this.read = opts.read ?? readAppended
  }

  onAgentToolStart(toolCallId: string, args: unknown): void {
    const description = (args as { description?: unknown } | null | undefined)?.description
    this.pendingCalls.push({ toolCallId, description: typeof description === 'string' ? description : undefined })
  }

  /** The tool result's `details.agentId` is authoritative and fixes any description-based guess. */
  onAgentToolEnd(toolCallId: string, result: unknown): void {
    const index = this.pendingCalls.findIndex(call => call.toolCallId === toolCallId)
    if (index >= 0) this.pendingCalls.splice(index, 1)

    const agentId = (result as { details?: { agentId?: unknown } } | null | undefined)?.details?.agentId
    if (typeof agentId !== 'string' || agentId === '') return
    const child = this.child(agentId)
    if (child.toolCallId !== toolCallId) this.link(child, toolCallId)
  }

  onAgent(agent: BridgeSubagent): void {
    const child = this.child(agent.id)
    if (agent.description) child.title = agent.description
    if (agent.type) child.description = agent.type
    const previous = child.status
    if (agent.status) child.status = agent.status
    if (agent.error) child.error = agent.error

    if (!child.toolCallId) {
      const call = this.takePendingCall(agent.description)
      if (call) this.link(child, call.toolCallId)
    }

    if (!this.opts.supportsSubagents) return

    const done = child.status !== undefined && DONE.has(child.status)
    if (!child.announced) {
      child.announced = true
      this.announce(child)
      this.ensureTimer()
    } else if (child.status !== previous && !done) {
      this.emitState(child)
    }

    if (done && !child.finished) {
      // Drain what the child wrote before it settled, then report the final state once.
      this.pollChild(child)
      child.finished = true
      this.emitState(child)
    }
  }

  poll(): void {
    for (const child of this.children.values()) {
      if (child.announced && !child.finished) this.pollChild(child)
    }
    if (![...this.children.values()].some(child => child.announced && !child.finished)) this.stopTimer()
  }

  dispose(): void {
    this.stopTimer()
  }

  private child(agentId: string): Child {
    let child = this.children.get(agentId)
    if (!child) {
      child = { agentId, announced: false, offset: 0, partialLine: '', finished: false }
      this.children.set(agentId, child)
    }
    return child
  }

  private takePendingCall(description: string | undefined) {
    const linked = new Set([...this.children.values()].map(child => child.toolCallId))
    const free = this.pendingCalls.filter(call => !linked.has(call.toolCallId))
    return free.find(call => description !== undefined && call.description === description) ?? free[0]
  }

  private link(child: Child, toolCallId: string): void {
    child.toolCallId = toolCallId
    this.opts.emit(this.opts.parentSessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      _meta: {
        [SUBAGENT_SESSION_INFO_META_KEY]: { session_id: childSessionId(child.agentId), message_start_index: 0 }
      }
    })
  }

  private announce(child: Child): void {
    this.opts.emit(this.opts.parentSessionId, {
      sessionUpdate: 'subagent_update',
      sessionId: childSessionId(child.agentId),
      title: child.title ?? child.agentId,
      description: child.description ?? null,
      cwd: this.opts.cwd,
      state: child.status && DONE.has(child.status) ? idleState(child.status, child.error) : { state: 'running' }
    })
  }

  private emitState(child: Child): void {
    this.opts.emit(this.opts.parentSessionId, {
      sessionUpdate: 'subagent_update',
      sessionId: childSessionId(child.agentId),
      state: child.status && DONE.has(child.status) ? idleState(child.status, child.error) : { state: 'running' }
    })
  }

  private pollChild(child: Child): void {
    const path = subagentOutputPath(this.opts.cwd, this.opts.parentSessionId, child.agentId)
    const chunk = this.read(path, child.offset)
    if (!chunk || !chunk.text) return
    child.offset = chunk.size

    const lines = (child.partialLine + chunk.text).split('\n')
    child.partialLine = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let entry: { message?: unknown }
      try {
        entry = JSON.parse(line) as { message?: unknown }
      } catch {
        continue
      }
      for (const update of piMessageToUpdates(entry.message, this.opts.cwd)) {
        this.opts.emit(childSessionId(child.agentId), update)
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer || this.opts.manualPolling) return
    this.timer = setInterval(() => this.poll(), POLL_MS)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}
