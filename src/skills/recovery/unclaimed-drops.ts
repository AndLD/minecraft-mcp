import type { Clock } from '../../core/clock.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { DropRecoveryPolicy } from '../../state/drop-recovery-policy.js'
import type { DropRecords } from '../../state/drop-records.js'
import { describeBrief } from './item-counts.js'

/** The standing default for how long a player gets to pick up what was thrown for them. */
export const UNCLAIMED_WAIT_MS = 60_000

export interface UnclaimedDrop {
  readonly items: readonly ItemCount[]
  readonly position: Position
  readonly dimension: string
  /** When the items were thrown. */
  readonly at: number
  readonly player: string
  /** Per call: true collects them back, false leaves them; undefined follows the standing policy. */
  readonly recollect: boolean | undefined
}

/** Where `give_items` reports what nobody picked up. */
export interface UnclaimedSink {
  track(drop: UnclaimedDrop): void
}

export interface UnclaimedDropsDeps {
  readonly records: DropRecords
  readonly policy: DropRecoveryPolicy
  readonly recovery: { start(recordId: string): Promise<void> }
  readonly emit: (type: string, message: string) => void
  /** How long thrown items may lie there before the bot takes them back. */
  readonly waitMs: number
  readonly clock: Clock
  readonly scheduler: Scheduler
}

/**
 * Keeps track of items thrown for a player that nobody picked up. With recovery on, the bot fetches them back after
 * a minute (and says so); off, they stay where they are, on record with their coordinates.
 */
export class UnclaimedDropHandler implements UnclaimedSink {
  constructor(private readonly deps: UnclaimedDropsDeps) {}

  track(drop: UnclaimedDrop): void {
    const { deps } = this
    const collect = drop.recollect ?? deps.policy.forKind('unclaimed') === 'auto'
    const spot = `${String(Math.round(drop.position.x))}, ${String(Math.round(drop.position.y))}, ${String(Math.round(drop.position.z))}`
    const added = deps.records.add({
      kind: 'unclaimed',
      position: drop.position,
      dimension: drop.dimension,
      at: drop.at,
      cause: null,
      lost: [...drop.items],
      status: collect ? 'pending' : 'abandoned',
      note: collect ? null : 'Left on the ground on purpose.',
    })
    if (!added.ok) return
    const what = `${describeBrief(drop.items)} thrown for ${drop.player}`
    if (!collect) {
      deps.emit(
        'drop_recovery',
        `Nobody picked up ${what}. They lie at ${spot}; the bot leaves them there as told (recover_drops fetches them later).`,
      )
      return
    }
    deps.emit(
      'drop_recovery',
      `Nobody picked up ${what} (at ${spot}). The bot takes them back in about ${String(Math.round(deps.waitMs / 1000))} seconds unless told otherwise (skip_drop_recovery).`,
    )
    const wait = Math.max(0, drop.at + deps.waitMs - deps.clock.now())
    deps.scheduler.after(wait, () => {
      void deps.recovery.start(added.value.id)
    })
  }
}
