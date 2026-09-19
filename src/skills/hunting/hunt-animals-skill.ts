import type { AnimalInfo, AnimalScanner } from '../../core/animal-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Combatant } from '../../core/combatant.port.js'
import { countItems, describeItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { ItemSmelter } from '../smelting/smelt-items-skill.js'
import { AnimalKiller } from './animal-killer.js'
import {
  COOKED_MEAT,
  HUNTABLE_SPECIES,
  HUNTABLE_SPECIES_NAMES,
  PROTECTION_TEXT,
  itemMatches,
  selectTarget,
  type Protection,
} from './animal-catalog.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { ItemDepositor } from '../storage/deposit-items-skill.js'
import type { InventoryFullHandler } from '../storage/inventory-full-handler.js'
import type { InventoryFullKind } from '../../state/storage-policy.js'
import type { PenDetector } from './pen-detector.js'

/** What ends a hunt. */
export type HuntGoal =
  /** Collect this many of an item (raw `beef`, `leather`, `wool`, ...). */
  | { readonly kind: 'items'; readonly item: string; readonly count: number }
  /** Kill this many animals. */
  | { readonly kind: 'animals'; readonly count: number }

export interface HuntInput {
  readonly species: readonly string[]
  readonly goal: HuntGoal
  readonly radius: number
  readonly keepBreeders: boolean
  readonly allowBabies: boolean
  readonly includePens: boolean
  /** Cook the raw meat gained afterwards. */
  readonly cook: boolean
  readonly timeLimitMs: number
  /** What to do when the inventory is full; the standing policy when undefined. */
  readonly onInventoryFull?: InventoryFullKind | undefined
  /** Deposit the cooked meat into a container (by the storage rules) when done. */
  readonly depositCooked?: boolean
  /** Called with how much of the goal is done, so a caller can track what is left. */
  readonly onProgress?: (done: number) => void
}

export interface HuntOutput {
  readonly killed: number
  readonly goal: HuntGoal
  readonly gained: readonly ItemCount[]
  /** Animals of the hunted species in view, before and after. */
  readonly speciesBefore: Readonly<Record<string, number>>
  readonly speciesAfter: Readonly<Record<string, number>>
  readonly cooked: readonly ItemCount[]
  /** Set when cooking was asked for but failed; the hunt itself succeeded. */
  readonly cookProblem?: string
  /** What was put into containers, when asked for. */
  readonly deposited?: readonly {
    readonly container: string
    readonly items: readonly ItemCount[]
  }[]
  readonly depositProblem?: string
}

export interface HuntAnimalsDeps {
  readonly animals: AnimalScanner
  readonly combatant: Combatant
  readonly drops: DropCollector
  readonly inventory: InventoryReader
  readonly smelter: ItemSmelter
  readonly pens: PenDetector
  readonly clock: Clock
  readonly full?: InventoryFullHandler
  readonly depositor?: ItemDepositor
}

const MAX_SKIPS = 30

const countSpecies = (
  animals: readonly AnimalInfo[],
  species: readonly string[],
): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const animal of animals)
    if (species.includes(animal.species)) counts[animal.species] = (counts[animal.species] ?? 0) + 1
  return counts
}

/**
 * Hunts animals until a goal is met: finds the nearest animal that may be hunted, kills it, picks up the drops, and
 * repeats. Pets, named animals, babies, pen animals, and the last breeding pair are left alone unless the caller says
 * otherwise. Dangers are the reflexes' business: they pause the hunt and it resumes afterwards.
 */
export class HuntAnimalsSkill implements Skill<HuntInput, HuntOutput> {
  readonly name = 'hunt_animals'
  private readonly killer: AnimalKiller

  constructor(private readonly deps: HuntAnimalsDeps) {
    this.killer = new AnimalKiller({
      combatant: deps.combatant,
      animals: deps.animals,
      drops: deps.drops,
      clock: deps.clock,
    })
  }

  async run(input: HuntInput, context: SkillContext): Promise<SkillResult<HuntOutput>> {
    const { deps } = this
    const unknown = input.species.filter((name) => !(name in HUNTABLE_SPECIES))
    if (unknown.length > 0)
      return err({
        reason: 'not_huntable',
        message: `${unknown.join(', ')} cannot be hunted. Huntable animals: ${HUNTABLE_SPECIES_NAMES.join(', ')}.`,
      })

    const before = countItems(deps.inventory.snapshot())
    const speciesBefore = countSpecies(deps.animals.nearby(input.radius), input.species)
    const deadline = deps.clock.now() + input.timeLimitMs
    const skip = new Set<number>()
    let killed = 0
    await deps.combatant.equipBestGear()
    const fullSession = deps.full?.begin(input.onInventoryFull)

    const done = (): number =>
      input.goal.kind === 'animals' ? killed : this.itemsGained(before, input.goal.item)
    const summary = (): string =>
      `Killed ${String(killed)}; the inventory gained ${describeItems(gained(before, countItems(deps.inventory.snapshot())))}. ` +
      `Animals in view before: ${JSON.stringify(speciesBefore)}, now: ${JSON.stringify(countSpecies(deps.animals.nearby(input.radius), input.species))}`
    const stop = (reason: string, message: string): SkillResult<HuntOutput> =>
      err({
        reason,
        message: `${message} ${summary()}.`,
        detail: {
          killed,
          done: done(),
          wanted: input.goal.count,
          remaining: input.goal.count - done(),
        },
      })

    while (done() < input.goal.count) {
      if (context.signal.aborted) return stop('aborted', 'Cancelled.')
      if (deps.clock.now() >= deadline) return stop('time_limit', 'The time limit ran out.')
      const snapshot = deps.inventory.snapshot()
      if (snapshot === undefined)
        return stop('not_connected', 'Not connected to a Minecraft world.')
      if (snapshot.emptySlots === 0) {
        if (fullSession === undefined)
          return stop('inventory_full', 'The inventory is full. Free some space, then hunt again.')
        const outcome = await fullSession.handle(context)
        if (outcome.kind === 'stop') return stop('inventory_full', outcome.message)
        continue
      }
      if (skip.size >= MAX_SKIPS)
        return stop('unreachable', 'Too many animals could not be caught.')

      const { target, passedOver } = selectTarget(deps.animals.nearby(input.radius), {
        species: input.species,
        keepBreeders: input.keepBreeders,
        allowBabies: input.allowBabies,
        includePens: input.includePens,
        skip,
        isPenned: (position) => deps.pens.isPenned(position),
      })
      if (target === undefined) return this.noTarget(stop, input, passedOver)

      context.progress(
        `Hunting a ${target.species} ${String(Math.round(target.distance))} blocks away`,
      )
      const outcome = await this.killer.kill(target, context.signal)
      if (outcome === 'aborted') return stop('aborted', 'Cancelled.')
      if (outcome === 'not_connected') return stop('not_connected', 'Lost the connection.')
      if (outcome === 'killed') {
        killed += 1
        input.onProgress?.(done())
        context.progress(
          `Killed ${String(killed)}; ${String(done())} of ${String(input.goal.count)} done`,
        )
      } else {
        skip.add(target.id)
      }
    }

    const gainedItems = gained(before, countItems(deps.inventory.snapshot()))
    const cooking = input.cook ? await this.cook(gainedItems, context) : { cooked: [] }
    const storing =
      input.depositCooked === true && cooking.cooked.length > 0
        ? await this.deposit(cooking.cooked, context)
        : {}
    return ok({
      killed,
      goal: input.goal,
      gained: gainedItems,
      speciesBefore,
      speciesAfter: countSpecies(deps.animals.nearby(input.radius), input.species),
      ...cooking,
      ...storing,
    })
  }

  private itemsGained(before: ReadonlyMap<string, number>, wanted: string): number {
    const after = countItems(this.deps.inventory.snapshot())
    return gained(before, after)
      .filter((entry) => itemMatches(wanted, entry.name))
      .reduce((sum, entry) => sum + entry.count, 0)
  }

  private noTarget(
    stop: (reason: string, message: string) => SkillResult<HuntOutput>,
    input: HuntInput,
    passedOver: Partial<Record<Protection, number>>,
  ): SkillResult<HuntOutput> {
    const reasons = Object.entries(passedOver) as [Protection, number][]
    if (reasons.length === 0)
      return stop(
        'no_animals',
        `No ${input.species.join(' / ')} within ${String(input.radius)} blocks.`,
      )
    const list = reasons.map(([why, n]) => `${String(n)} ${PROTECTION_TEXT[why]}`).join(', ')
    const floor = passedOver.breeding_pair !== undefined
    return stop(
      floor ? 'breeding_floor' : 'protected',
      `The animals left were not hunted: ${list}${floor ? ' (the last breeding pair is kept; say so to override)' : ''}.`,
    )
  }

  /** Puts the cooked food into a container by the storage rules; a failure is reported, not fatal. */
  private async deposit(
    cooked: readonly ItemCount[],
    context: SkillContext,
  ): Promise<{
    deposited?: readonly { container: string; items: readonly ItemCount[] }[]
    depositProblem?: string
  }> {
    if (this.deps.depositor === undefined) return { depositProblem: 'Depositing is not available.' }
    const result = await this.deps.depositor.run(
      {
        specs: cooked.map((item) => item.name),
        includeReserved: true,
        container: undefined,
        count: undefined,
        maxDistance: 64,
      },
      context,
    )
    return result.ok
      ? { deposited: result.value.deposited }
      : { depositProblem: result.error.message }
  }

  /** Cooks the raw meat that the hunt brought in. A failure is reported, not fatal. */
  private async cook(
    gainedItems: readonly ItemCount[],
    context: SkillContext,
  ): Promise<{ cooked: ItemCount[]; cookProblem?: string }> {
    const cooked: ItemCount[] = []
    for (const meat of gainedItems.filter((entry) => entry.name in COOKED_MEAT)) {
      if (context.signal.aborted) break
      context.progress(`Cooking ${String(meat.count)} ${meat.name}`)
      const result = await this.deps.smelter.run(
        { item: meat.name, count: meat.count, fuel: undefined },
        context,
      )
      if (!result.ok) return { cooked, cookProblem: `${meat.name}: ${result.error.message}` }
      cooked.push({ name: result.value.produced, count: result.value.smelted })
    }
    return { cooked }
  }
}
