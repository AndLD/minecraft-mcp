import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import { ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { HuntAnimalsSkill, HuntOutput } from '../hunting/hunt-animals-skill.js'
import type { BreedAnimalsOutput, BreedAnimalsSkill } from './breed-animals-skill.js'
import { insideBounds, type Bounds } from './farm-area.types.js'

/** How long a cull may take before it gives up (huntable animals can wander far). */
const CULL_TIME_LIMIT_MS = 2 * 60 * 1000
const SEARCH_RADIUS = 48

export interface HerdManagerInput {
  readonly species: string
  /** Keep the herd at this size: breed up when short, cull the surplus when over. */
  readonly targetSize: number
  readonly bounds: Bounds
}

export interface HerdManagerOutput {
  readonly action: 'bred' | 'culled' | 'none'
  readonly herdSizeBefore: number
  readonly bred: BreedAnimalsOutput | undefined
  readonly culled: HuntOutput | undefined
}

export interface HerdManagerDeps {
  readonly animals: AnimalScanner
  readonly breed: BreedAnimalsSkill
  readonly hunt: HuntAnimalsSkill
}

/** Keeps a pen's herd at a target size: breeds up when short, culls the surplus with `hunt_animals` when over (which keeps its own breeding floor of two adults). */
export class HerdManager implements Skill<HerdManagerInput, HerdManagerOutput> {
  readonly name = 'herd_manager'

  constructor(private readonly deps: HerdManagerDeps) {}

  async run(input: HerdManagerInput, context: SkillContext): Promise<SkillResult<HerdManagerOutput>> {
    const herdSizeBefore = this.deps.animals
      .nearby(SEARCH_RADIUS)
      .filter((a) => a.species === input.species && insideBounds(a.position, input.bounds)).length

    if (herdSizeBefore < input.targetSize) {
      const bred = await this.deps.breed.run(
        { species: input.species, farm: undefined, area: input.bounds, targetCount: input.targetSize },
        context,
      )
      return ok({
        action: 'bred',
        herdSizeBefore,
        bred: bred.ok ? bred.value : undefined,
        culled: undefined,
      })
    }

    if (herdSizeBefore > input.targetSize) {
      const excess = herdSizeBefore - input.targetSize
      const culled = await this.deps.hunt.run(
        {
          species: [input.species],
          goal: { kind: 'animals', count: excess },
          radius: SEARCH_RADIUS,
          keepBreeders: true,
          allowBabies: false,
          includePens: true,
          cook: false,
          timeLimitMs: CULL_TIME_LIMIT_MS,
        },
        context,
      )
      return ok({
        action: 'culled',
        herdSizeBefore,
        bred: undefined,
        culled: culled.ok ? culled.value : undefined,
      })
    }

    return ok({ action: 'none', herdSizeBefore, bred: undefined, culled: undefined })
  }
}
