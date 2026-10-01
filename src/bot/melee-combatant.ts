import type { Clock } from '../core/clock.port.js'
import type { AttackOutcome, Combatant, CombatFailure, GearReport } from '../core/combatant.port.js'
import { distanceBetween } from '../core/position.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { CombatDriver } from './combat-driver.js'
import { attackIntervalMs } from './gear.js'
import type { PathHandle } from './path-driver.js'

/** Melee reach (center to center) at which the bot stops chasing and starts hitting. */
export const STRIKE_DISTANCE = 2.8
/** How close the chase tries to get. */
const CHASE_DISTANCE = 1.8
const TICK_MS = 100

export interface MeleeCombatantOptions {
  readonly driver: CombatDriver
  readonly scheduler: Scheduler
  readonly clock: Clock
}

/** Chases a target and swings in time with the weapon's attack cooldown. */
export class MeleeCombatant implements Combatant {
  private readonly driver: CombatDriver
  private readonly scheduler: Scheduler
  private readonly clock: Clock

  constructor(options: MeleeCombatantOptions) {
    this.driver = options.driver
    this.scheduler = options.scheduler
    this.clock = options.clock
  }

  equipBestGear(): Promise<GearReport> {
    return this.driver.equipBestGear()
  }

  attack(
    entityId: number,
    options: { signal: AbortSignal; maxMs: number },
  ): Promise<Result<AttackOutcome, CombatFailure>> {
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))

    return new Promise((resolve) => {
      const startedAt = this.clock.now()
      let lastSwing = Number.NEGATIVE_INFINITY
      let chase: PathHandle | undefined
      let cancelTick = (): void => undefined
      let finished = false

      const finish = (result: Result<AttackOutcome, CombatFailure>): void => {
        if (finished) return
        finished = true
        cancelTick()
        options.signal.removeEventListener('abort', onAbort)
        chase?.cancel()
        resolve(result)
      }
      const onAbort = (): void => {
        finish(err({ reason: 'aborted', message: 'Cancelled.' }))
      }

      const tick = (): void => {
        if (finished) return
        const target = this.driver.target(entityId)
        if (target === undefined) {
          finish(ok('target_gone'))
          return
        }
        const here = this.driver.selfPosition()
        if (here === undefined) {
          finish(err({ reason: 'not_connected', message: 'Lost the connection while fighting.' }))
          return
        }

        const now = this.clock.now()
        if (distanceBetween(here, target.position) > STRIKE_DISTANCE) {
          chase ??= this.driver.approach(entityId, CHASE_DISTANCE)
        } else {
          if (chase !== undefined) {
            chase.cancel()
            chase = undefined
          }
          if (now - lastSwing >= attackIntervalMs(this.driver.heldItem())) {
            this.driver.swing(entityId)
            lastSwing = now
          }
        }
        if (now - startedAt >= options.maxMs) {
          finish(ok('still_fighting'))
          return
        }
        cancelTick = this.scheduler.after(TICK_MS, tick)
      }

      options.signal.addEventListener('abort', onAbort, { once: true })
      tick()
    })
  }
}
