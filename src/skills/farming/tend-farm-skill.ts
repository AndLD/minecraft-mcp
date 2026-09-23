import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { CollectEggsSkill } from './collect-eggs-skill.js'
import type { HarvestCropsSkill } from './harvest-crops-skill.js'
import type { HerdManager } from './herd-manager.js'
import type { PlantCropsSkill } from './plant-crops-skill.js'

export interface TendFarmInput {
  readonly farm: string
}

export interface TendComponentResult {
  readonly id: string
  readonly kind: FarmEntry['kind']
  /** Field: crops harvested and replanted, plots planted. */
  readonly harvested: number
  readonly replanted: number
  readonly planted: number
  /** Pen: the herd size found, and what was done about it. */
  readonly herdSizeBefore: number | undefined
  readonly herdAction: 'bred' | 'culled' | 'none' | undefined
  /** A chicken pen: eggs picked up, stored, and released. */
  readonly eggsPickedUp: number | undefined
  readonly eggsStored: number | undefined
  readonly eggsReleased: number | undefined
  readonly problem: string | undefined
}

export interface TendFarmOutput {
  readonly components: readonly TendComponentResult[]
}

export interface TendFarmDeps {
  readonly farms: FarmRegistry
  readonly harvest: HarvestCropsSkill
  readonly plant: PlantCropsSkill
  readonly herd: HerdManager
  /** Collects eggs as part of tending a chicken pen; without it, a chicken pen is just herded. */
  readonly collectEggs?: CollectEggsSkill
}

/**
 * One pass over a registered farm, or every component of a group: harvest what is ripe and replant, then plant
 * anything still empty. A component that fails is reported and skipped; the others carry on. One summary covers
 * every component tended.
 */
export class TendFarmSkill implements Skill<TendFarmInput, TendFarmOutput> {
  readonly name = 'tend_farm'

  constructor(private readonly deps: TendFarmDeps) {}

  async run(input: TendFarmInput, context: SkillContext): Promise<SkillResult<TendFarmOutput>> {
    const single = this.deps.farms.resolve(input.farm)
    const entries = single !== undefined ? [single] : this.deps.farms.byGroup(input.farm)
    if (entries.length === 0)
      return err({
        reason: 'unknown_farm',
        message: `There is no farm or group "${input.farm}". See list_farms.`,
      })

    const components: TendComponentResult[] = []
    for (const entry of entries) {
      if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      if (entry.kind === 'pen') {
        components.push(await this.tendPen(entry, context))
        continue
      }
      if (entry.kind !== 'field') {
        components.push({
          id: entry.id,
          kind: entry.kind,
          harvested: 0,
          replanted: 0,
          planted: 0,
          herdSizeBefore: undefined,
          herdAction: undefined,
          eggsPickedUp: undefined,
          eggsStored: undefined,
          eggsReleased: undefined,
          problem: `${entry.kind} is not tended yet.`,
        })
        continue
      }

      const harvest = await this.deps.harvest.run(
        { farm: entry.id, area: undefined, replant: true },
        context,
      )
      if (!harvest.ok && harvest.error.reason === 'aborted') return err(harvest.error)
      const harvested = harvest.ok ? harvest.value.harvested : 0
      const replanted = harvest.ok ? harvest.value.replanted : 0

      let planted = 0
      if (entry.crop !== null) {
        const plant = await this.deps.plant.run(
          { farm: entry.id, area: undefined, crop: entry.crop, maxPlants: undefined },
          context,
        )
        if (!plant.ok && plant.error.reason === 'aborted') return err(plant.error)
        planted = plant.ok ? plant.value.planted : 0
      }

      components.push({
        id: entry.id,
        kind: entry.kind,
        harvested,
        replanted,
        planted,
        herdSizeBefore: undefined,
        herdAction: undefined,
        eggsPickedUp: undefined,
        eggsStored: undefined,
        eggsReleased: undefined,
        problem: harvest.ok ? undefined : harvest.error.message,
      })
    }
    return ok({ components })
  }

  private async tendPen(entry: FarmEntry, context: SkillContext): Promise<TendComponentResult> {
    const base = {
      id: entry.id,
      kind: entry.kind,
      harvested: 0,
      replanted: 0,
      planted: 0,
    }
    if (entry.species === null || entry.herdTarget === null)
      return {
        ...base,
        herdSizeBefore: undefined,
        herdAction: undefined,
        eggsPickedUp: undefined,
        eggsStored: undefined,
        eggsReleased: undefined,
        problem: 'no species or herd target set for this pen (see build_farm/register_farm).',
      }
    const herded = await this.deps.herd.run(
      { species: entry.species, targetSize: entry.herdTarget, bounds: entry.bounds },
      context,
    )

    let eggs: { pickedUp: number; stored: number; released: number } | undefined
    let eggsProblem: string | undefined
    if (entry.species === 'chicken' && this.deps.collectEggs !== undefined) {
      const collected = await this.deps.collectEggs.run(
        {
          farm: entry.id,
          area: undefined,
          storeFraction: undefined,
          release: undefined,
          maxChickens: entry.herdTarget,
        },
        context,
      )
      if (collected.ok) eggs = collected.value
      else eggsProblem = collected.error.message
    }

    return {
      ...base,
      herdSizeBefore: herded.ok ? herded.value.herdSizeBefore : undefined,
      herdAction: herded.ok ? herded.value.action : undefined,
      eggsPickedUp: eggs?.pickedUp,
      eggsStored: eggs?.stored,
      eggsReleased: eggs?.released,
      problem: !herded.ok ? herded.error.message : eggsProblem,
    }
  }
}
