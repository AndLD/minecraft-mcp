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
    if (area === undefined) return err({ reason: 'no_area', message: 'Give a farm or an area to plant.' })

    let planted = 0
    let tilled = 0
    let skipped = 0
    const y = area.from.y
    for (let x = area.from.x; x <= area.to.x; x += 1) {
      for (let z = area.from.z; z <= area.to.z; z += 1) {
        if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
        if (input.maxPlants !== undefined && planted >= input.maxPlants)
          return ok({ planted, tilled, skipped })

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
          if (walked.error.reason === 'aborted') return err({ reason: 'aborted', message: 'Cancelled.' })
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

        const placed = await this.deps.placer.placeAt(spec.spec.seed, above)
        if (!placed.ok) {
          if (placed.error.reason === 'no_item')
            return err({
              reason: 'no_seeds',
              message: `The bot has no ${spec.spec.seed} left to plant.`,
            })
          skipped += 1
          continue
        }
        planted += 1
        context.progress(`Planted ${String(planted)} ${input.crop}`)
      }
    }
    return ok({ planted, tilled, skipped })
  }

  private resolveArea(input: PlantCropsInput): Bounds | undefined {
    if (input.area !== undefined) return input.area
    if (input.farm === undefined) return undefined
    return this.deps.farms.resolve(input.farm)?.bounds
  }
}
