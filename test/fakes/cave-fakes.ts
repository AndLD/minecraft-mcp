import type { BlockInfo, BlockQuery } from '../../src/core/block-scanner.port.js'
import type { EntityInfo, EntityScanner, PlayerInfo } from '../../src/core/entity-scanner.port.js'
import type { Position } from '../../src/core/position.types.js'
import type { Vitals } from '../../src/core/vitals.port.js'
import { ConstructionWorld } from './construction-fakes.js'
import { buildVitals } from './fake-ports.js'

const key = (x: number, y: number, z: number): string => `${String(x)},${String(y)},${String(z)}`

/**
 * Solid rock up to y 100 with caves carved out of it. The bot walks anywhere instantly, torches light 14 minus the
 * distance, and blocks can be found by name.
 */
export class CaveWorld extends ConstructionWorld implements EntityScanner {
  health = 20
  food = 20
  dimension = 'minecraft:overworld'
  mobs: EntityInfo[] = []
  /** Block names the game knows, for `find` names. */
  known = [
    'air',
    'stone',
    'dirt',
    'diamond_ore',
    'deepslate_diamond_ore',
    'iron_ore',
    'deepslate_iron_ore',
    'coal_ore',
    'gold_ore',
    'spawner',
    'budding_amethyst',
    'reinforced_deepslate',
    'torch',
  ]

  constructor() {
    super(100)
    this.bot = { x: 0.5, y: 101, z: 0.5 }
  }

  /** Air in a box (both corners included). */
  carve(from: Position, to: Position, name = 'air'): this {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1)
      for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y += 1)
        for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z += 1)
          this.cells.set(key(x, y, z), name)
    return this
  }

  override knownBlockNames(): readonly string[] {
    return this.known
  }

  override findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const found: BlockInfo[] = []
    for (const [where, name] of this.cells) {
      if (!query.names.includes(name)) continue
      const [x = 0, y = 0, z = 0] = where.split(',').map(Number)
      const distance = Math.hypot(x - this.bot.x, y - this.bot.y, z - this.bot.z)
      if (distance <= query.maxDistance) found.push({ name, position: { x, y, z }, distance })
    }
    return found.sort((a, b) => a.distance - b.distance).slice(0, query.count)
  }

  override blockLightAt(position: Position): number | undefined {
    let best = 0
    for (const [where, name] of this.cells) {
      if (name !== 'torch') continue
      const [x = 0, y = 0, z = 0] = where.split(',').map(Number)
      best = Math.max(
        best,
        14 - Math.round(Math.hypot(x - position.x, y - position.y, z - position.z)),
      )
    }
    return best
  }

  torchCells(): Position[] {
    const torches: Position[] = []
    for (const [where, name] of this.cells) {
      if (name !== 'torch') continue
      const [x = 0, y = 0, z = 0] = where.split(',').map(Number)
      torches.push({ x, y, z })
    }
    return torches
  }

  override read(): Vitals {
    return buildVitals({
      position: this.bot,
      health: this.health,
      food: this.food,
      dimension: this.dimension,
    })
  }

  // EntityScanner
  knownEntityNames(): readonly string[] {
    return ['warden', 'zombie', 'skeleton']
  }
  nearby(maxDistance: number): readonly EntityInfo[] {
    return this.mobs.filter((mob) => mob.distance <= maxDistance)
  }
  player(): PlayerInfo | undefined {
    return undefined
  }
}
