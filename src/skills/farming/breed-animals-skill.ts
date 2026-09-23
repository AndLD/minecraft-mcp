import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { individualProtection } from '../hunting/animal-catalog.js'
import { foodFor } from './animal-table.js'
import { insideBounds, type Bounds } from './farm-area.types.js'

const SEARCH_RADIUS = 32
const APPROACH_RANGE = 3
/** How long to wait for a fed pair's baby to actually appear before moving on. */
const BABY_WAIT_MS = 8_000
const BABY_POLL_MS = 1_000

export interface BreedAnimalsInput {
  readonly species: string
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  /** Stop once the herd (adults and babies together) reaches this size. */
  readonly targetCount: number
}

export interface BreedAnimalsOutput {
  readonly bred: number
  readonly pairsFed: number
  readonly herdSize: number
  readonly targetCount: number
}

export interface BreedAnimalsDeps {
  readonly animals: AnimalScanner
  readonly interaction: AnimalInteraction
  readonly navigator: Navigator
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly farms: FarmRegistry
}

/**
 * Feeds pairs of eligible adults the species' own breeding food, waiting a little after each pair to see whether a
 * baby actually appears. Never breeds a tamed, named, saddled, or ridden animal. Stops once the herd reaches
 * `targetCount` or there are no more eligible pairs.
 */
export class BreedAnimalsSkill implements Skill<BreedAnimalsInput, BreedAnimalsOutput> {
  readonly name = 'breed_animals'

  constructor(private readonly deps: BreedAnimalsDeps) {}

  async run(
    input: BreedAnimalsInput,
    context: SkillContext,
  ): Promise<SkillResult<BreedAnimalsOutput>> {
    const food = foodFor(input.species)
    if (food === undefined)
      return err({
        reason: 'unknown_species',
        message: `${input.species} is not a species this can breed.`,
      })
    const bounds = this.resolveArea(input)
    if (bounds === undefined) return err({ reason: 'no_area', message: 'Give a farm or an area to breed in.' })

    let bred = 0
    let pairsFed = 0
    const fedThisRun = new Set<number>()

    for (;;) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const herd = this.deps.animals.nearby(SEARCH_RADIUS).filter((a) => a.species === input.species && insideBounds(a.position, bounds))
      if (herd.length >= input.targetCount)
        return ok({ bred, pairsFed, herdSize: herd.length, targetCount: input.targetCount })

      const eligible = herd.filter(
        (a) => !a.baby && !fedThisRun.has(a.id) && individualProtection(a, false) === undefined,
      )
      const pair = eligible.slice(0, 2)
      if (pair.length < 2) return ok({ bred, pairsFed, herdSize: herd.length, targetCount: input.targetCount })

      const held = await this.deps.interaction.hold(food)
      if (!held.ok)
        return err({ reason: 'no_food', message: `The bot has no ${food} to breed a ${input.species} with.` })

      const before = new Set(herd.filter((a) => a.baby).map((a) => a.id))
      for (const parent of pair) {
        fedThisRun.add(parent.id)
        const walked = await this.deps.navigator.goToPosition(parent.position, APPROACH_RANGE, {
          signal: context.signal,
        })
        if (!walked.ok) continue
        await this.deps.interaction.feed(parent.id)
      }
      pairsFed += 1
      context.progress(`Fed pair ${String(pairsFed)}; waiting to see a baby`)

      // waitForNewBaby itself stops and returns false as soon as the signal is aborted; the top of the next
      // iteration reports the cancellation.
      const gotBaby = await this.waitForNewBaby(input.species, bounds, before, context)
      if (gotBaby) bred += 1
    }
  }

  private async waitForNewBaby(
    species: string,
    bounds: Bounds,
    before: ReadonlySet<number>,
    context: SkillContext,
  ): Promise<boolean> {
    const deadline = this.deps.clock.now() + BABY_WAIT_MS
    while (this.deps.clock.now() < deadline) {
      if (context.signal.aborted) return false
      const babies = this.deps.animals
        .nearby(SEARCH_RADIUS)
        .filter((a) => a.species === species && a.baby && insideBounds(a.position, bounds) && !before.has(a.id))
      if (babies.length > 0) return true
      await sleep(this.deps.scheduler, BABY_POLL_MS, context.signal)
    }
    return false
  }

  private resolveArea(input: BreedAnimalsInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
