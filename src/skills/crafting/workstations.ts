import type { BlockScanner } from '../../core/block-scanner.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { PlacementSpotFinder } from './placement-spot.js'

/** How far away an existing crafting table or furnace is still worth walking to. */
const SEARCH_DISTANCE = 32
/** Crafting and furnace windows open from about this close. */
const USE_RANGE = 2.5

export interface WorkstationDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly placer: Placer
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly spots: PlacementSpotFinder
}

/** Gets the bot next to a crafting table or furnace: walks to one that exists, or places one from the inventory. */
export class Workstations {
  constructor(private readonly deps: WorkstationDeps) {}

  /** True when one stands nearby or is carried. */
  available(blockName: string): boolean {
    return this.nearest(blockName) !== undefined || this.carried(blockName)
  }

  /** True when one stands within search distance. */
  standsNearby(blockName: string): boolean {
    return this.nearest(blockName) !== undefined
  }

  async ensure(blockName: string, context: SkillContext): Promise<SkillResult<Position>> {
    const existing = this.nearest(blockName)
    if (existing !== undefined) {
      const walked = await this.deps.navigator.goToPosition(existing, USE_RANGE, {
        signal: context.signal,
      })
      return walked.ok
        ? ok(existing)
        : err({
            reason: walked.error.reason === 'aborted' ? 'aborted' : 'unreachable',
            message: `Could not get to the ${blockName}: ${walked.error.message}`,
          })
    }

    if (!this.carried(blockName))
      return err({
        reason: `no_${blockName}`,
        message: `There is no ${blockName} nearby and none in the inventory.`,
      })
    const here = this.deps.vitals.read()?.position
    const spot = here === undefined ? undefined : this.deps.spots.find(here)
    if (spot === undefined)
      return err({
        reason: 'no_room',
        message: `There is no free spot next to the bot to place the ${blockName}.`,
      })

    const placed = await this.deps.placer.placeAt(blockName, spot)
    return placed.ok
      ? ok(spot)
      : err({
          reason: 'place_failed',
          message: `Could not place the ${blockName}: ${placed.error.message}`,
        })
  }

  /** The closest of several block names (a campfire and a soul campfire), within search distance. */
  nearestOf(blockNames: readonly string[]): Position | undefined {
    return this.deps.blocks.findBlocks({
      names: [...blockNames],
      maxDistance: SEARCH_DISTANCE,
      count: 1,
    })[0]?.position
  }

  private nearest(blockName: string): Position | undefined {
    return this.deps.blocks.findBlocks({
      names: [blockName],
      maxDistance: SEARCH_DISTANCE,
      count: 1,
    })[0]?.position
  }

  private carried(item: string): boolean {
    return (countItems(this.deps.inventory.snapshot()).get(item) ?? 0) > 0
  }
}
