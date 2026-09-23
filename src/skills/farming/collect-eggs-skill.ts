import type { AnimalScanner } from '../../core/animal-scanner.port.js'
import type { AreaGuard } from '../../core/area-guard.port.js'
import { countItems, gained } from '../../core/inventory-counts.js'
import type { InventoryReader } from '../../core/inventory.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { EggPolicy, EggRelease } from '../../state/egg-policy.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { DropCollector } from '../gathering/drop-collector.js'
import type { ItemDepositor } from '../storage/deposit-items-skill.js'
import type { EggThrower } from './egg-thrower.js'
import { insideBounds, type Bounds } from './farm-area.types.js'
import { penCapacity } from './providers/animal-pen.js'

/** Extra room, beyond the straight-line distance to the pen, given to the drop sweep's own search radius. */
const MARGIN = 24
const SEARCH_RADIUS = 48

export interface CollectEggsInput {
  readonly farm: string | undefined
  readonly area: Bounds | undefined
  readonly storeFraction: number | undefined
  readonly release: EggRelease | undefined
  readonly maxChickens: number | undefined
}

export interface CollectEggsOutput {
  readonly pickedUp: number
  readonly stored: number
  readonly released: number
  /** The pen already held its target chicken count, so fewer (or none) were released than the split would give. */
  readonly penFull: boolean
}

export interface CollectEggsDeps {
  readonly drops: DropCollector
  readonly inventory: InventoryReader
  readonly vitals: VitalsReader
  readonly animals: AnimalScanner
  readonly guard: AreaGuard
  readonly depositor: ItemDepositor
  readonly thrower: EggThrower
  readonly policy: EggPolicy
  readonly farms: FarmRegistry
}

const boundsCenter = (bounds: Bounds): Position => ({
  x: Math.floor((bounds.from.x + bounds.to.x) / 2),
  y: bounds.from.y,
  z: Math.floor((bounds.from.z + bounds.to.z) / 2),
})

/**
 * Picks up the `egg` items lying in a registered pen or a given area (never by hitting or harming a chicken: this
 * skill only ever touches ground items, the same as `pickup_items`), skipping a protected area unless it is the
 * pen's own. A share is stored (through the ordinary storage rules and policy, like any other deposit) and the rest
 * is thrown into the pen with `EggThrower`, unless the pen already holds its target chicken count.
 */
export class CollectEggsSkill implements Skill<CollectEggsInput, CollectEggsOutput> {
  readonly name = 'collect_eggs'

  constructor(private readonly deps: CollectEggsDeps) {}

  async run(input: CollectEggsInput, context: SkillContext): Promise<SkillResult<CollectEggsOutput>> {
    const farm = input.farm === undefined ? undefined : this.deps.farms.resolve(input.farm)
    const bounds = input.area ?? farm?.bounds
    if (bounds === undefined)
      return err({ reason: 'no_area', message: 'Give a farm or an area to collect eggs from.' })

    const here = this.deps.vitals.read()?.position
    if (here === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const center = boundsCenter(bounds)
    const maxDistance = distanceBetween(here, center) + MARGIN

    const before = countItems(this.deps.inventory.snapshot())
    await this.deps.drops.collect(
      {
        names: ['egg'],
        maxDistance,
        accept: (item) => insideBounds(item.position, bounds) && this.allowedHere(item.position, farm),
      },
      context.signal,
    )
    const pickedUp =
      gained(before, countItems(this.deps.inventory.snapshot())).find((i) => i.name === 'egg')?.count ?? 0
    if (pickedUp === 0) return ok({ pickedUp: 0, stored: 0, released: 0, penFull: false })

    const policy = this.deps.policy.get()
    const storeFraction = input.storeFraction ?? policy.storeFraction
    const release = input.release ?? policy.release
    const wantStored = release === 'store' ? pickedUp : Math.ceil(pickedUp * storeFraction)
    const wantReleased = pickedUp - wantStored

    const maxChickens = input.maxChickens ?? farm?.herdTarget ?? penCapacity(boundsWidth(bounds), boundsLength(bounds))
    const currentChickens = this.deps.animals
      .nearby(SEARCH_RADIUS)
      .filter((a) => a.species === 'chicken' && insideBounds(a.position, bounds)).length
    const room = Math.max(maxChickens - currentChickens, 0)
    const released = Math.min(wantReleased, room)
    const stored = pickedUp - released

    if (stored > 0)
      await this.deps.depositor.run(
        { specs: ['egg'], includeReserved: false, container: undefined, count: stored, maxDistance: 64 },
        context,
      )
    const thrown = released > 0 ? await this.deps.thrower.throw(released, center, context.signal) : 0

    return ok({ pickedUp, stored, released: thrown, penFull: wantReleased > released })
  }

  private allowedHere(position: Position, farm: FarmEntry | undefined): boolean {
    const area = this.deps.guard.protectedAt(position)
    if (area === undefined) return true
    return farm !== undefined && area.label === (farm.label ?? farm.id)
  }
}

const boundsWidth = (bounds: Bounds): number => bounds.to.x - bounds.from.x + 1
const boundsLength = (bounds: Bounds): number => bounds.to.z - bounds.from.z + 1
