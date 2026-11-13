import type { PlanEntry } from '@agentclientprotocol/sdk/unstable'

/**
 * pi-code's `todo` tool rewrites its whole list as one `pi-code:todo` custom entry after every
 * change, so the adapter can mirror it as a plan without a companion extension. Its statuses are
 * already ACP's three, and the entry keeps `activeForm` for the text of the running item.
 */
export const PI_CODE_TODO_CUSTOM_TYPE = 'pi-code:todo'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type TodoItem = {
  id: string
  text: string
  status: TodoStatus
  activeForm?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asStatus(value: unknown): TodoStatus | undefined {
  switch (asString(value)) {
    case 'pending':
      return 'pending'
    case 'in_progress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    default:
      return undefined
  }
}

/**
 * Parse the entry data (`{ todos, nextId }`). Returns `undefined` when the shape is unusable and an
 * empty array when the list was cleared.
 */
export function parseTodoEntry(data: unknown): TodoItem[] | undefined {
  const raw = asRecord(data)?.todos
  if (!Array.isArray(raw)) return undefined

  const items: TodoItem[] = []
  for (const candidate of raw) {
    const todo = asRecord(candidate)
    const text = asString(todo?.text)
    const status = asStatus(todo?.status)
    if (!text || !status) continue
    const id = todo?.id
    const activeForm = asString(todo?.activeForm)
    items.push({
      id: typeof id === 'number' || typeof id === 'string' ? String(id) : String(items.length),
      text,
      status,
      ...(activeForm ? { activeForm } : {})
    })
  }
  return items
}

/** Flatten the list to plan entries, tagged so clients can group it apart from other plans. */
export function toTodoPlanEntries(items: TodoItem[]): PlanEntry[] {
  return items.map(item => ({
    content: item.status === 'in_progress' ? (item.activeForm ?? item.text) : item.text,
    priority: 'medium',
    status: item.status,
    _meta: { piAcp: { section: 'todos', todo: { id: item.id, status: item.status } } }
  }))
}
