import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { Tiller } from '../../core/tiller.port.js'
import type { FarmRegistry } from '../../state/farm-registry.js'
import { cropFor } from './crop-table.js'
import type { Bounds } from './farm-area.types.js'

const APPROACH_RANGE = 3
/** Planting sweeps over the area at most: one, and up to two more to replant what was trampled meanwhile. */
const MAX_SWEEPS = 3
const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'podzol'])

export interface PlantCropsInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  readonly crop: string
  readonly maxPlants: number | undefined
}

export interface PlantCropsOutput {
  readonly planted: number
  readonly tilled: number
  readonly skipped: number
  /** Plots that were lost while the bot worked (trampled back to dirt) and were tilled and planted again. */
  readonly repaired: number
  /** Plots that are still bare (dirt, grass, or empty farmland) when the bot is done: the final check found them. */
  readonly stillBare: number
}

export interface PlantCropsDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly tiller: Tiller
  readonly placer: Placer
  readonly farms: FarmRegistry
}

/**
 * Hoes dirt and grass into farmland and plants the chosen crop on every free plot of a farm or an area: never on a
 * plot that already holds a crop. Standing spots stay a couple of blocks off the target plot so the bot does not
 * have to step onto it to reach it (trampling turns farmland back to dirt); a very packed field can still see the
 * bot cross an already-tilled plot to reach one further in — a real path-around-the-edges planner is not built yet.
 */
export class PlantCropsSkill implements Skill<PlantCropsInput, PlantCropsOutput> {
  readonly name = 'plant_crops'

  constructor(private readonly deps: PlantCropsDeps) {}

  async run(input: PlantCropsInput, context: SkillContext): Promise<SkillResult<PlantCropsOutput>> {
    const spec = cropFor(input.crop)
    if (spec === undefined)
      return err({ reason: 'unknown_crop', message: `${input.crop} is not a crop this can plant.` })
    const area = this.resolveArea(input)
    if (area === undefined)
      return err({ reason: 'no_area', message: 'Give a farm or an area to plant.' })

    // A stem crop grows only in the rows the field tilled (the rows between stay free for the fruit): those are the rows
    // that hold farmland now, so a plot trampled back to dirt in one of them is tilled again, and no other row is.
    const stemRows = spec.spec.kind === 'stem' ? this.farmlandRows(area) : undefined
    const total = { planted: 0, tilled: 0, skipped: 0, repaired: 0 }
    let stopped = false
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
      const done = await this.sweep(area, spec.spec.seed, input, total.planted, stemRows, context)
      if (!done.ok) return done
      total.planted += done.value.planted
      total.tilled += done.value.tilled
      // What the first sweep could not plant is reported once; later sweeps only look for plots lost since.
      if (sweep === 0) total.skipped = done.value.skipped
      else total.repaired += done.value.planted
      stopped = done.value.stopped
      // A sweep that planted nothing means nothing was lost meanwhile.
      if (done.value.planted === 0 || stopped) break
    }
    // The final check: the last sweep can lose a plot too, so look at the field once more and say what is bare. With
    // a planting limit the rest is bare on purpose, so nothing is counted then.
    return ok({ ...total, stillBare: stopped ? 0 : this.countBare(area, stemRows) })
  }

  /** Plots of the area a crop could stand on but none does: dirt, grass, or farmland with nothing above it. */
  private countBare(area: Bounds, stemRows: ReadonlySet<number> | undefined): number {
    let bare = 0
    const y = area.from.y
    for (let x = area.from.x; x <= area.to.x; x += 1)
      for (let z = area.from.z; z <= area.to.z; z += 1) {
        if (stemRows !== undefined && !stemRows.has(z)) continue
        const ground = this.deps.blocks.blockAt({ x, y, z })
        if (ground === undefined || (ground !== 'farmland' && !TILLABLE.has(ground))) continue
        const above = this.deps.blocks.blockAt({ x, y: y + 1, z })
        if (above === 'air') bare += 1
      }
    return bare
  }

  /**
   * One walk over the area. Farmland beside water is where the bot's own crossing tramples it back into dirt while it
   * plants (seen on a real server: the plot next to the water block of a fresh field, with the bot standing on it), and
   * the crop above it breaks with it; the next sweep finds such a plot again and plants it anew.
   */
  private async sweep(
    area: Bounds,
    seed: string,
    input: PlantCropsInput,
    plantedSoFar: number,
    stemRows: ReadonlySet<number> | undefined,
    context: SkillContext,
  ): Promise<
    SkillResult<Pick<PlantCropsOutput, 'planted' | 'tilled' | 'skipped'> & { stopped: boolean }>
  > {
    let planted = 0
    let tilled = 0
    let skipped = 0
    const y = area.from.y
    for (let x = area.from.x; x <= area.to.x; x += 1) {
      for (let z = area.from.z; z <= area.to.z; z += 1) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        if (input.maxPlants !== undefined && plantedSoFar + planted >= input.maxPlants)
          return ok({ planted, tilled, skipped, stopped: true })

        if (stemRows !== undefined && !stemRows.has(z)) continue
        const ground = { x, y, z }
        const above = { x, y: y + 1, z }
        const groundName = this.deps.blocks.blockAt(ground)
        if (groundName === undefined) continue
        const aboveName = this.deps.blocks.blockAt(above)
        if (aboveName !== undefined && aboveName !== 'air') {
          skipped += 1
          continue
        }
        if (groundName !== 'farmland' && !TILLABLE.has(groundName)) {
          skipped += 1
          continue
        }

        const walked = await this.deps.navigator.goToPosition(ground, APPROACH_RANGE, {
          signal: context.signal,
        })
        if (!walked.ok) {
          if (walked.error.reason === 'aborted')
            return err({ reason: 'aborted', message: 'Cancelled.' })
          skipped += 1
          continue
        }

        if (groundName !== 'farmland') {
          const till = await this.deps.tiller.till(ground, context.signal)
          if (!till.ok) {
            if (till.error.reason === 'no_hoe')
              return err({ reason: 'no_hoe', message: 'The bot has no hoe to till with.' })
            skipped += 1
            continue
          }
          tilled += 1
        }

        const placed = await this.deps.placer.placeAt(seed, above)
        if (!placed.ok) {
          if (placed.error.reason === 'no_item')
            return err({
              reason: 'no_seeds',
              message:
                seed === 'pumpkin_seeds'
                  ? 'The bot has no pumpkin_seeds. Craft a pumpkin into seeds (one pumpkin gives four); the first pumpkin has to come from the player or a pumpkin patch in the world.'
                  : seed === 'melon_seeds'
                    ? 'The bot has no melon_seeds. Craft a melon slice into a seed (one slice gives one); the first seeds have to come from the player or from chests in the world (a jungle temple, a mineshaft, a dungeon).'
                    : `The bot has no ${seed} left to plant.`,
            })
          skipped += 1
          continue
        }
        planted += 1
        context.progress(`Planted ${String(plantedSoFar + planted)} ${input.crop}`)
      }
    }
    return ok({ planted, tilled, skipped, stopped: false })
  }

  /** The rows (z) of the area that hold at least one farmland plot. */
  private farmlandRows(area: Bounds): Set<number> {
    const rows = new Set<number>()
    const y = area.from.y
    for (let x = area.from.x; x <= area.to.x; x += 1)
      for (let z = area.from.z; z <= area.to.z; z += 1)
        if (this.deps.blocks.blockAt({ x, y, z }) === 'farmland') rows.add(z)
    return rows
  }

  private resolveArea(input: PlantCropsInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
