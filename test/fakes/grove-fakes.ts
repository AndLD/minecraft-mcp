import type {
  BlockInfo,
  BlockQuery,
  BlockScanner,
  BlockSummary,
} from '../../src/core/block-scanner.port.js'
import type { DigAssessment, DigFailure, Digger } from '../../src/core/digger.port.js'
import type { PlaceFailure, Placer } from '../../src/core/placer.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'

const keyOf = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`

/**
 * A small block world: cells inside the loaded box read as air until set, cells outside read as not loaded.
 * `findBlocks` answers from the bot's fixed origin, like the real scanner.
 */
export class GroveWorld implements BlockScanner {
  private readonly blocks = new Map<string, string>()
  origin: Position = { x: 0, y: 64, z: 0 }
  names: string[] = [
    'air',
    'dirt',
    'grass_block',
    'stone',
    'oak_log',
    'birch_log',
    'dark_oak_log',
    'oak_sapling',
    'birch_sapling',
    'dark_oak_sapling',
    'oak_leaves',
    'dirt_path',
    'oak_door',
  ]

  constructor(
    private readonly loaded: { x0: number; x1: number; z0: number; z1: number; y0: number; y1: number },
  ) {}

  set(x: number, y: number, z: number, name: string): void {
    this.blocks.set(keyOf(x, y, z), name)
  }

  /** Grass over the whole rectangle at `y` (dirt underneath is not modelled). */
  ground(x0: number, z0: number, x1: number, z1: number, y: number, name = 'grass_block'): void {
    for (let x = x0; x <= x1; x += 1) for (let z = z0; z <= z1; z += 1) this.set(x, y, z, name)
  }

  /** A trunk `height` logs high standing on the ground block at (x, groundY, z). */
  trunk(x: number, groundY: number, z: number, height: number, log = 'oak_log'): void {
    for (let dy = 1; dy <= height; dy += 1) this.set(x, groundY + dy, z, log)
  }

  knownBlockNames(): readonly string[] {
    return this.names
  }

  blockAt(position: Position): string | undefined {
    const stored = this.blocks.get(keyOf(position.x, position.y, position.z))
    if (stored !== undefined) return stored
    const inside =
      position.x >= this.loaded.x0 &&
      position.x <= this.loaded.x1 &&
      position.z >= this.loaded.z0 &&
      position.z <= this.loaded.z1 &&
      position.y >= this.loaded.y0 &&
      position.y <= this.loaded.y1
    return inside ? 'air' : undefined
  }

  isSolid(position: Position): boolean | undefined {
    const name = this.blockAt(position)
    return name === undefined ? undefined : name !== 'air'
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const found: BlockInfo[] = []
    for (const [key, name] of this.blocks) {
      if (!query.names.includes(name)) continue
      const [x, y, z] = key.split(',').map(Number) as [number, number, number]
      const distance = Math.hypot(x - this.origin.x, y - this.origin.y, z - this.origin.z)
      if (distance <= query.maxDistance) found.push({ name, position: { x, y, z }, distance })
    }
    return found.sort((a, b) => a.distance - b.distance).slice(0, query.count)
  }

  sampleBlocks(): readonly BlockSummary[] {
    return []
  }
}

/** Digging turns the block to air. Cells listed in `unreachable` fail with out_of_reach. */
export class GroveDigger implements Digger {
  readonly dug: Position[] = []
  readonly unreachable = new Set<string>()
  /** Cells that are out of reach the first time only (the bot has to step closer). */
  readonly farFirst = new Set<string>()
  /** Called after every successful dig, for example to add the drop to the inventory. */
  onDug: (position: Position, name: string) => void = () => undefined

  constructor(private readonly world: GroveWorld) {}

  assess(position: Position): DigAssessment | undefined {
    const name = this.world.blockAt(position)
    if (name === undefined) return undefined
    return { blockName: name, diggable: name !== 'air', requiredTools: [], canHarvest: true, tool: undefined }
  }

  dig(position: Position): Promise<Result<void, DigFailure>> {
    const key = keyOf(position.x, position.y, position.z)
    if (this.unreachable.has(key))
      return Promise.resolve(err({ reason: 'out_of_reach', message: 'too far' }))
    if (this.farFirst.delete(key))
      return Promise.resolve(err({ reason: 'out_of_reach', message: 'too far' }))
    this.dug.push(position)
    const name = this.world.blockAt(position) ?? 'air'
    this.world.set(position.x, position.y, position.z, 'air')
    this.onDug(position, name)
    return Promise.resolve(ok(undefined))
  }
}

/** Placing puts the item's name into the world, spending it from a carried count. */
export class GrovePlacer implements Placer {
  readonly placed: { item: string; at: Position }[] = []
  /** Called after each successful placement, for example to reduce the inventory. */
  onPlaced: (item: string) => void = () => undefined

  constructor(private readonly world: GroveWorld) {}

  placeAt(itemName: string, target: Position): Promise<Result<void, PlaceFailure>> {
    this.placed.push({ item: itemName, at: target })
    this.world.set(target.x, target.y, target.z, itemName)
    this.onPlaced(itemName)
    return Promise.resolve(ok(undefined))
  }

  placeAgainst(): Promise<Result<void, PlaceFailure>> {
    return Promise.resolve(ok(undefined))
  }
}
