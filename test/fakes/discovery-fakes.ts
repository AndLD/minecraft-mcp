import type { BlockInfo, BlockQuery, BlockScanner } from '../../src/core/block-scanner.port.js'
import type { EntityInfo, EntityScanner, PlayerInfo } from '../../src/core/entity-scanner.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Vitals, VitalsReader } from '../../src/core/vitals.port.js'

export const GROUND = 63

const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`
const OPEN = new Set(['air', 'cave_air'])

/**
 * A flat Overworld: stone up to y 63, air above. Blocks and mobs are put where a test says; the bot only sees within
 * `loaded` blocks of where it stands, like the chunks a server sends.
 */
export class DiscoveryWorld implements BlockScanner, EntityScanner, VitalsReader {
  bot: Position = { x: 0, y: GROUND + 1, z: 0 }
  dimension = 'minecraft:overworld'
  loaded = 160
  private readonly placed = new Map<string, string>()
  private mobs: EntityInfo[] = []

  put(x: number, y: number, z: number, name: string): this {
    this.placed.set(key(x, y, z), name)
    return this
  }

  /** A lake: water at the top of every column in the rectangle. */
  lake(x1: number, z1: number, x2: number, z2: number): this {
    for (let x = x1; x <= x2; x += 1)
      for (let z = z1; z <= z2; z += 1) this.put(x, GROUND, z, 'water')
    return this
  }

  mob(name: string, x: number, z: number): this {
    this.mobs.push({
      id: this.mobs.length + 1,
      category: 'passive',
      name,
      position: { x, y: GROUND + 1, z },
      distance: 0,
    })
    return this
  }

  knownBlockNames(): readonly string[] {
    return []
  }

  blockAt(position: Position): string | undefined {
    if (Math.hypot(position.x - this.bot.x, position.z - this.bot.z) > this.loaded) return undefined
    const placed = this.placed.get(key(position.x, position.y, position.z))
    if (placed !== undefined) return placed
    return position.y <= GROUND ? 'stone' : 'air'
  }

  isSolid(position: Position): boolean | undefined {
    const name = this.blockAt(position)
    return name === undefined ? undefined : !OPEN.has(name) && name !== 'water' && name !== 'lava'
  }

  findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const found: BlockInfo[] = []
    for (const [where, name] of this.placed) {
      if (!query.names.includes(name)) continue
      const [x = 0, y = 0, z = 0] = where.split(',').map(Number)
      const distance = Math.hypot(x - this.bot.x, y - this.bot.y, z - this.bot.z)
      if (distance <= query.maxDistance) found.push({ name, position: { x, y, z }, distance })
    }
    return found.sort((a, b) => a.distance - b.distance).slice(0, query.count)
  }

  sampleBlocks(): never[] {
    return []
  }

  nearby(maxDistance: number): readonly EntityInfo[] {
    return this.mobs
      .map((mob) => ({
        ...mob,
        distance: Math.hypot(mob.position.x - this.bot.x, mob.position.z - this.bot.z),
      }))
      .filter((mob) => mob.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
  }

  player(): PlayerInfo | undefined {
    return undefined
  }

  read(): Vitals {
    return {
      health: 20,
      food: 20,
      saturation: 5,
      oxygen: 20,
      inLava: false,
      inWater: false,
      headUnderwater: false,
      position: this.bot,
      dimension: this.dimension,
      timeOfDay: 1000,
    }
  }
}

/** Walks the bot to wherever it is sent, at once, unless a test makes a trip fail. */
export class DiscoveryNavigator implements Navigator {
  readonly trips: Position[] = []
  /** Decides whether a trip fails; return a failure to refuse it. */
  refuse: (target: Position) => NavigationFailure | undefined = () => undefined
  /** Runs after each trip that arrived (a test advances the clock here). */
  afterTrip: () => void = () => undefined

  constructor(private readonly world: DiscoveryWorld) {}

  goToPosition(
    target: Position,
    _within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.trips.push(target)
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const refused = this.refuse(target)
    if (refused !== undefined) return Promise.resolve(err(refused))
    this.world.bot = { ...target }
    this.afterTrip()
    return Promise.resolve(ok(target))
  }

  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(err({ reason: 'target_not_found', message: 'No players here.' }))
  }

  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}
