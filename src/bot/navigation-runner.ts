import type { Clock } from '../core/clock.port.js'
import type { NavigationFailure, NavigationProgress } from '../core/navigator.port.js'
import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { PathHandle } from './path-driver.js'

export interface NavigationRunnerOptions {
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Where the bot is now; undefined when it is no longer in a world. */
  readonly currentPosition: () => Position | undefined
  /** How often to look at progress. */
  readonly pollMs?: number
  /** Give up if the bot has not moved `minProgress` blocks for this long. */
  readonly stuckAfterMs?: number
  readonly minProgress?: number
  /** For following: give up when the target has been out of view this long. */
  readonly targetLostAfterMs?: number
}

export interface RunRequest {
  readonly start: () => PathHandle
  readonly signal: AbortSignal
  /** Overall limit. Undefined means no limit (following). */
  readonly timeoutMs?: number
  /** Enables stuck detection; the point the bot is heading to, for progress reporting. */
  readonly goal?: Position
  /** For following: whether the target is currently in view. */
  readonly targetInView?: () => boolean
  readonly onProgress?: ((progress: NavigationProgress) => void) | undefined
}

const DEFAULT_POLL_MS = 1_000
const DEFAULT_STUCK_AFTER_MS = 8_000
const DEFAULT_MIN_PROGRESS = 0.75
const DEFAULT_TARGET_LOST_AFTER_MS = 10_000

const fail = (
  reason: NavigationFailure['reason'],
  message: string,
): Result<never, NavigationFailure> => err({ reason, message })

/**
 * Supervises one pathfinding movement: reports progress, and gives up on abort, timeout,
 * being stuck, or losing the target. It never trusts the pathfinder to finish by itself.
 */
export class NavigationRunner {
  private readonly clock: Clock
  private readonly scheduler: Scheduler
  private readonly currentPosition: () => Position | undefined
  private readonly pollMs: number
  private readonly stuckAfterMs: number
  private readonly minProgress: number
  private readonly targetLostAfterMs: number

  constructor(options: NavigationRunnerOptions) {
    this.clock = options.clock
    this.scheduler = options.scheduler
    this.currentPosition = options.currentPosition
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.stuckAfterMs = options.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS
    this.minProgress = options.minProgress ?? DEFAULT_MIN_PROGRESS
    this.targetLostAfterMs = options.targetLostAfterMs ?? DEFAULT_TARGET_LOST_AFTER_MS
  }

  run(request: RunRequest): Promise<Result<Position, NavigationFailure>> {
    if (request.signal.aborted)
      return Promise.resolve(fail('aborted', 'Cancelled before it started.'))
    const startPosition = this.currentPosition()
    if (startPosition === undefined)
      return Promise.resolve(fail('not_connected', 'Not connected to a Minecraft world.'))

    const handle = request.start()

    return new Promise((resolve) => {
      let finished = false
      let cancelPoll = (): void => undefined
      let cancelTimeout = (): void => undefined
      let anchor = { at: this.clock.now(), position: startPosition }
      let targetLostSince: number | undefined

      /**
       * `stopMovement` is false when the movement ended by itself. Stopping an idle pathfinder
       * leaves a stale stop request that makes the next trip fail immediately.
       */
      const finish = (result: Result<Position, NavigationFailure>, stopMovement = true): void => {
        if (finished) return
        finished = true
        cancelPoll()
        cancelTimeout()
        request.signal.removeEventListener('abort', onAbort)
        if (stopMovement) handle.cancel()
        resolve(result)
      }
      const onAbort = (): void => {
        finish(fail('aborted', 'Cancelled.'))
      }

      const poll = (): void => {
        if (finished) return
        const position = this.currentPosition()
        if (position === undefined) {
          finish(fail('not_connected', 'Lost the connection while moving.'))
          return
        }
        const now = this.clock.now()
        request.onProgress?.({
          position,
          distanceRemaining:
            request.goal === undefined ? undefined : distanceBetween(position, request.goal),
        })

        if (request.goal !== undefined) {
          if (distanceBetween(position, anchor.position) >= this.minProgress)
            anchor = { at: now, position }
          else if (now - anchor.at >= this.stuckAfterMs) {
            finish(
              fail(
                'stuck',
                `The bot has not moved for ${String(Math.round(this.stuckAfterMs / 1000))} s; something blocks the way.`,
              ),
            )
            return
          }
        }
        if (request.targetInView !== undefined) {
          if (request.targetInView()) targetLostSince = undefined
          else {
            targetLostSince ??= now
            if (now - targetLostSince >= this.targetLostAfterMs) {
              finish(fail('target_not_found', 'The player went out of view.'))
              return
            }
          }
        }
        cancelPoll = this.scheduler.after(this.pollMs, poll)
      }

      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.timeoutMs !== undefined) {
        cancelTimeout = this.scheduler.after(request.timeoutMs, () => {
          finish(
            fail(
              'timeout',
              `Did not arrive within ${String(Math.round((request.timeoutMs ?? 0) / 1000))} s.`,
            ),
          )
        })
      }
      cancelPoll = this.scheduler.after(this.pollMs, poll)

      // The movement ended by itself, so it must not be told to stop.
      void handle.outcome.then((outcome) => {
        if (outcome.kind === 'reached') {
          const arrived = this.currentPosition()
          finish(
            arrived === undefined
              ? fail('not_connected', 'Lost the connection on arrival.')
              : ok(arrived),
            false,
          )
        } else if (outcome.kind === 'no_path') {
          finish(
            fail(
              'unreachable',
              'No path to the target: it is blocked, too far, or in unloaded terrain.',
            ),
            false,
          )
        } else {
          finish(fail('unreachable', outcome.message), false)
        }
      })
    })
  }
}
