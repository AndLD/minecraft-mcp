import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { MinecartPlacer } from '../../core/minecart.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { RailwayLog } from '../../state/railway-log.js'
import { isOpenAir, isReplaceable } from '../construction/block-match.js'
import { isRailName, POWERED_RAIL, RAIL } from './rail-table.js'

const APPROACH = 3
const NEAREST_RADIUS = 32

export interface PlaceMinecartInput {
  /** The rail to put it on. */
  readonly at: Position | undefined
  /** A railway (id or label) to put it at the start of. */
  readonly line: string | undefined
}

export interface PlaceMinecartOutput {
  readonly at: Position
  /** The railway it was put on, when it was found by railway. */
  readonly line: string | undefined
}

export interface PlaceMinecartDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly minecarts: MinecartPlacer
  readonly log: RailwayLog
}

/**
 * Puts a minecart on a rail: the one given, else the start of the named railway, else of the last one built, else the
 * nearest rail. A cart resting on a powered rail with a block behind it starts by itself, which is how a line built here
 * begins; riding it is up to the player.
 */
export class PlaceMinecartSkill implements Skill<PlaceMinecartInput, PlaceMinecartOutput> {
  readonly name = 'place_minecart'

  constructor(private readonly deps: PlaceMinecartDeps) {}

  async run(
    input: PlaceMinecartInput,
    context: SkillContext,
  ): Promise<SkillResult<PlaceMinecartOutput>> {
    const target = this.target(input)
    if (!target.ok) return target
    const { at, line } = target.value

    // Stand beside the line, not on it: a cart that meets the bot on the rails stops there.
    const spot = this.spotBeside(at)
    const walked =
      spot === undefined
        ? await this.deps.navigator.goToPosition(at, APPROACH, { signal: context.signal })
        : await this.deps.navigator.goToPosition(spot, 1, { signal: context.signal })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted')
        return err({ reason: 'aborted', message: 'Cancelled.' })
      return err({
        reason: 'unreachable',
        message: `Could not walk to the rail: ${walked.error.message}`,
      })
    }
    const placed = await this.deps.minecarts.place(at, context.signal)
    if (!placed.ok) return err({ reason: placed.error.reason, message: placed.error.message })
    return ok({ at, line })
  }

  /** A free cell two blocks from the rail, level with it, with ground under it and no rail in it. */
  private spotBeside(rail: Position): Position | undefined {
    for (const [dx, dz] of [
      [0, 2],
      [0, -2],
      [2, 0],
      [-2, 0],
      [2, 2],
      [-2, -2],
    ] as const) {
      const cell = { x: rail.x + dx, y: rail.y, z: rail.z + dz }
      const name = this.deps.blocks.blockAt(cell)
      const ground = this.deps.blocks.isSolid({ x: cell.x, y: cell.y - 1, z: cell.z })
      if (name !== undefined && (isOpenAir(name) || isReplaceable(name)) && ground === true)
        return cell
    }
    return undefined
  }

  private target(
    input: PlaceMinecartInput,
  ): SkillResult<{ at: Position; line: string | undefined }> {
    if (input.at !== undefined) return ok({ at: input.at, line: undefined })
    if (input.line !== undefined) {
      const found = this.deps.log.resolve(input.line)
      if (found === undefined)
        return err({ reason: 'unknown_railway', message: `There is no railway "${input.line}".` })
      return ok({ at: found.start, line: found.id })
    }
    const latest = this.deps.log.latest()
    if (latest !== undefined) return ok({ at: latest.start, line: latest.id })
    const nearest = this.deps.blocks
      .findBlocks({ names: [RAIL, POWERED_RAIL], maxDistance: NEAREST_RADIUS, count: 1 })
      .find((block) => isRailName(block.name))
    if (nearest === undefined)
      return err({
        reason: 'no_rail',
        message:
          'There is no railway built yet and no rail within 32 blocks. Give a rail position (at).',
      })
    return ok({ at: nearest.position, line: undefined })
  }
}
