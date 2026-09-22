import type { BlockScanner } from '../../core/block-scanner.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillFailure, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { ExcavateInput, ExcavateOutput } from '../excavation/excavate-skill.js'
import { surfaceOrigin } from '../excavation/providers/dig-down.js'
import { structuredSizeFor } from './structured-gather.js'

/** Only `run` is used: a narrow shape so a test double can stand in for the whole `ExcavateSkill`. */
export interface ExcavateRunner {
  run(input: ExcavateInput, context: SkillContext): Promise<SkillResult<ExcavateOutput>>
}

export interface StructuredGatherInput {
  /** One exact terrain block name (see `isTerrainBlock`); never a group or several names. */
  readonly block: string
  /** How many cells to dig; a quarry that does not divide evenly digs one layer more, not less. */
  readonly count: number
  readonly onInventoryFull?: InventoryFullKind | undefined
}

export interface StructuredGatherOutput {
  readonly mined: number
  readonly requested: number
  /**
   * What the inventory gained: a real quarry fills whatever the ground actually holds, so this can include more
   * than the block that was asked for.
   */
  readonly gained: readonly ItemCount[]
  readonly shape: string
  readonly origin: Position
}

export interface StructuredGatherDeps {
  readonly blocks: BlockScanner
  readonly vitals: VitalsReader
  readonly inventory: InventoryReader
  readonly excavate: ExcavateRunner
}

/**
 * Whether a structured-gather failure means the site was not suitable for a dig (the caller falls back to the
 * ordinary scattered dig, rather than refusing the request outright). `not_connected` and `aborted` are the only
 * reasons worth stopping for directly.
 */
export function isSiteUnsuitable(failure: SkillFailure): boolean {
  return failure.reason !== 'not_connected' && failure.reason !== 'aborted'
}

/**
 * Gathers a bulk terrain block by digging one small, contained quarry sized to the request, instead of a scatter
 * of single-block holes. A thin client of `ExcavateSkill`: the hazard rule, cave sealing, the walk-out stairs, and
 * the spoil and inventory-full policies all come from there, unchanged.
 */
export class StructuredGatherSkill implements Skill<StructuredGatherInput, StructuredGatherOutput> {
  readonly name = 'structured_gather'

  constructor(private readonly deps: StructuredGatherDeps) {}

  async run(
    input: StructuredGatherInput,
    context: SkillContext,
  ): Promise<SkillResult<StructuredGatherOutput>> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const origin = surfaceOrigin(vitals.position)
    const size = structuredSizeFor(deps.blocks, origin, input.block, input.count)
    const before = countItems(deps.inventory.snapshot())

    const excavated = await deps.excavate.run(
      {
        shape: 'quarry',
        params: {
          width: size.width,
          length: size.length,
          to_y: origin.y - size.depth + 1,
          exit: 'stairs',
          water_landing: false,
        },
        origin,
        fetchFromStorage: false,
        spoilPolicy: undefined,
        onInventoryFull: input.onInventoryFull,
      },
      context,
    )
    if (!excavated.ok) return err(excavated.error)

    const after = countItems(deps.inventory.snapshot())
    return ok({
      mined: excavated.value.broken,
      requested: input.count,
      gained: gained(before, after),
      shape: excavated.value.shape,
      origin: excavated.value.origin,
    })
  }
}
