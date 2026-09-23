import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { individualProtection } from '../hunting/animal-catalog.js'
import { foodFor } from './animal-table.js'
import { insideBounds, type Bounds } from './farm-area.types.js'

/** How close the bot gets to a wild animal before it starts leading it (real "temptation" range is about 10). */
const APPROACH_RANGE = 8
/** An animal further than this from the bot after a hop is treated as having lost interest. */
const FOLLOW_LOST_DISTANCE = 12
/** How far each advance toward the destination goes, so the animal keeps re-triggering its own follow behaviour. */
const HOP_DISTANCE = 4
const ARRIVE_RANGE = 2
const MAX_HOPS = 30
const SEARCH_RADIUS = 32

export interface LureAnimalsInput {
  readonly species: string
  readonly count: number
  readonly farm: string | undefined
  readonly destination: Position | undefined
  readonly maxDistance: number
}

export interface AbandonedAnimal {
  readonly id: number
  readonly reason: 'lost_interest' | 'unreachable'
}

export interface LureAnimalsOutput {
  readonly led: number
  readonly requested: number
  readonly abandoned: readonly AbandonedAnimal[]
  /** The destination pen already held its capacity, so fewer (or none) were led than asked for. */
  readonly penFull: boolean
}

export interface LureAnimalsDeps {
  readonly animals: AnimalScanner
  readonly interaction: AnimalInteraction
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly farms: FarmRegistry
}

/** A rough capacity for a pen's footprint: one animal per block of it, not vanilla's exact cramming limit. */
const capacityOf = (bounds: Bounds): number =>
  (bounds.to.x - bounds.from.x + 1) * (bounds.to.z - bounds.from.z + 1)

/**
 * Finds nearby wild animals of a species and walks them, one at a time, into a pen or a position: the bot holds the
 * food that species follows and advances toward the destination in short hops, so the animal keeps re-triggering
 * its own follow behaviour. An animal that falls behind, loses interest, or drops out of view is abandoned (recorded,
 * never chased) and the next nearest candidate is tried. The gate itself needs no special handling: walking through
 * it is an ordinary `goto`, already opened and closed by the door-opening navigator (Phase 16).
 */
export class LureAnimalsSkill implements Skill<LureAnimalsInput, LureAnimalsOutput> {
  readonly name = 'lure_animals'

  constructor(private readonly deps: LureAnimalsDeps) {}

  async run(input: LureAnimalsInput, context: SkillContext): Promise<SkillResult<LureAnimalsOutput>> {
    const food = foodFor(input.species)
    if (food === undefined)
      return err({
        reason: 'unknown_species',
        message: `${input.species} is not a species this can lead (nothing here breeds or follows it).`,
      })
    const destination = this.resolveDestination(input)
    if (destination === undefined)
      return err({ reason: 'no_destination', message: 'Give a farm or a destination position.' })

    const pen = input.farm === undefined ? undefined : this.deps.farms.resolve(input.farm)
    let room = input.count
    if (pen !== undefined) {
      const capacity = capacityOf(pen.bounds)
      const already = this.deps.animals
        .nearby(SEARCH_RADIUS)
        .filter((a) => a.species === input.species && insideBounds(a.position, pen.bounds)).length
      room = Math.min(input.count, Math.max(capacity - already, 0))
      if (room <= 0) return ok({ led: 0, requested: input.count, abandoned: [], penFull: true })
    }

    const candidates = this.deps.animals
      .nearby(input.maxDistance)
      .filter((a) => a.species === input.species && individualProtection(a, true) === undefined)
    if (candidates.length === 0)
      return err({
        reason: 'no_animals_nearby',
        message: `No wild ${input.species} within ${String(input.maxDistance)} blocks.`,
      })

    const abandoned: AbandonedAnimal[] = []
    let led = 0
    const tried = new Set<number>()
    for (const candidate of candidates) {
      if (led >= room) break
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (tried.has(candidate.id)) continue
      tried.add(candidate.id)

      const held = await this.deps.interaction.hold(food)
      if (!held.ok)
        return err({ reason: 'no_food', message: `The bot has no ${food} to lure a ${input.species} with.` })

      const approached = await this.deps.navigator.goToPosition(candidate.position, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!approached.ok) {
        abandoned.push({ id: candidate.id, reason: 'unreachable' })
        continue
      }

      const outcome = await this.leadIn(candidate.id, destination, context)
      if (outcome === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
      if (outcome === 'led') {
        led += 1
        context.progress(`Led ${String(led)} of ${String(room)} ${input.species} in`)
      } else {
        abandoned.push({ id: candidate.id, reason: outcome })
      }
    }

    return ok({ led, requested: input.count, abandoned, penFull: pen !== undefined && led < input.count })
  }

  /** Advances toward the destination in hops, checking after each that the animal is still close enough to follow. */
  private async leadIn(
    animalId: number,
    destination: Position,
    context: SkillContext,
  ): Promise<'led' | 'lost_interest' | 'unreachable' | 'aborted'> {
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      if (context.signal.aborted) return 'aborted'
      const here = this.deps.vitals.read()?.position
      if (here === undefined) return 'unreachable'
      const toGo = distanceBetween(here, destination)
      if (toGo <= ARRIVE_RANGE) return 'led'

      const step = this.hopToward(here, destination, Math.min(HOP_DISTANCE, toGo))
      const walked = await this.deps.navigator.goToPosition(step, 0.5, { signal: context.signal })
      if (!walked.ok) return 'unreachable'

      const animal = this.deps.animals.find(animalId)
      if (animal === undefined) return 'unreachable'
      const now = this.deps.vitals.read()?.position
      if (now === undefined) return 'unreachable'
      if (distanceBetween(now, animal.position) > FOLLOW_LOST_DISTANCE) return 'lost_interest'
    }
    return 'unreachable'
  }

  private hopToward(from: Position, to: Position, distance: number): Position {
    const dx = to.x - from.x
    const dz = to.z - from.z
    const length = Math.hypot(dx, dz)
    if (length === 0) return to
    return { x: from.x + (dx / length) * distance, y: to.y, z: from.z + (dz / length) * distance }
  }

  private resolveDestination(input: LureAnimalsInput): Position | undefined {
    if (input.destination !== undefined) return input.destination
    if (input.farm === undefined) return undefined
    const farm = this.deps.farms.resolve(input.farm)
    if (farm === undefined) return undefined
    const b = farm.bounds
    return {
      x: Math.floor((b.from.x + b.to.x) / 2),
      y: b.from.y,
      z: Math.floor((b.from.z + b.to.z) / 2),
    }
  }
}
