import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Gaze } from '../../core/gaze.port.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BedRegistry } from '../../state/bed-registry.js'
import { bedsExplode, colourOfBed, isBedName } from './bed-table.js'
import { findBedSpot } from './bed-spot.js'

const CONFIRM_TRIES = 5
const CONFIRM_MS = 300
const UP: Position = { x: 0, y: 1, z: 0 }

export interface PlaceBedInput {
  /** The cell for the foot end. Omit to use the nearest free two-block spot. */
  readonly at: Position | undefined
  /** A colour to place (`red`); any bed carried when left out. */
  readonly colour: string | undefined
}

export interface PlaceBedOutput {
  readonly foot: Position
  readonly head: Position
  readonly colour: string
}

export interface PlaceBedDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly inventory: InventoryReader
  readonly navigator: Navigator
  readonly placer: Placer
  readonly gaze: Gaze
  readonly guard: AreaGuard
  readonly registry: BedRegistry
  readonly scheduler: Scheduler
}

/**
 * Puts a bed from the inventory down. A bed is two blocks and lies in the direction the bot faces, so a single-cell
 * placement is not enough: the skill finds a free two-block spot, stands behind its foot, looks along it, and places.
 * Beds are made with `craft` (three wool and three planks).
 */
export class PlaceBedSkill implements Skill<PlaceBedInput, PlaceBedOutput> {
  readonly name = 'place_bed'

  constructor(private readonly deps: PlaceBedDeps) {}

  async run(input: PlaceBedInput, context: SkillContext): Promise<SkillResult<PlaceBedOutput>> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    if (bedsExplode(vitals.dimension))
      return err({
        reason: 'wrong_dimension',
        message: `A bed explodes in the Nether and the End, so the bot never places one there (it is in ${vitals.dimension}).`,
      })

    const wanted = input.colour === undefined ? undefined : `${input.colour}_bed`
    const item = deps.inventory
      .snapshot()
      ?.stacks.find((stack) =>
        wanted === undefined ? isBedName(stack.name) : stack.name === wanted,
      )
    if (item === undefined)
      return err({
        reason: 'no_bed_item',
        message: `The bot carries no ${wanted ?? 'bed'}. Craft one (craft "white_bed": three wool and three planks) or take one from a chest.`,
      })

    const around = input.at ?? {
      x: Math.floor(vitals.position.x),
      y: Math.floor(vitals.position.y),
      z: Math.floor(vitals.position.z),
    }
    const spot = findBedSpot(deps.blocks, deps.guard, around, input.at !== undefined)
    if (spot === undefined)
      return err({
        reason: 'no_space',
        message:
          input.at === undefined
            ? 'There is no free two-block spot with solid ground within 6 blocks. Move somewhere flatter or clear a space.'
            : 'A bed does not fit there: it needs two free cells in a row with solid ground and free air above, and a free cell behind the foot to stand on.',
      })

    const walked = await deps.navigator.goToPosition(spot.stand, 0, { signal: context.signal })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted')
        return err({ reason: 'aborted', message: 'Cancelled.' })
      return err({
        reason: 'unreachable',
        message: `Could not walk to the spot: ${walked.error.message}`,
      })
    }
    // Exactly on the standing cell: a bot left inside the bed's cells makes the server refuse the placement. The head
    // goes where the bot looks when it places the bed.
    await deps.gaze.lookAt({ x: spot.head.x + 0.5, y: spot.head.y + 0.3, z: spot.head.z + 0.5 })
    const placed = await deps.placer.placeAgainst(
      item.name,
      { x: spot.foot.x, y: spot.foot.y - 1, z: spot.foot.z },
      UP,
    )
    if (!placed.ok) return err({ reason: placed.error.reason, message: placed.error.message })

    for (let attempt = 0; attempt < CONFIRM_TRIES; attempt += 1) {
      if (isBedName(deps.blocks.blockAt(spot.foot))) {
        const colour = colourOfBed(item.name)
        deps.registry.note(spot.foot, colour)
        return ok({ foot: spot.foot, head: spot.head, colour })
      }
      await sleep(deps.scheduler, CONFIRM_MS, context.signal)
    }
    return err({
      reason: 'not_placed',
      message: 'The bed was not there after placing it; the game may have refused the spot.',
    })
  }
}
