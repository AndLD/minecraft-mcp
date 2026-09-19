import type { Clock } from '../core/clock.port.js'
import type { EntityScanner } from '../core/entity-scanner.port.js'
import type { NavigationFailure, NavigationOptions, Navigator } from '../core/navigator.port.js'
import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { BotHolder } from './bot-like.types.js'
import { NavigationRunner } from './navigation-runner.js'
import type { PathDriver } from './path-driver.js'

export interface MineflayerNavigatorOptions {
  readonly holder: BotHolder
  readonly driver: PathDriver
  readonly entities: EntityScanner
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Time allowed for any trip, plus `msPerBlock` for every block of distance. */
  readonly baseTimeoutMs?: number
  readonly msPerBlock?: number
}

const DEFAULT_BASE_TIMEOUT_MS = 30_000
const DEFAULT_MS_PER_BLOCK = 1_500

export class MineflayerNavigator implements Navigator {
  private readonly holder: BotHolder
  private readonly driver: PathDriver
  private readonly entities: EntityScanner
  private readonly runner: NavigationRunner
  private readonly baseTimeoutMs: number
  private readonly msPerBlock: number

  constructor(options: MineflayerNavigatorOptions) {
    this.holder = options.holder
    this.driver = options.driver
    this.entities = options.entities
    this.baseTimeoutMs = options.baseTimeoutMs ?? DEFAULT_BASE_TIMEOUT_MS
    this.msPerBlock = options.msPerBlock ?? DEFAULT_MS_PER_BLOCK
    this.runner = new NavigationRunner({
      clock: options.clock,
      scheduler: options.scheduler,
      currentPosition: () => this.holder.current()?.entity?.position,
    })
  }

  goToPosition(
    target: Position,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    return this.goNear(target, within, options)
  }

  goToPlayer(
    player: string,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    const info = this.entities.player(player)
    if (info === undefined)
      return Promise.resolve(fail('target_not_found', `${player} is not online.`))
    if (info.position === undefined) {
      return Promise.resolve(
        fail(
          'target_not_found',
          `${player} is online but out of view, so the bot cannot tell where they are.`,
        ),
      )
    }
    return this.goNear(info.position, within, options)
  }

  async follow(
    player: string,
    distance: number,
    options: NavigationOptions,
  ): Promise<Result<void, NavigationFailure>> {
    const result = await this.runner.run({
      start: () => this.driver.follow(player, distance),
      signal: options.signal,
      onProgress: options.onProgress,
      targetInView: () => this.entities.player(player)?.position !== undefined,
    })
    // Following only ends by being cancelled, which is the normal way to stop.
    if (result.ok || result.error.reason === 'aborted') return ok(undefined)
    return result
  }

  private goNear(
    target: Position,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    const here = this.holder.current()?.entity?.position
    const distance = here === undefined ? 0 : distanceBetween(here, target)
    return this.runner.run({
      start: () => this.driver.goNear(target, within),
      signal: options.signal,
      onProgress: options.onProgress,
      goal: target,
      timeoutMs: this.baseTimeoutMs + distance * this.msPerBlock,
    })
  }
}

const fail = (
  reason: NavigationFailure['reason'],
  message: string,
): Result<never, NavigationFailure> => err({ reason, message })
