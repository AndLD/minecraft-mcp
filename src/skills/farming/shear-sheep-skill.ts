import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import { productSkip, tally, type Skipped } from './animal-products.js'
import { insideBounds, type Bounds } from './farm-area.types.js'
import type { PenGateGuard } from './pen-gate-guard.js'

const SEARCH_RADIUS = 32
const APPROACH_RANGE = 2.5
/** How long to wait for the sheep to show as sheared after the click. */
const CONFIRM_MS = 2_000
const CONFIRM_POLL_MS = 250
const PICKUP_RADIUS = 5

export interface ShearSheepInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** How many sheep to shear at most; every shearable one in reach when undefined. */
  readonly count: number | undefined
  /** Without a farm or an area: how far from the bot to look. */
  readonly maxDistance: number
  /** Only sheep of this wool colour (`white`, `light_blue`, ...). */
  readonly colour: string | undefined
}

export interface ShearSheepOutput {
  readonly sheared: number
  /** The wool gained, by colour (`white_wool` and so on). */
  readonly wool: Readonly<Record<string, number>>
  readonly skipped: Skipped
  /** Set when the pen's gate could not be shut at the end. */
  readonly gateLeftOpen?: string
}

export interface ShearSheepDeps {
  readonly animals: AnimalScanner
  readonly interaction: AnimalInteraction
  readonly navigator: Navigator
  readonly inventory: InventoryReader
  readonly drops: Pick<DropCollector, 'collect'>
  readonly farms: FarmRegistry
  readonly scheduler: Scheduler
  readonly gates?: PenGateGuard
}

const isWool = (name: string): boolean => name.endsWith('_wool')

/**
 * Takes the wool of adult sheep with shears: walks up to each sheep, uses the shears on it, waits for the sheep to show
 * as sheared, and picks up the wool. Sheep are left alive (the wool grows back). Never touches a baby, a named, tamed,
 * saddled, or ridden animal, and skips one that is sheared already.
 */
export class ShearSheepSkill implements Skill<ShearSheepInput, ShearSheepOutput> {
  readonly name = 'shear_sheep'

  constructor(private readonly deps: ShearSheepDeps) {}

  async run(input: ShearSheepInput, context: SkillContext): Promise<SkillResult<ShearSheepOutput>> {
    const bounds = this.resolveArea(input)
    const result = await this.work(input, bounds, context)
    return this.deps.gates?.finish(bounds, result, context.signal) ?? result
  }

  private async work(
    input: ShearSheepInput,
    bounds: Bounds | undefined,
    context: SkillContext,
  ): Promise<SkillResult<ShearSheepOutput>> {
    const { deps } = this
    if (input.farm !== undefined && bounds === undefined)
      return err({
        reason: 'unknown_farm',
        message: `No farm or pen is registered as ${input.farm}.`,
      })
    if ((countItems(deps.inventory.snapshot()).get('shears') ?? 0) === 0)
      return err({
        reason: 'no_shears',
        message:
          'The bot has no shears. They are made of 2 iron ingots: craft them first if the player agrees.',
      })

    const skipped: Skipped = {}
    const woolBefore = this.wool()
    const sheep = deps.animals
      .nearby(SEARCH_RADIUS)
      .filter(
        (animal) =>
          animal.species === 'sheep' &&
          (bounds === undefined
            ? animal.distance <= input.maxDistance
            : insideBounds(animal.position, bounds)),
      )
    if (sheep.length === 0)
      return err({
        reason: 'no_sheep',
        message:
          bounds === undefined
            ? `No sheep within ${String(input.maxDistance)} blocks.`
            : 'No sheep in that pen or area.',
      })

    let sheared = 0
    for (const animal of sheep) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (input.count !== undefined && sheared >= input.count) break
      const reason = productSkip(animal)
      if (reason !== undefined) {
        tally(skipped, reason)
        continue
      }
      if (input.colour !== undefined && animal.colour !== input.colour) {
        tally(skipped, 'colour')
        continue
      }
      const outcome = await this.shearOne(animal.id, context)
      if (outcome === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
      if (outcome === 'no_shears')
        return err({ reason: 'no_shears', message: 'The bot has no shears to hold.' })
      if (outcome !== 'sheared') {
        tally(skipped, outcome)
        continue
      }
      sheared += 1
      context.progress(`Sheared ${String(sheared)} sheep`)
    }
    await deps.drops.collect(
      { maxDistance: PICKUP_RADIUS, accept: (item) => isWool(item.name) },
      context.signal,
    )
    return ok({ sheared, wool: this.woolGained(woolBefore), skipped })
  }

  private async shearOne(
    id: number,
    context: SkillContext,
  ): Promise<'sheared' | 'aborted' | 'no_shears' | 'unreachable' | 'no_effect'> {
    const { deps } = this
    const held = await deps.interaction.hold('shears')
    if (!held.ok) return 'no_shears'
    const now = deps.animals.find(id)
    if (now === undefined) return 'unreachable'
    const walked = await deps.navigator.goToPosition(now.position, APPROACH_RANGE, {
      signal: context.signal,
    })
    if (!walked.ok) return walked.error.reason === 'aborted' ? 'aborted' : 'unreachable'
    const used = await deps.interaction.use(id)
    if (!used.ok) return 'no_effect'
    for (let waited = 0; waited < CONFIRM_MS; waited += CONFIRM_POLL_MS) {
      if (deps.animals.find(id)?.sheared === true) return 'sheared'
      await sleep(deps.scheduler, CONFIRM_POLL_MS, context.signal)
      if (context.signal.aborted) return 'aborted'
    }
    return deps.animals.find(id)?.sheared === true ? 'sheared' : 'no_effect'
  }

  private wool(): Map<string, number> {
    return new Map([...countItems(this.deps.inventory.snapshot())].filter(([name]) => isWool(name)))
  }

  private woolGained(before: ReadonlyMap<string, number>): Record<string, number> {
    const gained: Record<string, number> = {}
    for (const [name, count] of this.wool()) {
      const more = count - (before.get(name) ?? 0)
      if (more > 0) gained[name] = more
    }
    return gained
  }

  private resolveArea(input: ShearSheepInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
