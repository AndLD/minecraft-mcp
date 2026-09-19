import type { Navigator } from '../../core/navigator.port.js'
import { roundPosition } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { BlockFinder } from '../../perception/block-finder.js'

export type GoToTarget =
  | { readonly kind: 'position'; readonly position: Position }
  | { readonly kind: 'player'; readonly name: string }
  | { readonly kind: 'block'; readonly name: string; readonly maxDistance: number }

export interface GoToInput {
  readonly target: GoToTarget
  /** Stop when within this many blocks of the target. */
  readonly within: number
}

export interface GoToOutput {
  readonly arrivedAt: Position
  /** Where the target was, for block targets. */
  readonly targetPosition?: Position
}

export class GoToSkill implements Skill<GoToInput, GoToOutput> {
  readonly name = 'goto'

  constructor(
    private readonly navigator: Navigator,
    private readonly blockFinder: BlockFinder,
  ) {}

  async run(input: GoToInput, context: SkillContext): Promise<SkillResult<GoToOutput>> {
    const options = {
      signal: context.signal,
      onProgress: (progress: { distanceRemaining: number | undefined }) => {
        if (progress.distanceRemaining !== undefined) {
          context.progress(`${String(Math.round(progress.distanceRemaining))} blocks to go`)
        }
      },
    }
    const target = input.target

    if (target.kind === 'position') {
      const result = await this.navigator.goToPosition(target.position, input.within, options)
      return result.ok ? ok({ arrivedAt: roundPosition(result.value) }) : err(result.error)
    }

    if (target.kind === 'player') {
      const result = await this.navigator.goToPlayer(target.name, input.within, options)
      return result.ok ? ok({ arrivedAt: roundPosition(result.value) }) : err(result.error)
    }

    const found = this.blockFinder.find({
      names: [target.name],
      maxDistance: target.maxDistance,
      count: 1,
    })
    if (!found.ok) return err({ reason: 'unknown_block', message: found.error })
    const block = found.value[0]
    if (block === undefined) {
      return err({
        reason: 'block_not_found',
        message: `No ${target.name} within ${String(target.maxDistance)} blocks in the loaded area.`,
      })
    }
    context.progress(`Found ${target.name} ${String(Math.round(block.distance))} blocks away`)
    const result = await this.navigator.goToPosition(block.position, input.within, options)
    return result.ok
      ? ok({ arrivedAt: roundPosition(result.value), targetPosition: block.position })
      : err(result.error)
  }
}
