import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { BlockUser } from '../../core/block-user.port.js'
import type { CampfireAccess } from '../../core/campfire.port.js'
import type { HiveAccess } from '../../core/hive.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'
import type { Bounds } from './farm-area.types.js'
import { campfireSpotBelow, smokeBelow } from './hive-smoke.js'
import type { InspectHivesSkill } from './inspect-hives-skill.js'
import { READY_LEVEL } from './inspect-hives-skill.js'

const APPROACH_RANGE = 3
const SETTLE_MS = 250
const CONFIRM_MS = 2_000
/** Angry bees within this many blocks of the bot or the hive end the run. */
const ANGER_RADIUS = 12
const BOTTLE = 'glass_bottle'
const SHEARS = 'shears'

export interface HarvestHoneyInput {
  /** `honey`: bottles (a glass bottle per hive). `honeycomb`: shears (three combs per hive). */
  readonly what: 'honey' | 'honeycomb'
  readonly farm: string | undefined
  /** One hive, by its position. */
  readonly at: Position | undefined
  /** Without a farm or a position: how far from the bot to look. */
  readonly radius: number
  /** Harvest at most this many hives. */
  readonly count: number | undefined
  /** `auto`: smoke each hive first (an existing campfire, or one placed under it). `never`: go without (the bees get angry). */
  readonly smoke: 'auto' | 'never'
  /** Craft glass bottles from glass when the bag has too few. */
  readonly craftBottles: boolean
}

export interface HarvestHoneyOutput {
  readonly honeyBottles: number
  readonly honeycomb: number
  /** Hives that were harvested. */
  readonly hives: number
  readonly skipped: {
    readonly notReady: number
    readonly protected: number
    readonly noSmoke: number
    readonly unreachable: number
    readonly noEffect: number
  }
  /** Campfires the bot placed to smoke hives (they are left where they are). */
  readonly campfiresPlaced: readonly Position[]
}

export interface HarvestHoneyDeps {
  readonly inspect: InspectHivesSkill
  readonly blocks: BlockScanner
  readonly hives: HiveAccess
  readonly campfires: CampfireAccess
  readonly user: BlockUser
  readonly placer: Placer
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly guard: AreaGuard
  readonly animals: AnimalScanner
  readonly farms: FarmRegistry
  readonly vitals: VitalsReader
  readonly scheduler: Scheduler
  readonly crafter?: ItemCrafter
}

const carried = (inventory: InventoryReader, item: string): number =>
  countItems(inventory.snapshot()).get(item) ?? 0

/**
 * Takes honey or honeycomb from the ripe hives (honey level 5) in reach, smoking each first: bees stay calm when a
 * lit campfire stands below the hive, and go for the bot when it does not. The campfire under a hive is used when
 * there is one, otherwise one from the bag is placed; it is never crafted, and without smoke the hive is left (unless
 * the call says `smoke: never`). The level is read back after each click. It stops at the first angry bee.
 */
export class HarvestHoneySkill implements Skill<HarvestHoneyInput, HarvestHoneyOutput> {
  readonly name = 'harvest_honey'

  constructor(private readonly deps: HarvestHoneyDeps) {}

  async run(
    input: HarvestHoneyInput,
    context: SkillContext,
  ): Promise<SkillResult<HarvestHoneyOutput>> {
    const { deps } = this
    const entry = input.farm === undefined ? undefined : deps.farms.resolve(input.farm)
    if (input.farm !== undefined && entry === undefined)
      return err({
        reason: 'unknown_farm',
        message: `There is no farm "${input.farm}". See list_farms.`,
      })
    const bounds: Bounds | undefined = entry?.bounds
    const own = entry?.label ?? undefined

    if (input.at !== undefined && deps.hives.stateAt(input.at) === undefined)
      return err({
        reason: 'no_hive',
        message: 'There is no beehive or bee nest at that position.',
      })

    const tool = input.what === 'honey' ? BOTTLE : SHEARS
    const missing = await this.ensureTool(input, tool, context)
    if (missing !== undefined) return missing

    const skipped = { notReady: 0, protected: 0, noSmoke: 0, unreachable: 0, noEffect: 0 }
    const placed: Position[] = []
    let honeyBottles = 0
    let honeycomb = 0
    let done = 0
    const here = deps.vitals.read()?.position
    const all = input.at === undefined ? deps.inspect.find(bounds, input.radius) : [input.at]
    const hives = [...all].sort(
      (a, b) =>
        (here === undefined ? 0 : distanceBetween(here, a)) -
        (here === undefined ? 0 : distanceBetween(here, b)),
    )

    for (const hive of hives) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (input.count !== undefined && done >= input.count) break
      if ((deps.hives.stateAt(hive)?.honeyLevel ?? 0) < READY_LEVEL) {
        skipped.notReady += 1
        continue
      }
      const area = deps.guard.protectedAt(hive)
      if (area !== undefined && area.label !== own) {
        skipped.protected += 1
        continue
      }
      if (input.what === 'honey' && carried(deps.inventory, BOTTLE) === 0) break

      if (input.smoke === 'auto') {
        const smoked = await this.smoke(hive, placed, context)
        if (smoked === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
        if (smoked === 'none') {
          skipped.noSmoke += 1
          continue
        }
      }

      const walked = await deps.navigator.goToPosition(hive, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted')
          return err({ reason: 'aborted', message: 'Cancelled.' })
        skipped.unreachable += 1
        continue
      }
      const before = carried(deps.inventory, input.what === 'honey' ? 'honey_bottle' : 'honeycomb')
      const clicked = await deps.user.use(hive, tool)
      const after = await this.settled(
        hive,
        input.what === 'honey' ? 'honey_bottle' : 'honeycomb',
        before,
        context,
      )
      if (!clicked.ok || after <= before) {
        skipped.noEffect += 1
      } else {
        done += 1
        if (input.what === 'honey') honeyBottles += after - before
        else honeycomb += after - before
        context.progress(`Harvested ${String(done)} hive(s)`)
      }
      if (this.angryBeesNear(hive))
        return this.stopped(honeyBottles, honeycomb, done, skipped, placed)
    }

    if (done === 0 && skipped.noSmoke > 0 && input.smoke === 'auto')
      return err({
        reason: 'no_smoke',
        message: `${String(skipped.noSmoke)} hive(s) are ready but have no lit campfire below them and the bot has none to place: harvesting them would anger the bees. A campfire is 3 sticks, a coal or charcoal, and 3 logs. Put one under the hive, or say so if the bees may be angered (smoke: never).`,
        detail: { noSmoke: skipped.noSmoke },
      })
    return ok({ honeyBottles, honeycomb, hives: done, skipped, campfiresPlaced: placed })
  }

  /** The tool the harvest needs, crafting glass bottles when allowed; a failure result when it cannot be had. */
  private async ensureTool(
    input: HarvestHoneyInput,
    tool: string,
    context: SkillContext,
  ): Promise<SkillResult<never> | undefined> {
    const { deps } = this
    if (carried(deps.inventory, tool) > 0) return undefined
    if (tool === BOTTLE && input.craftBottles && deps.crafter !== undefined) {
      const crafted = await deps.crafter.run({ item: BOTTLE, count: input.count ?? 3 }, context)
      if (crafted.ok && carried(deps.inventory, BOTTLE) > 0) return undefined
    }
    return err(
      tool === BOTTLE
        ? {
            reason: 'no_bottles',
            message:
              'The bot has no glass bottle. A bottle is made of 3 glass (smelt sand); it crafts them only when craft_bottles is set.',
          }
        : {
            reason: 'no_shears',
            message: 'The bot has no shears. They are made of 2 iron ingots.',
          },
    )
  }

  /** Makes sure a lit campfire stands below the hive, placing one from the bag when there is none. */
  private async smoke(
    hive: Position,
    placed: Position[],
    context: SkillContext,
  ): Promise<'smoked' | 'none' | 'aborted'> {
    const { deps } = this
    if (smokeBelow(deps.blocks, deps.campfires, hive) !== undefined) return 'smoked'
    if (carried(deps.inventory, 'campfire') === 0) return 'none'
    const spot = campfireSpotBelow(deps.blocks, hive)
    if (spot === undefined) return 'none'
    const area = deps.guard.protectedAt(spot)
    if (area !== undefined) return 'none'
    const walked = await deps.navigator.goToPosition(spot, APPROACH_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok) return walked.error.reason === 'aborted' ? 'aborted' : 'none'
    const put = await deps.placer.placeAt('campfire', spot)
    if (!put.ok) return 'none'
    await sleep(deps.scheduler, SETTLE_MS, context.signal)
    if (smokeBelow(deps.blocks, deps.campfires, hive) === undefined) return 'none'
    placed.push(spot)
    return 'smoked'
  }

  /** The count of the product after the click, waiting a moment for the server. */
  private async settled(
    hive: Position,
    product: string,
    before: number,
    context: SkillContext,
  ): Promise<number> {
    const { deps } = this
    for (let waited = 0; waited < CONFIRM_MS; waited += SETTLE_MS) {
      await sleep(deps.scheduler, SETTLE_MS, context.signal)
      const now = carried(deps.inventory, product)
      if (now > before && (deps.hives.stateAt(hive)?.honeyLevel ?? 0) < READY_LEVEL) return now
      if (context.signal.aborted) break
    }
    return carried(deps.inventory, product)
  }

  private angryBeesNear(hive: Position): boolean {
    return this.deps.animals
      .nearby(ANGER_RADIUS + 4)
      .some(
        (animal) =>
          animal.species === 'bee' &&
          animal.angry === true &&
          distanceBetween(animal.position, hive) <= ANGER_RADIUS,
      )
  }

  private stopped(
    honeyBottles: number,
    honeycomb: number,
    done: number,
    skipped: HarvestHoneyOutput['skipped'],
    placed: readonly Position[],
  ): SkillResult<HarvestHoneyOutput> {
    return err({
      reason: 'bees_angry',
      message: `The bees are angry, so the harvest stopped after ${String(done)} hive(s) (${String(honeyBottles)} honey bottles, ${String(honeycomb)} honeycomb). Get away from the hive; the survival reflexes deal with stings.`,
      detail: { honeyBottles, honeycomb, hives: done, skipped, campfiresPlaced: placed },
    })
  }
}
