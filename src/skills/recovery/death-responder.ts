import type { Clock } from '../../core/clock.port.js'
import type { DeathEvent, DeathWatcher } from '../../core/death-watcher.port.js'
import { roundPosition } from '../../core/position.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { DropRecoveryPolicy } from '../../state/drop-recovery-policy.js'
import type { DropRecords } from '../../state/drop-records.js'
import { describeBrief, subtractCounts, totalOf } from './item-counts.js'

/** The inventory is reset a moment after the respawn; only then does it show what was kept. */
const RESPAWN_SETTLE_MS = 2_000
/** Time for the respawn to finish (and reflexes to settle) before the bot walks back. */
const START_DELAY_MS = 3_000

export interface DeathResponderDeps {
  readonly watcher: DeathWatcher
  readonly records: DropRecords
  readonly policy: DropRecoveryPolicy
  readonly recovery: { start(recordId: string): Promise<void> }
  /** Cancels whatever task the bot was running: it died. */
  cancelTasks(): Promise<void>
  /** Puts an event into the agent's inbox. */
  emit(type: string, message: string): void
  /** Says something in the game chat. */
  say(text: string): void
  readonly clock: Clock
  readonly scheduler: Scheduler
}

/**
 * Reacts to the bot's death with plain code (no agent round trip): cancels the task, works out what was lost by
 * comparing the inventory from before with the one after the respawn (nothing lost means keepInventory is on),
 * writes the record with the coordinates, tells the player, and, when the policy says so, sends the bot back for
 * its items. It does not go back on its own when the bot died while already recovering: that is how a deadly spot
 * would cause one death after another.
 */
export class DeathResponder {
  private off: (() => void) | undefined

  constructor(private readonly deps: DeathResponderDeps) {}

  start(): void {
    this.off ??= this.deps.watcher.onDeath((event) => {
      void this.handle(event)
    })
  }

  stop(): void {
    this.off?.()
    this.off = undefined
  }

  private async handle(event: DeathEvent): Promise<void> {
    const { deps } = this
    const diedAt = deps.clock.now()
    const interrupted = deps.records.recovering()
    await deps.cancelTasks()
    for (const record of interrupted) {
      if (deps.records.get(record.id)?.status === 'recovering')
        deps.records.update(record.id, {
          status: totalOf(record.recovered) > 0 ? 'partial' : 'pending',
        })
    }

    await new Promise<void>((resolve) => {
      deps.scheduler.after(RESPAWN_SETTLE_MS, resolve)
    })
    const lost = subtractCounts(event.carried, deps.watcher.carried())
    const spot = roundPosition(event.position)
    const place = `${String(Math.round(spot.x))}, ${String(Math.round(spot.y))}, ${String(Math.round(spot.z))} in ${event.dimension}`
    const cause = event.cause === undefined ? 'The bot died' : `The bot died (${event.cause})`

    if (lost.length === 0) {
      const line = `${cause} at ${place}, but kept its inventory (keepInventory is on, or it carried nothing), so there is nothing to recover.`
      deps.emit('bot_died', line)
      deps.say(`I died at ${place}, but I kept my things.`)
      return
    }

    const added = deps.records.add({
      kind: 'death',
      position: event.position,
      dimension: event.dimension,
      at: diedAt,
      cause: event.cause ?? null,
      lost,
      note: null,
    })
    if (!added.ok) {
      deps.emit(
        'bot_died',
        `${cause} at ${place} and lost ${describeBrief(lost)}. No world profile is active, so the death could not be recorded and nothing will be recovered automatically.`,
      )
      return
    }
    const record = added.value
    const summary = `${cause} at ${place} and lost ${describeBrief(lost)} (${record.id}).`

    if (interrupted.length > 0) {
      deps.emit(
        'bot_died',
        `${summary} It died while recovering an earlier drop (${interrupted.map((r) => r.id).join(', ')}), so it will not go back on its own. ` +
          'Tell the player, and ask whether to try again (recover_drops).',
      )
      deps.say(`I died again at ${place}. I will not go back on my own; tell me if I should try.`)
      return
    }
    if (deps.policy.forKind('death') === 'skip') {
      deps.records.update(record.id, {
        status: 'abandoned',
        note: 'The drop recovery policy is skip.',
      })
      deps.emit(
        'bot_died',
        `${summary} Recovery is off (policy skip), so the items stay at ${place}. Tell the player the coordinates; recover_drops fetches them on request.`,
      )
      deps.say(`I died at ${place}. My items are there if you want them.`)
      return
    }
    deps.emit(
      'bot_died',
      `${summary} The bot recovers its items automatically. Tell the player where it died; skip_drop_recovery stops it.`,
    )
    deps.say(`I died at ${place}. I am going back for my items.`)
    deps.scheduler.after(START_DELAY_MS, () => {
      void deps.recovery.start(record.id)
    })
  }
}
