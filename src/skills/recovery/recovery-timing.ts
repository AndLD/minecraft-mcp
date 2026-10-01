import { DROP_DESPAWN_MS } from '../../state/drop-records.js'

/** Walking speed the estimate assumes; the pathfinder is slower than sprinting on flat ground. */
const WALK_BLOCKS_PER_SECOND = 3.5
/** Time kept in hand for the last steps: staging, checking for hazards, picking up scattered items. */
const PICKUP_ALLOWANCE_MS = 10_000
/** Never cut it closer than this to the moment the items vanish. */
const SAFETY_MARGIN_MS = 20_000

export type DeadlineCheck =
  | { readonly ok: true; readonly secondsLeft: number; readonly etaSeconds: number }
  | {
      readonly ok: false
      readonly reason: 'expired' | 'too_far'
      readonly secondsLeft: number
      readonly etaSeconds: number
    }

/** Whether the bot can be at the spot before the items vanish. Pure: the caller supplies the times. */
export function checkDeadline(input: {
  /** When the items hit the ground. */
  readonly at: number
  readonly now: number
  /** Straight-line distance to the spot, in blocks. */
  readonly distance: number
}): DeadlineCheck {
  const despawn = input.at + DROP_DESPAWN_MS
  const secondsLeft = Math.max(0, Math.round((despawn - input.now) / 1000))
  const etaSeconds = Math.ceil(input.distance / WALK_BLOCKS_PER_SECOND + PICKUP_ALLOWANCE_MS / 1000)
  if (input.now >= despawn) return { ok: false, reason: 'expired', secondsLeft: 0, etaSeconds }
  const arrival = input.now + etaSeconds * 1000
  if (arrival > despawn - SAFETY_MARGIN_MS)
    return { ok: false, reason: 'too_far', secondsLeft, etaSeconds }
  return { ok: true, secondsLeft, etaSeconds }
}
