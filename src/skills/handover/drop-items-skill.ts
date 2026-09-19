import type { BlockScanner } from '../../core/block-scanner.port.js'
import { countItems, describeItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemFacts } from '../../core/item-facts.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { DropIgnoreList } from '../recovery/drop-ignore-list.js'
import type { DropSpot } from './drop-spot.js'
import type { ItemRequest } from './handover.types.js'
import type { ItemThrower } from './item-thrower.js'
import { RequestPlanner } from './request-planner.js'

const RETREAT_DISTANCE = 4

export interface DropInput {
  readonly requests: readonly ItemRequest[]
  readonly keepReserve: boolean
}

export interface DropOutput {
  readonly dropped: readonly ItemCount[]
  readonly notCarried: readonly ItemCount[]
}

export interface DropItemsDeps {
  readonly inventory: InventoryReader
  readonly navigator: Navigator
  readonly blocks: BlockScanner
  readonly thrower: ItemThrower
  readonly spot: DropSpot
  readonly vitals: VitalsReader
  readonly facts: ItemFacts
  /** Told what was thrown away on purpose, so no recovery picks it up again. */
  readonly ignore: DropIgnoreList
}

/** Throws items on the ground where the bot stands (getting rid of junk), then steps away from them. */
export class DropItemsSkill implements Skill<DropInput, DropOutput> {
  readonly name = 'drop_items'
  private readonly planner: RequestPlanner

  constructor(private readonly deps: DropItemsDeps) {
    this.planner = new RequestPlanner(deps.facts)
  }

  async run(input: DropInput, context: SkillContext): Promise<SkillResult<DropOutput>> {
    const { deps } = this
    const snapshot = deps.inventory.snapshot()
    const here = deps.vitals.read()?.position
    if (snapshot === undefined || here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })

    const carried = countItems(snapshot)
    const planned = this.planner.plan(
      input.requests,
      { carried, stored: new Map() },
      input.keepReserve,
    )
    if (!planned.ok) return err({ ...planned.failure, detail: { ...planned.failure } })

    const drop: ItemCount[] = []
    const notCarried: ItemCount[] = [...planned.plan.nothingOf]
    for (const item of planned.plan.wanted) {
      const have = carried.get(item.name) ?? 0
      const count = item.all ? have : Math.min(item.count, have)
      if (count > 0) drop.push({ name: item.name, count })
      if (!item.all && count < item.count)
        notCarried.push({ name: item.name, count: item.count - count })
    }
    if (drop.length === 0)
      return err({
        reason: 'nothing_to_drop',
        message: `The bot carries none of what was asked for (${describeItems(notCarried)}).`,
      })

    const problem = deps.spot.problemAt(here)
    if (problem !== undefined)
      return err({
        reason: 'unsafe_drop_spot',
        message: `The bot will not drop items here: ${problem}.`,
      })

    context.progress(`Dropping ${describeItems(drop)}`)
    const dropped = await deps.thrower.throwAll(drop, context.signal)
    deps.ignore.add(dropped, here)
    // Step away so the bot does not pick the items up again.
    await deps.navigator.goToPosition({ x: here.x + RETREAT_DISTANCE, y: here.y, z: here.z }, 1.5, {
      signal: context.signal,
    })
    return ok({ dropped, notCarried })
  }
}
