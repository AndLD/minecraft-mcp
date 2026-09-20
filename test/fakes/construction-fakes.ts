import type { AreaGuard, ProtectedArea } from '../../src/core/area-guard.port.js'
import type {
  BlockInfo,
  BlockQuery,
  BlockScanner,
  BlockSummary,
} from '../../src/core/block-scanner.port.js'
import type { DigAssessment, DigFailure, Digger } from '../../src/core/digger.port.js'
import type { InventoryReader, InventorySnapshot } from '../../src/core/inventory.port.js'
import type { Locomotion } from '../../src/core/locomotion.port.js'
import type { LightReader } from '../../src/core/light-reader.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import type { PlaceFailure, Placer } from '../../src/core/placer.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Vitals, VitalsReader } from '../../src/core/vitals.port.js'
import { buildVitals } from './fake-ports.js'

const key = (p: Position): string =>
  `${String(Math.floor(p.x))},${String(Math.floor(p.y))},${String(Math.floor(p.z))}`

const NOT_SOLID = new Set([
  'air',
  'cave_air',
  'water',
  'lava',
  'short_grass',
  'tall_grass',
  'torch',
  'wall_torch',
  'snow',
  'oak_door',
])

/**
 * A small block world for construction tests: solid dirt up to `groundY`, air above, and every operation the
 * executor needs (scanning, placing, digging, walking, inventory, light) working on the same grid.
 */
export class ConstructionWorld
  implements
    BlockScanner,
    Placer,
    Digger,
    Navigator,
    InventoryReader,
    VitalsReader,
    LightReader,
    AreaGuard,
    Locomotion
{
  readonly cells = new Map<string, string>()
  readonly protectedBoxes: { label: string; contains: (p: Position) => boolean }[] = []
  /** Cells the fake treats as not loaded. */
  readonly unloaded = new Set<string>()
  bot: Position = { x: 0.5, y: 64, z: 0.5 }
  carried = new Map<string, number>()
  emptySlots = 30
  readonly light = new Map<string, number>()
  readonly log: string[] = []
  /** Trips the navigator made. */
  readonly trips: Position[] = []
  /** Failures for the next placements, in order; `'ignored'` makes the server silently not place. */
  placeFailures: (PlaceFailure | 'ignored' | undefined)[] = []
  navFailures: (NavigationFailure | undefined)[] = []
  digFailures: (DigFailure | undefined)[] = []
  /** Cells where placing always fails, however often it is tried. */
  readonly stubbornCells = new Set<string>()
  /** Blocks that need a tool to harvest. */
  needsTool = new Map<string, string>()
  hasTool = true
  /** When false the bot cannot jump (something is wrong), so pillaring up fails. */
  canJump = true
  jumps = 0
  /** Called after every placement, so a test can react (for example abort). */
  onPlaced: (at: Position) => void = () => undefined

  constructor(readonly groundY = 63) {}

  setBlock(at: Position, name: string): void {
    this.cells.set(key(at), name)
  }

  give(name: string, count: number): void {
    this.carried.set(name, (this.carried.get(name) ?? 0) + count)
  }

  nameAt(at: Position): string {
    return this.cells.get(key(at)) ?? (Math.floor(at.y) <= this.groundY ? 'dirt' : 'air')
  }

  // BlockScanner
  knownBlockNames(): readonly string[] {
    return ['air', 'dirt', 'stone', 'oak_planks', 'cobblestone']
  }
  findBlocks(_query: BlockQuery): readonly BlockInfo[] {
    return []
  }
  blockAt(position: Position): string | undefined {
    return this.unloaded.has(key(position)) ? undefined : this.nameAt(position)
  }
  isSolid(position: Position): boolean | undefined {
    if (this.unloaded.has(key(position))) return undefined
    return !NOT_SOLID.has(this.nameAt(position))
  }
  sampleBlocks(): readonly BlockSummary[] {
    return []
  }

  // LightReader
  blockLightAt(position: Position): number | undefined {
    return this.unloaded.has(key(position)) ? undefined : (this.light.get(key(position)) ?? 0)
  }

  // AreaGuard
  protectedAt(position: Position): ProtectedArea | undefined {
    const box = this.protectedBoxes.find((candidate) => candidate.contains(position))
    return box === undefined ? undefined : { id: 'area-1', label: box.label }
  }

  // InventoryReader
  snapshot(): InventorySnapshot | undefined {
    return {
      stacks: [...this.carried].map(([name, count]) => ({ name, count })),
      emptySlots: this.emptySlots,
      heldItem: undefined,
    }
  }

  // VitalsReader
  read(): Vitals | undefined {
    return buildVitals({ position: this.bot })
  }

  // Navigator
  goToPosition(
    target: Position,
    _within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.navFailures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    this.trips.push(target)
    this.bot = target
    return Promise.resolve(ok(target))
  }
  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(err({ reason: 'target_not_found', message: 'No player.' }))
  }
  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }

  // Locomotion: a jump lifts the bot 1.25 blocks; it lands on whatever is below it when something changes.
  setJump(active: boolean): void {
    if (!active || !this.canJump) return
    this.jumps += 1
    this.bot = { ...this.bot, y: Math.floor(this.bot.y) + 1.25 }
  }

  /** The bot falls until it stands on something solid. */
  private settle(): void {
    let y = Math.floor(this.bot.y)
    while (y > 0 && this.isSolid({ x: this.bot.x, y: y - 1, z: this.bot.z }) !== true) y -= 1
    this.bot = { ...this.bot, y }
  }

  // Placer
  placeAt(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(err({ reason: 'failed', message: 'not used' }))
  }
  placeAgainst(
    item: string,
    reference: Position,
    face: Position,
  ): Promise<Result<void, PlaceFailure>> {
    if ((this.carried.get(item) ?? 0) === 0)
      return Promise.resolve(err({ reason: 'no_item', message: `No ${item}.` }))
    if (this.isSolid(reference) !== true)
      return Promise.resolve(err({ reason: 'no_support', message: 'Nothing solid there.' }))
    const at = {
      x: Math.floor(reference.x) + face.x,
      y: Math.floor(reference.y) + face.y,
      z: Math.floor(reference.z) + face.z,
    }
    if (this.stubbornCells.has(key(at)))
      return Promise.resolve(err({ reason: 'failed', message: 'the server says no' }))
    const failure = this.placeFailures.shift()
    if (failure !== undefined && failure !== 'ignored') return Promise.resolve(err(failure))
    // The server refuses a block where the bot itself stands.
    const feet = { x: Math.floor(this.bot.x), y: Math.floor(this.bot.y), z: Math.floor(this.bot.z) }
    if (key(at) === key(feet) || key(at) === key({ ...feet, y: feet.y + 1 }))
      return Promise.resolve(err({ reason: 'failed', message: 'The bot is in the way.' }))
    this.log.push(`place ${item} ${key(at)}`)
    if (failure === 'ignored') return Promise.resolve(ok(undefined))
    // A bucket makes the fluid, and comes back empty.
    const fluid = item === 'water_bucket' ? 'water' : item === 'lava_bucket' ? 'lava' : undefined
    this.setBlock(at, fluid ?? item)
    this.carried.set(item, (this.carried.get(item) ?? 0) - 1)
    if (fluid !== undefined) this.give('bucket', 1)
    this.settle()
    this.onPlaced(at)
    return Promise.resolve(ok(undefined))
  }

  // Digger
  assess(position: Position): DigAssessment | undefined {
    if (this.unloaded.has(key(position))) return undefined
    const name = this.nameAt(position)
    const tool = this.needsTool.get(name)
    return {
      blockName: name,
      diggable: name !== 'air' && name !== 'bedrock',
      requiredTools: tool === undefined ? [] : [tool],
      canHarvest: tool === undefined || this.hasTool,
      tool: undefined,
    }
  }
  dig(position: Position, signal: AbortSignal): Promise<Result<void, DigFailure>> {
    if (signal.aborted) return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.digFailures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    this.log.push(`dig ${key(position)}`)
    const name = this.nameAt(position)
    this.setBlock(position, 'air')
    this.give(name, 1) // the drop is picked up at once
    this.settle()
    return Promise.resolve(ok(undefined))
  }

  /** Every non-air cell above the ground, by name: what has been built. */
  builtBlocks(): Map<string, string> {
    const built = new Map<string, string>()
    for (const [cell, name] of this.cells) {
      const y = Number(cell.split(',')[1])
      if (y > this.groundY && name !== 'air') built.set(cell, name)
    }
    return built
  }
}
