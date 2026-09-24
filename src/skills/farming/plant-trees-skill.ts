import { countItems } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Placer } from '../../core/placer.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { FarmEntry, FarmRegistry, GroveSpot } from '../../state/farm-registry.js'
import type { Bounds } from './farm-area.types.js'
import { scanGrove, spotCells } from './grove-scan.js'
import type { GroveRegion, GroveSpotFinder } from './grove-spots.js'
import { MAX_TREE_HEIGHT, treeFor } from './tree-table.js'

const APPROACH_RANGE = 3
const DEFAULT_RING_DISTANCE = 6
const DEFAULT_RING_DEPTH = 6

/** A box to plant around (a house, or a single point when `to` is left out), as a ring at a distance. */
export interface AroundArea {
  readonly from: Position
  readonly to: Position | undefined
  /** How far the ring starts from the box (blocks). */
  readonly distance: number | undefined
  /** How wide the ring is (blocks). */
  readonly depth: number | undefined
}

export interface PlantTreesInput {
  /** The tree species (`oak`) or its sapling; a grove's own species when replanting one. */
  readonly species: string | undefined
  /** How many trees; left out to refill the empty spots of a grove `plant_trees` planted earlier. */
  readonly count: number | undefined
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  readonly around: AroundArea | undefined
  readonly spacing: number | undefined
  /** Plant the 2x2 variant (four saplings per tree): spruce and jungle only grow big this way, dark oak always does. */
  readonly big: boolean | undefined
  /** Only report where the trees would go; place nothing. */
  readonly preview: boolean
  readonly label: string | undefined
  readonly group: string | undefined
}

export interface PlantTreesOutput {
  readonly mode: 'plant' | 'replant' | 'preview'
  readonly species: string
  readonly requested: number
  readonly planted: number
  readonly skipped: number
  /** Saplings still needed for the trees that could not be planted. */
  readonly saplingsMissing: number
  readonly spots: readonly GroveSpot[]
  /** What the area could hold at this spacing, and why other cells were turned down. */
  readonly capacity: number | undefined
  readonly rejected: Readonly<Record<string, number>> | undefined
  readonly farm: string | undefined
  readonly protectedArea: boolean
}

/** What plant_trees needs from protection: adding a box, best effort. */
export interface AreaProtector {
  add(label: string, cornerA: Position, cornerB: Position): Result<unknown>
}

export interface PlantTreesDeps {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly placer: Placer
  readonly inventory: InventoryReader
  readonly farms: FarmRegistry
  readonly finder: GroveSpotFinder
  readonly protectedAreas: AreaProtector
}

const expand = (from: Position, to: Position, by: number): Bounds => ({
  from: {
    x: Math.min(from.x, to.x) - by,
    y: Math.min(from.y, to.y),
    z: Math.min(from.z, to.z) - by,
  },
  to: { x: Math.max(from.x, to.x) + by, y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) + by },
})

/**
 * Plants tree saplings: works out spots that suit the species (`GroveSpotFinder`), walks to each and places a
 * sapling (four in a 2x2 for the big variants), and remembers the result as a grove (`FarmRegistry`, protected from
 * other tasks). Pointed at a grove it planted before, with no count, it refills the spots where a tree is gone.
 * Planting needs the saplings in the inventory: it never breaks leaves for them, it says how many are missing.
 */
export class PlantTreesSkill implements Skill<PlantTreesInput, PlantTreesOutput> {
  readonly name = 'plant_trees'

  constructor(private readonly deps: PlantTreesDeps) {}

  async run(input: PlantTreesInput, context: SkillContext): Promise<SkillResult<PlantTreesOutput>> {
    const entry = input.farm === undefined ? undefined : this.deps.farms.resolve(input.farm)
    if (input.farm !== undefined && entry === undefined)
      return err({ reason: 'unknown_farm', message: `There is no farm "${input.farm}". See list_farms.` })

    if (entry !== undefined && entry.kind !== 'grove')
      return err({
        reason: 'not_a_grove',
        message: `${entry.label ?? entry.id} is a ${entry.kind}, not a grove. Give an area instead.`,
      })

    const speciesName = input.species ?? entry?.crop ?? undefined
    if (speciesName === undefined)
      return err({ reason: 'no_species', message: 'Say which tree to plant (oak, birch, spruce, ...).' })
    const tree = treeFor(speciesName)
    if (tree === undefined)
      return err({ reason: 'unknown_species', message: `${speciesName} is not a tree this can plant.` })
    if (input.big === true && !tree.canBig)
      return err({ reason: 'no_big_variant', message: `${tree.name} does not grow a 2x2 variant.` })
    const big = tree.forceBig || input.big === true

    const replant =
      entry !== undefined &&
      entry.spots !== null &&
      input.count === undefined &&
      input.area === undefined &&
      input.around === undefined
    if (replant) return this.replant(entry, tree.name, input, context)

    if (input.count === undefined)
      return err({ reason: 'no_count', message: 'Say how many trees to plant.' })
    const region = this.regionOf(input, entry)
    if (region === undefined)
      return err({ reason: 'no_area', message: 'Give an area, a farm, or a place to plant around.' })

    const found = this.deps.finder.find({
      tree,
      big,
      count: input.count,
      region,
      spacing: input.spacing ?? (big ? tree.bigSpacing : tree.spacing),
      own: entry === undefined ? undefined : { id: entry.id, label: entry.label ?? entry.id },
    })
    if ('error' in found) return err({ reason: 'invalid_area', message: found.error })
    if (found.spots.length === 0)
      return err({
        reason: 'no_spots',
        message: `No spot in that area suits ${tree.name}. Turned down: ${describe(found.rejected)}.`,
        detail: { rejected: found.rejected },
      })

    const base = {
      species: tree.name,
      requested: input.count,
      capacity: found.capacity,
      rejected: found.rejected,
    }
    if (input.preview)
      return ok({
        ...base,
        mode: 'preview',
        planted: 0,
        skipped: 0,
        saplingsMissing: 0,
        spots: found.spots,
        farm: entry?.id,
        protectedArea: false,
      })

    const placed = await this.placeAll(found.spots, tree.sapling, context)
    if (placed.planted.length === 0 && placed.missing > 0 && !placed.aborted)
      return err({
        reason: 'no_saplings',
        message:
          `The bot has no ${tree.sapling} to plant. Gather some (collect_saplings, or collect_block with ` +
          'saplings) or fetch them from a chest.',
      })

    let farmId = entry?.id
    let protectedArea = false
    if (placed.planted.length > 0) {
      if (entry !== undefined) {
        this.deps.farms.addSpots(entry.id, placed.planted)
      } else {
        const registered = this.deps.farms.register({
          kind: 'grove',
          crop: tree.name,
          bounds: this.boundsOf(placed.planted, input.area),
          spots: placed.planted,
          label: input.label,
          group: input.group,
          builtByBot: true,
        })
        if (!registered.ok)
          return err({ reason: 'registration_failed', message: registered.error })
        farmId = registered.value.id
        if (input.around === undefined) {
          const box = registered.value.bounds
          protectedArea = this.deps.protectedAreas.add(
            registered.value.label ?? registered.value.id,
            { ...box.from, y: box.from.y - 1 },
            { ...box.to, y: box.to.y + MAX_TREE_HEIGHT },
          ).ok
        }
      }
    }
    if (placed.aborted)
      return err({
        reason: 'aborted',
        message: `Cancelled after planting ${String(placed.planted.length)} tree(s).`,
        detail: { planted: placed.planted.length, farm: farmId },
      })
    return ok({
      ...base,
      mode: 'plant',
      planted: placed.planted.length,
      skipped: placed.skipped,
      saplingsMissing: placed.missing,
      spots: placed.planted,
      farm: farmId,
      protectedArea,
    })
  }

  private async replant(
    entry: FarmEntry,
    species: string,
    input: PlantTreesInput,
    context: SkillContext,
  ): Promise<SkillResult<PlantTreesOutput>> {
    const tree = treeFor(species)
    if (tree === undefined)
      return err({ reason: 'unknown_species', message: `${species} is not a tree this can plant.` })
    const empty = scanGrove(entry, this.deps.blocks)
      .filter((site) => site.state === 'empty')
      .map((site) => site.spot)
    const base = {
      species: tree.name,
      requested: empty.length,
      capacity: undefined,
      rejected: undefined,
      farm: entry.id,
      protectedArea: false,
    }
    if (input.preview)
      return ok({ ...base, mode: 'preview', planted: 0, skipped: 0, saplingsMissing: 0, spots: empty })
    if (empty.length === 0)
      return ok({ ...base, mode: 'replant', planted: 0, skipped: 0, saplingsMissing: 0, spots: [] })

    const placed = await this.placeAll(empty, tree.sapling, context)
    if (placed.aborted)
      return err({ reason: 'aborted', message: 'Cancelled.', detail: { planted: placed.planted.length } })
    return ok({
      ...base,
      mode: 'replant',
      planted: placed.planted.length,
      skipped: placed.skipped,
      saplingsMissing: placed.missing,
      spots: placed.planted,
    })
  }

  private async placeAll(
    spots: readonly GroveSpot[],
    sapling: string,
    context: SkillContext,
  ): Promise<{ planted: GroveSpot[]; skipped: number; missing: number; aborted: boolean }> {
    const planted: GroveSpot[] = []
    let skipped = 0
    let missing = 0
    let carried = countItems(this.deps.inventory.snapshot()).get(sapling) ?? 0
    for (const spot of spots) {
      if (context.signal.aborted) return { planted, skipped, missing, aborted: true }
      const need = spot.size * spot.size
      if (carried < need) {
        missing += need - Math.max(carried, 0)
        continue
      }
      const walked = await this.deps.navigator.goToPosition(spot, APPROACH_RANGE, {
        signal: context.signal,
      })
      if (!walked.ok) {
        if (walked.error.reason === 'aborted') return { planted, skipped, missing, aborted: true }
        skipped += 1
        continue
      }
      let done = 0
      for (const cell of spotCells(spot)) {
        const result = await this.deps.placer.placeAt(sapling, cell)
        if (result.ok) {
          done += 1
          carried -= 1
        }
      }
      if (done === need) {
        planted.push(spot)
        context.progress(`Planted ${String(planted.length)} ${sapling}`)
      } else skipped += 1
    }
    return { planted, skipped, missing, aborted: false }
  }

  private regionOf(input: PlantTreesInput, entry: FarmEntry | undefined): GroveRegion | undefined {
    if (input.around !== undefined) {
      const { from, distance, depth } = input.around
      const to = input.around.to ?? from
      const gap = distance ?? DEFAULT_RING_DISTANCE
      return {
        rect: expand(from, to, gap + (depth ?? DEFAULT_RING_DEPTH)),
        keepOut: expand(from, to, gap),
      }
    }
    if (input.area !== undefined) return { rect: input.area }
    if (entry !== undefined) return { rect: entry.bounds }
    return undefined
  }

  private boundsOf(spots: readonly GroveSpot[], area: Bounds | undefined): Bounds {
    if (area !== undefined) return area
    const xs = spots.flatMap((spot) => [spot.x, spot.x + spot.size - 1])
    const zs = spots.flatMap((spot) => [spot.z, spot.z + spot.size - 1])
    const ys = spots.map((spot) => spot.y - 1)
    return {
      from: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
      to: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
    }
  }
}

function describe(rejected: Readonly<Record<string, number>>): string {
  const parts = Object.entries(rejected).map(([reason, count]) => `${reason} ${String(count)}`)
  return parts.length === 0 ? 'nothing fits' : parts.join(', ')
}
