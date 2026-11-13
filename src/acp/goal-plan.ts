import type { PlanEntry } from '@agentclientprotocol/sdk/unstable'

/**
 * Goal plugins persist their lifecycle as custom entries, one row is enough to show it in ACP.
 * Two producers write different shapes:
 *  - pi-goal: `goal-state` with `{ goal: { text, status, ... } | null }`, statuses `active`,
 *    `waiting`, `paused`, `blocked`, `usage_limited`, `budget_limited`, `complete`.
 *  - pi-code: `goal` with `{ state, condition }`, states `active`, `achieved`, `failed`, `cleared`.
 * ACP has no failed state, so an abandoned goal drops its row and the tool result carries the reason.
 */
export const GOAL_STATE_CUSTOM_TYPE = 'goal-state'
export const PI_CODE_GOAL_CUSTOM_TYPE = 'goal'

export type GoalSource = 'pi-goal' | 'pi-code'

export type GoalItem = {
  text: string
  status: 'in_progress' | 'completed'
  state: string
  source: GoalSource
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Parse either goal entry. Returns `undefined` for shapes this adapter does not understand and
 * `{ goal: null }` when the producer cleared the goal.
 */
export function parseGoalEntry(customType: string, data: unknown): { goal: GoalItem | null } | undefined {
  const record = asRecord(data)
  if (!record) return undefined

  if (customType === GOAL_STATE_CUSTOM_TYPE) {
    if (record.goal === null) return { goal: null }
    const goal = asRecord(record.goal)
    const text = asString(goal?.text)
    const state = asString(goal?.status)
    if (!text || !state) return undefined
    return {
      goal: { text, state, source: 'pi-goal', status: state === 'complete' ? 'completed' : 'in_progress' }
    }
  }

  if (customType === PI_CODE_GOAL_CUSTOM_TYPE) {
    const state = asString(record.state)
    const text = asString(record.condition)
    if (!state) return undefined
    if (state === 'cleared' || state === 'failed') return { goal: null }
    if (!text) return undefined
    return {
      goal: { text, state, source: 'pi-code', status: state === 'achieved' ? 'completed' : 'in_progress' }
    }
  }

  return undefined
}

/** One row, tagged so clients can group it apart from other plans and read the raw state. */
export function toGoalPlanEntries(goal: GoalItem | null): PlanEntry[] {
  if (!goal) return []
  return [
    {
      content: `Goal: ${goal.text}`,
      priority: 'high',
      status: goal.status,
      _meta: { piAcp: { section: 'goal', goal: { source: goal.source, state: goal.state } } }
    }
  ]
}
