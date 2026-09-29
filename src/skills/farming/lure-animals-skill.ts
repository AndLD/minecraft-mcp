import type { AnimalInteraction } from '../../core/animal-interaction.port.js'
import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { individualProtection } from '../hunting/animal-catalog.js'
import { foodFor } from './animal-table.js'
import { insideBounds, type Bounds } from './farm-area.types.js'

/** How close the bot gets to a wild animal before it starts leading it (real "temptation" range is about 10). */
const LEAD_RANGE = 3
/** A flock further away than this is approached in legs of this length, re-reading where the animal is after each. */
const FAR_LEG = 30
/** A walk to the animal that fails is tried again from where the animal is now, this many times in all. */
const APPROACH_TRIES = 3
/** After a hop the animal must be this close to keep following; otherwise the bot waits for it to catch up. */
const FOLLOW_NEAR = 6
const CATCH_UP_STEP_MS = 500
const CATCH_UP_STEPS = 10
/** An animal further than this from the bot after a hop is treated as having lost interest. */
const FOLLOW_LOST_DISTANCE = 12
/** How far each advance toward the destination goes, so the animal keeps re-triggering its own follow behaviour. */
const HOP_DISTANCE = 4
const ARRIVE_RANGE = 2
const MAX_HOPS = 30
const MAX_LEGS = 12
const LEG_ARRIVE_RANGE = 2
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
  /** How many the destination could still take: the request, or less when a pen has little room left. */
  readonly room: number
  /** `requested - led`: what is still missing, whatever the reason (see `abandoned`, `penFull`, `room`). */
  readonly shortfall: number
  readonly abandoned: readonly AbandonedAnimal[]
  /** True only when the destination pen already held its capacity before anything was led: nothing was tried. */
  readonly penFull: boolean
}

export interface LureAnimalsDeps {
  readonly animals: AnimalScanner
  readonly interaction: AnimalInteraction
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly farms: FarmRegistry
  readonly scheduler: Scheduler
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

  async run(
    input: LureAnimalsInput,
    context: SkillContext,
  ): Promise<SkillResult<LureAnimalsOutput>> {
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
      if (room <= 0)
        return ok({
          led: 0,
          requested: input.count,
          room: 0,
          shortfall: input.count,
          abandoned: [],
          penFull: true,
        })
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
        return err({
          reason: 'no_food',
          message: `The bot has no ${food} to lure a ${input.species} with.`,
        })

      const approached = await this.approach(candidate.id, context)
      if (approached === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
      if (approached === 'unreachable') {
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

    return ok({
      led,
      requested: input.count,
      room,
      shortfall: input.count - led,
      abandoned,
      penFull: false,
    })
  }

  /**
   * Walks next to the animal. It drifts while the bot walks, so its position is read again before every try (up to
   * `APPROACH_TRIES`), and a flock far away is approached in legs so one long walk cannot fail the whole trip.
   */
  private async approach(
    animalId: number,
    context: SkillContext,
  ): Promise<'near' | 'unreachable' | 'aborted'> {
    const { navigator, animals, vitals } = this.deps
    for (let attempt = 0; attempt < APPROACH_TRIES; attempt += 1) {
      if (context.signal.aborted) return 'aborted'
      let failed = false
      for (let leg = 0; leg < MAX_LEGS; leg += 1) {
        const animal = animals.find(animalId)
        const here = vitals.read()?.position
        if (animal === undefined || here === undefined) return 'unreachable'
        const far = distanceBetween(here, animal.position) > FAR_LEG
        const walked = await navigator.goToPosition(
          far ? this.hopToward(here, animal.position, FAR_LEG) : animal.position,
          far ? LEG_ARRIVE_RANGE : LEAD_RANGE,
          { signal: context.signal },
        )
        if (!walked.ok) {
          if (walked.error.reason === 'aborted') return 'aborted'
          failed = true
          break
        }
        if (!far) return 'near'
      }
      if (!failed) break
    }
    return 'unreachable'
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
      const caught = await this.waitForAnimal(animalId, context)
      if (caught !== 'near') return caught
    }
    return 'unreachable'
  }

  /**
   * Stands still with the food in hand until the animal is close again: the bot outruns any animal, and a hop made
   * while it is still far behind is how it loses interest. Gives up (`lost_interest`) when it does not catch up.
   */
  private async waitForAnimal(
    animalId: number,
    context: SkillContext,
  ): Promise<'near' | 'lost_interest' | 'unreachable' | 'aborted'> {
    const { animals, vitals, scheduler } = this.deps
    for (let step = 0; ; step += 1) {
      const animal = animals.find(animalId)
      const now = vitals.read()?.position
      if (animal === undefined || now === undefined) return 'unreachable'
      const away = distanceBetween(now, animal.position)
      if (away <= FOLLOW_NEAR) return 'near'
      // Far beyond the range it follows in, waiting will not bring it back.
      if (away > FOLLOW_LOST_DISTANCE || step >= CATCH_UP_STEPS) return 'lost_interest'
      await sleep(scheduler, CATCH_UP_STEP_MS, context.signal)
      if (context.signal.aborted) return 'aborted'
    }
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
