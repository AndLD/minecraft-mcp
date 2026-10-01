import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { CollectEggsSkill } from './collect-eggs-skill.js'
import type { HarvestCropsSkill } from './harvest-crops-skill.js'
import type { HarvestHoneySkill } from './harvest-honey-skill.js'
import type { HerdManager } from './herd-manager.js'
import type { PenGateGuard } from './pen-gate-guard.js'
import type { PlantCropsSkill } from './plant-crops-skill.js'
import type { PlantTreesSkill } from './plant-trees-skill.js'

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
  /** Field: plots lost to the bot's own crossing (trampled back to dirt) while tending, tilled and planted again. */
  readonly repaired?: number
  /** Field: plots still bare after the final check (see `problem` for why they could not be planted). */
  readonly stillBare?: number
  /** Pen: the herd size found, and what was done about it. */
  readonly herdSizeBefore: number | undefined
  readonly herdAction: 'bred' | 'culled' | 'none' | undefined
  /** A chicken pen: eggs picked up, stored, and released. */
  readonly eggsPickedUp: number | undefined
  readonly eggsStored: number | undefined
  readonly eggsReleased: number | undefined
  /** Apiary: honey bottles taken from the ripe hives. */
  readonly honeyBottles?: number
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
  /** Refills the empty spots of a grove; without it a grove is reported as not tended. */
  readonly plantTrees?: PlantTreesSkill
  /** Takes honey from the ripe hives of an apiary; without it an apiary is reported as not tended. */
  readonly harvestHoney?: HarvestHoneySkill
  /** Shuts a pen's gate at the end of tending it (culling walks in and out of the pen). */
  readonly gates?: PenGateGuard
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
      if (entry.kind === 'apiary' && this.deps.harvestHoney !== undefined) {
        components.push(await this.tendApiary(entry, context))
        continue
      }
      if (entry.kind === 'grove' && this.deps.plantTrees !== undefined) {
        components.push(await this.tendGrove(entry, context))
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
      let repaired: number | undefined
      let stillBare: number | undefined
      const problems: string[] = harvest.ok ? [] : [harvest.error.message]
      if (entry.crop !== null) {
        const plant = await this.deps.plant.run(
          { farm: entry.id, area: undefined, crop: entry.crop, maxPlants: undefined },
          context,
        )
        if (!plant.ok && plant.error.reason === 'aborted') return err(plant.error)
        if (plant.ok) {
          planted = plant.value.planted
          repaired = plant.value.repaired
          stillBare = plant.value.stillBare
          // The bot's own crossing can trample a plot back into dirt (seen beside the water block); the planting step
          // has looked for such plots once more at the end, so what is left is said, not hidden.
          if (stillBare > 0)
            problems.push(
              `${String(stillBare)} plot(s) are still bare after the final check (no hoe or seeds left, or the bot could not reach them).`,
            )
        } else problems.push(plant.error.message)
      }

      components.push({
        id: entry.id,
        kind: entry.kind,
        harvested,
        replanted,
        planted,
        repaired,
        stillBare,
        herdSizeBefore: undefined,
        herdAction: undefined,
        eggsPickedUp: undefined,
        eggsStored: undefined,
        eggsReleased: undefined,
        problem: problems.length === 0 ? undefined : problems.join(' '),
      })
    }
    return ok({ components })
  }

  /** Takes honey from every ripe hive, smoked; a missing bottle or smoke is reported, not hidden. */
  private async tendApiary(entry: FarmEntry, context: SkillContext): Promise<TendComponentResult> {
    const harvested = await this.deps.harvestHoney?.run(
      {
        what: 'honey',
        farm: entry.id,
        at: undefined,
        radius: 32,
        count: undefined,
        smoke: 'auto',
        craftBottles: false,
      },
      context,
    )
    return {
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
      honeyBottles: harvested?.ok === true ? harvested.value.honeyBottles : 0,
      problem: harvested?.ok === false ? harvested.error.message : undefined,
    }
  }

  /** Never fells: refills the spots where a tree is gone with the saplings the bot carries (`planted`). */
  private async tendGrove(entry: FarmEntry, context: SkillContext): Promise<TendComponentResult> {
    const planted = await this.deps.plantTrees?.run(
      {
        species: undefined,
        count: undefined,
        farm: entry.id,
        area: undefined,
        around: undefined,
        spacing: undefined,
        big: undefined,
        preview: false,
        label: undefined,
        group: undefined,
      },
      context,
    )
    const done = planted?.ok === true ? planted.value : undefined
    return {
      id: entry.id,
      kind: entry.kind,
      harvested: 0,
      replanted: 0,
      planted: done?.planted ?? 0,
      herdSizeBefore: undefined,
      herdAction: undefined,
      eggsPickedUp: undefined,
      eggsStored: undefined,
      eggsReleased: undefined,
      problem: planted?.ok === false ? planted.error.message : undefined,
    }
  }

  private async tendPen(entry: FarmEntry, context: SkillContext): Promise<TendComponentResult> {
    const tended = await this.tendPenInside(entry, context)
    const open = await this.deps.gates?.ensureShut(entry.bounds, context.signal)
    if (open === undefined) return tended
    return { ...tended, problem: tended.problem === undefined ? open : `${tended.problem} ${open}` }
  }

  private async tendPenInside(entry: FarmEntry, context: SkillContext): Promise<TendComponentResult> {
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
