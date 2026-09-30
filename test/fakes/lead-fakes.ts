import type { EntityInfo, EntityScanner, PlayerInfo } from '../../src/core/entity-scanner.port.js'
import type { Gaze } from '../../src/core/gaze.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import { distanceBetween } from '../../src/core/position.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Scheduler } from '../../src/core/scheduler.port.js'
import type { Vitals, VitalsReader } from '../../src/core/vitals.port.js'
import { FakeClock } from './fake-clock.js'
import { buildVitals } from './fake-ports.js'

export type PlayerBehaviour =
  /** Stands where it is. */
  | { readonly kind: 'idle' }
  /** Walks after the bot at this speed (blocks per second), stopping 2 blocks from it. */
  | { readonly kind: 'follow'; readonly speed: number }
  /** Walks in a direction at this speed. */
  | { readonly kind: 'walk'; readonly dx: number; readonly dz: number; readonly speed: number }

const BOT_SPEED = 4.3

/**
 * A bot and a player on flat ground. Time only passes when the bot walks or waits, and the player moves with it, so a
 * follower who lags, wanders, or stands still can be scripted.
 */
export class LeadWorld implements Navigator, EntityScanner, VitalsReader, Gaze {
  readonly clock = new FakeClock(0)
  bot: Position = { x: 0, y: 64, z: 0 }
  playerAt: Position | undefined = { x: 0, y: 64, z: 3 }
  online = true
  behaviour: PlayerBehaviour = { kind: 'idle' }
  dimension = 'minecraft:overworld'
  /** The largest distance there has been between the two. */
  maxSeparation = 0
  readonly legs: Position[] = []
  readonly toPlayerTrips: { within: number }[] = []
  readonly looks: (Position | undefined)[] = []
  navFailures: NavigationFailure[] = []
  /** Runs after time has passed (a test scripts the player here). */
  onTime: (world: LeadWorld) => void = () => undefined

  /** Lets `ms` pass: the player moves, the clock runs. */
  advance(ms: number): void {
    this.clock.advance(ms)
    const seconds = ms / 1000
    const player = this.playerAt
    if (player !== undefined) {
      const move = this.behaviour
      if (move.kind === 'follow') {
        const gap = distanceBetween(player, this.bot)
        const step = Math.min(move.speed * seconds, Math.max(0, gap - 2))
        if (gap > 0)
          this.playerAt = {
            x: player.x + ((this.bot.x - player.x) / gap) * step,
            y: player.y,
            z: player.z + ((this.bot.z - player.z) / gap) * step,
          }
      } else if (move.kind === 'walk') {
        this.playerAt = {
          x: player.x + move.dx * move.speed * seconds,
          y: player.y,
          z: player.z + move.dz * move.speed * seconds,
        }
      }
      this.maxSeparation = Math.max(
        this.maxSeparation,
        distanceBetween(this.playerAt ?? player, this.bot),
      )
    }
    this.onTime(this)
  }

  /** A scheduler whose waits let time pass in this world. */
  readonly scheduler: Scheduler = {
    after: (delayMs, callback) => {
      let cancelled = false
      queueMicrotask(() => {
        if (cancelled) return
        this.advance(delayMs)
        callback()
      })
      return () => {
        cancelled = true
      }
    },
  }

  goToPosition(
    target: Position,
    _within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.navFailures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    this.legs.push(target)
    this.advance((distanceBetween(this.bot, target) / BOT_SPEED) * 1000)
    this.bot = { ...target }
    return Promise.resolve(ok(target))
  }

  goToPlayer(
    _player: string,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const player = this.playerAt
    if (player === undefined)
      return Promise.resolve(err({ reason: 'target_not_found', message: 'Out of view.' }))
    this.toPlayerTrips.push({ within })
    const gap = distanceBetween(this.bot, player)
    const walk = Math.max(0, gap - within)
    this.advance((walk / BOT_SPEED) * 1000)
    const now = this.playerAt ?? player
    const remaining = distanceBetween(this.bot, now)
    if (remaining > 0) {
      const share = Math.min(1, Math.max(0, remaining - within) / remaining)
      this.bot = {
        x: this.bot.x + (now.x - this.bot.x) * share,
        y: this.bot.y,
        z: this.bot.z + (now.z - this.bot.z) * share,
      }
    }
    return Promise.resolve(ok(this.bot))
  }

  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }

  // EntityScanner
  knownEntityNames(): readonly string[] {
    return []
  }
  nearby(): readonly EntityInfo[] {
    return []
  }
  player(name: string): PlayerInfo | undefined {
    if (!this.online) return undefined
    return {
      name,
      online: true,
      position: this.playerAt,
      distance: this.playerAt === undefined ? undefined : distanceBetween(this.bot, this.playerAt),
    }
  }

  // VitalsReader
  read(): Vitals {
    return buildVitals({ position: this.bot, dimension: this.dimension })
  }

  // Gaze
  lookAt(target: Position): Promise<void> {
    this.looks.push(target)
    return Promise.resolve()
  }
}
