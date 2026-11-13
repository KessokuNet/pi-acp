/** A quota window parsed from an extension status line, ready for a client-drawn meter. */
export interface PiAcpMeter {
  /** Window label as the extension writes it, e.g. `5h` or `1w`. */
  label: string
  /** Percent as displayed; the extension's `displayMode` decides whether that is left or used. */
  percent: number
  /** Time left until the window resets, from the display countdown. */
  resetInMs?: number
  /** The source segment, for clients that would rather print it verbatim. */
  text: string
}

const SEGMENT = /^(.+?)\s+(\d+(?:\.\d+)?)%(?:\s+↻(\S+))?$/
const COUNTDOWN = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/

/**
 * Parse a status line shaped like `5h 88% ↻4h12m · 1w 89% ↻5d19h` into meters. Any segment that
 * does not fit the shape makes the whole line non-meter text, so unrelated status messages stay out.
 */
export function parseStatusMeters(text: string): PiAcpMeter[] {
  const segments = text.split(' · ')
  const meters: PiAcpMeter[] = []

  for (const raw of segments) {
    const segment = raw.trim()
    const match = SEGMENT.exec(segment)
    if (!match) return []

    const label = (match[1] ?? '').trim()
    const percent = Number(match[2])
    if (!label || !Number.isFinite(percent)) return []

    const resetInMs = match[3] ? parseCountdown(match[3]) : undefined
    meters.push({ label, percent, ...(resetInMs === undefined ? {} : { resetInMs }), text: segment })
  }

  return meters
}

function parseCountdown(value: string): number | undefined {
  if (value === '<1m') return 60_000

  const match = COUNTDOWN.exec(value)
  if (!match) return undefined

  const [, days, hours, minutes] = match
  if (days === undefined && hours === undefined && minutes === undefined) return undefined

  return (Number(days ?? 0) * 1_440 + Number(hours ?? 0) * 60 + Number(minutes ?? 0)) * 60_000
}
