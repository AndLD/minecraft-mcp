import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { AreaGuard } from '../../core/area-guard.port.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { CampfireAccess } from '../../core/campfire.port.js'
import type { HiveAccess } from '../../core/hive.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { insideBounds, type Bounds } from './farm-area.types.js'
import { smokeBelow } from './hive-smoke.js'

/** The honey level at which a bottle or shears take honey. */
export const READY_LEVEL = 5
const BEES_NEAR = 8

export interface HiveReport {
  readonly position: Position
  readonly kind: 'hive' | 'nest'
  readonly honeyLevel: number
  readonly ready: boolean
  /** A lit campfire stands below it, so its bees stay calm when it is harvested. */
  readonly smoked: boolean
  /** The protected area it lies in, when any. */
  readonly protectedBy: string | undefined
  /** Bees flying within 8 blocks of it (not those inside, which the game does not tell). */
  readonly beesNear: number
}

export interface InspectHivesInput {
  readonly farm: string | undefined
  /** Around the bot when no farm is given. */
  readonly radius: number
}

export interface InspectHivesOutput {
  readonly hives: readonly HiveReport[]
  readonly ready: number
}

export interface InspectHivesDeps {
  readonly blocks: BlockScanner
  readonly hives: HiveAccess
  readonly campfires: CampfireAccess
  readonly guard: AreaGuard
  readonly animals: AnimalScanner
  readonly farms: FarmRegistry
}

/** Reads every beehive and bee nest in reach: honey level, smoke, protection, and the bees around. Changes nothing. */
export class InspectHivesSkill implements Skill<InspectHivesInput, InspectHivesOutput> {
  readonly name = 'inspect_hives'

  constructor(private readonly deps: InspectHivesDeps) {}

  run(input: InspectHivesInput, _context: SkillContext): Promise<SkillResult<InspectHivesOutput>> {
    const bounds = this.boundsOf(input.farm)
    if (input.farm !== undefined && bounds === undefined)
      return Promise.resolve(
        err({
          reason: 'unknown_farm',
          message: `There is no farm "${input.farm}". See list_farms.`,
        }),
      )
    const hives = this.read(bounds, input.radius)
    return Promise.resolve(ok({ hives, ready: hives.filter((hive) => hive.ready).length }))
  }

  /** The reports for the hives in the bounds of a farm, or within the radius of the bot. */
  read(bounds: Bounds | undefined, radius: number): HiveReport[] {
    return this.find(bounds, radius).map((position) => this.report(position))
  }

  /** The hives in the bounds of a farm, or within the radius of the bot. */
  find(bounds: Bounds | undefined, radius: number): Position[] {
    const found = this.deps.blocks.findBlocks({
      names: ['beehive', 'bee_nest'],
      maxDistance: bounds === undefined ? radius : 64,
      count: 64,
    })
    return found
      .map((block) => block.position)
      .filter((position) => bounds === undefined || this.inBounds(position, bounds))
  }

  private inBounds(position: Position, bounds: Bounds): boolean {
    return (
      insideBounds(position, bounds) &&
      position.y >= bounds.from.y &&
      position.y <= bounds.from.y + 8
    )
  }

  private report(position: Position): HiveReport {
    const state = this.deps.hives.stateAt(position)
    const area = this.deps.guard.protectedAt(position)
    return {
      position,
      kind: state?.kind ?? 'hive',
      honeyLevel: state?.honeyLevel ?? 0,
      ready: (state?.honeyLevel ?? 0) >= READY_LEVEL,
      smoked: smokeBelow(this.deps.blocks, this.deps.campfires, position) !== undefined,
      protectedBy: area?.label,
      beesNear: this.deps.animals
        .nearby(32)
        .filter(
          (animal) =>
            animal.species === 'bee' && distanceBetween(animal.position, position) <= BEES_NEAR,
        ).length,
    }
  }

  private boundsOf(farm: string | undefined): Bounds | undefined {
    return farm === undefined ? undefined : this.deps.farms.resolve(farm)?.bounds
  }
}
