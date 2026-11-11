import type { PlanEntry } from '@agentclientprotocol/sdk/unstable'

/**
 * Derives an ACP plan from pi-tasks' tool calls (`TaskCreate` / `TaskUpdate`) seen on the RPC event
 * stream, so clients get a task widget without a companion extension. The state is rebuilt from the
 * tool calls themselves, since pi-tasks has no event channel of its own.
 */
export const TASK_TOOL_NAMES = ['TaskCreate', 'TaskUpdate'] as const

export type TaskItem = {
  title: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type TaskPlanState = Map<string, TaskItem>

export function newTaskPlanState(): TaskPlanState {
  return new Map()
}

/** pi-tasks answers TaskCreate with `Task #<id> created successfully: <subject>`. */
const CREATED_RESULT = /^Task #(\S+) created successfully: (.*)$/m

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function normalizeStatus(value: unknown): TaskItem['status'] | undefined {
  switch (asString(value)?.toLowerCase()) {
    case 'pending':
      return 'pending'
    case 'in_progress':
    case 'in-progress':
      return 'in_progress'
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed'
    default:
      return undefined
  }
}

/**
 * Apply one finished task tool call. Returns true when the visible plan changed.
 * `status: 'deleted'` removes the task; unknown statuses are ignored.
 */
export function applyTaskToolResult(
  state: TaskPlanState,
  toolName: string,
  args: unknown,
  resultText: string
): boolean {
  if (toolName === 'TaskCreate') {
    const match = CREATED_RESULT.exec(resultText)
    if (!match) return false
    const [, id, subject] = match
    if (!id) return false
    state.set(id, { title: subject?.trim() || `Task #${id}`, status: 'pending' })
    return true
  }

  if (toolName === 'TaskUpdate') {
    const record = asRecord(args)
    const id = asString(record?.taskId)
    if (!id) return false

    const rawStatus = asString(record?.status)?.toLowerCase()
    if (rawStatus === 'deleted') return state.delete(id)

    const existing = state.get(id)
    const status = normalizeStatus(record?.status)
    const subject = asString(record?.subject)

    if (!existing) {
      // An update for a task the adapter never saw created still surfaces it.
      if (!status && !subject) return false
      state.set(id, { title: subject ?? `Task #${id}`, status: status ?? 'pending' })
      return true
    }

    let changed = false
    if (status && status !== existing.status) {
      existing.status = status
      changed = true
    }
    if (subject && subject !== existing.title) {
      existing.title = subject
      changed = true
    }
    return changed
  }

  return false
}

/** Flatten task state to ACP plan entries, tagged so clients can group them apart from other plans. */
export function toTaskPlanEntries(state: TaskPlanState): PlanEntry[] {
  const entries: PlanEntry[] = []
  for (const [, task] of state) {
    entries.push({
      content: task.title,
      priority: 'medium',
      status: task.status,
      _meta: { piAcp: { section: 'tasks' } }
    })
  }
  return entries
}
