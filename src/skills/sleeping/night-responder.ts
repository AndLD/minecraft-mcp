import type { Clock } from '../../core/clock.port.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BedRegistry } from '../../state/bed-registry.js'
import type { SleepPolicyKind } from '../../state/sleep-policy.js'
import { bedsExplode, isNight } from './bed-table.js'

/** A bed that could not be used (monsters, an obstruction) is tried again no sooner than this. */
const RETRY_MS = 90_000

export interface NightResponderDeps {
  readonly policy: { get(): SleepPolicyKind }
  readonly vitals: VitalsReader
  readonly registry: BedRegistry
  /** Whether a task, a reflex, or a hostile mob keeps the bot busy right now. */
  busy(): boolean
  /** Puts an event into the agent's inbox. */
  emit(type: string, message: string): void
  /** Starts going to bed. Resolves with whether the task started. */
  startSleep(): Promise<{ readonly ok: boolean; readonly message: string }>
  readonly clock: Clock
}

/**
 * Applies the player's sleep policy at nightfall, as plain code: `ask` tells the agent once per night (only when the
 * bot knows a bed), `when_idle` goes to bed by itself when nothing else is going on, `never` does nothing. Nothing
 * here ever forces the player to sleep or moves them.
 */
export class NightResponder {
  private handledNight = false
  private lastAttempt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: NightResponderDeps) {}

  /** Called every few seconds while connected. */
  async tick(): Promise<void> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined) return
    if (!isNight(vitals.timeOfDay)) {
      this.handledNight = false
      return
    }
    const policy = deps.policy.get()
    if (policy === 'never' || bedsExplode(vitals.dimension)) return
    if (deps.registry.nearest(vitals.position).length === 0) return

    if (policy === 'ask') {
      if (this.handledNight) return
      this.handledNight = true
      deps.emit(
        'needs_decision',
        'It is night and the bot knows a bed. Ask the player whether to go to bed (sleep). If they say to always sleep at night when idle, call set_sleep_policy with when_idle; with never the bot stops asking.',
      )
      return
    }
    if (this.handledNight || deps.busy() || deps.clock.now() - this.lastAttempt < RETRY_MS) return
    this.lastAttempt = deps.clock.now()
    const started = await deps.startSleep()
    // One try per night when it started; a refusal (monsters, no way there) is retried after a while.
    if (started.ok) this.handledNight = true
    deps.emit(
      'reflex',
      started.ok
        ? 'It is night and the bot is idle: going to bed, as the sleep policy says.'
        : `It is night, but going to bed did not start: ${started.message}`,
    )
  }
}
