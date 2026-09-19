import type { Position } from '../core/position.types.js'
import type { BotHolder, EntityLike } from './bot-like.types.js'

export type PathOutcome =
  | { readonly kind: 'reached' }
  | { readonly kind: 'no_path' }
  | { readonly kind: 'failed'; readonly message: string }

/** A running movement. `cancel()` stops the bot; the outcome then settles as `failed`. */
export interface PathHandle {
  readonly outcome: Promise<PathOutcome>
  cancel(): void
}

/** Starts pathfinding movements. Implemented over the pathfinder plugin, faked in tests. */
export interface PathDriver {
  goNear(target: Position, range: number): PathHandle
  follow(playerName: string, distance: number): PathHandle
}

/** Creates the pathfinder plugin's goal objects, so this file does not import the plugin. */
export interface GoalFactory {
  near(x: number, y: number, z: number, range: number): unknown
  followEntity(entity: EntityLike, range: number): unknown
}

const failedHandle = (message: string): PathHandle => ({
  outcome: Promise.resolve({ kind: 'failed', message }),
  cancel: () => undefined,
})

export class MineflayerPathDriver implements PathDriver {
  constructor(
    private readonly holder: BotHolder,
    private readonly goals: GoalFactory,
  ) {}

  goNear(target: Position, range: number): PathHandle {
    const bot = this.holder.current()
    if (bot === undefined) return failedHandle('Not connected to a Minecraft world.')

    let cancelled = false
    const outcome = bot.pathfinder.goto(this.goals.near(target.x, target.y, target.z, range)).then(
      (): PathOutcome => ({ kind: 'reached' }),
      (error: unknown): PathOutcome => {
        const name = error instanceof Error ? error.name : ''
        const message = error instanceof Error ? error.message : String(error)
        if (cancelled) return { kind: 'failed', message: 'Cancelled.' }
        if (name === 'NoPath' || name === 'Timeout') return { kind: 'no_path' }
        return { kind: 'failed', message }
      },
    )
    return {
      outcome,
      cancel: () => {
        cancelled = true
        stopMoving(this.holder)
      },
    }
  }

  follow(playerName: string, distance: number): PathHandle {
    const bot = this.holder.current()
    if (bot === undefined) return failedHandle('Not connected to a Minecraft world.')
    const entity = Object.values(bot.players).find(
      (player) => player.username.toLowerCase() === playerName.toLowerCase(),
    )?.entity
    if (entity === undefined)
      return failedHandle(`${playerName} is not in view, so it cannot be followed.`)

    bot.pathfinder.setGoal(this.goals.followEntity(entity, distance), true)
    let settle: (outcome: PathOutcome) => void = () => undefined
    const outcome = new Promise<PathOutcome>((resolve) => {
      settle = resolve
    })
    return {
      outcome,
      cancel: () => {
        stopMoving(this.holder)
        settle({ kind: 'failed', message: 'Cancelled.' })
      },
    }
  }
}

function stopMoving(holder: BotHolder): void {
  const bot = holder.current()
  if (bot === undefined) return
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()
}
