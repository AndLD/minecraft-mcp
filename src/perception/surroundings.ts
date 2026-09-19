import type { EntityInfo, EntityScanner } from '../core/entity-scanner.port.js'
import type { BlockScanner } from '../core/block-scanner.port.js'
import { roundPosition } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { VitalsReader } from '../core/vitals.port.js'
import { isNotableBlock } from './notable-blocks.js'

export interface NotableBlockReport {
  readonly name: string
  readonly count: number
  readonly nearest: Position
  readonly distance: number
}

export interface EntityGroup {
  readonly name: string
  readonly category: string
  readonly count: number
  readonly nearestDistance: number
}

export interface SurroundingsReport {
  readonly position: Position
  readonly dimension: string
  readonly timeOfDay: number
  readonly standingOn: string | null
  readonly radius: number
  /** Ores, logs, containers, liquids, and other useful blocks, nearest first. */
  readonly notableBlocks: readonly NotableBlockReport[]
  /** The most common other blocks (terrain). */
  readonly terrain: readonly { readonly name: string; readonly count: number }[]
  readonly entities: readonly EntityGroup[]
}

const MAX_NOTABLE = 15
const MAX_TERRAIN = 5
const MAX_ENTITY_GROUPS = 15
const ENTITY_RADIUS = 16

const round1 = (value: number): number => Math.round(value * 10) / 10

/** Describes what is around the bot in a compact form an agent can reason about. */
export class SurroundingsDescriber {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly entities: EntityScanner,
    private readonly vitals: VitalsReader,
  ) {}

  describe(radius: number): Result<SurroundingsReport> {
    const vitals = this.vitals.read()
    if (vitals === undefined) return err('Not connected to a Minecraft world.')

    const summaries = this.blocks.sampleBlocks(radius)
    const notableBlocks = summaries
      .filter((summary) => isNotableBlock(summary.name))
      .sort((a, b) => a.nearestDistance - b.nearestDistance)
      .slice(0, MAX_NOTABLE)
      .map((summary) => ({
        name: summary.name,
        count: summary.count,
        nearest: summary.nearest,
        distance: round1(summary.nearestDistance),
      }))
    const terrain = summaries
      .filter((summary) => !isNotableBlock(summary.name))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TERRAIN)
      .map((summary) => ({ name: summary.name, count: summary.count }))

    const below = {
      x: Math.floor(vitals.position.x),
      y: Math.floor(vitals.position.y) - 1,
      z: Math.floor(vitals.position.z),
    }
    return ok({
      position: roundPosition(vitals.position),
      dimension: vitals.dimension,
      timeOfDay: vitals.timeOfDay,
      standingOn: this.blocks.blockAt(below) ?? null,
      radius,
      notableBlocks,
      terrain,
      entities: groupEntities(this.entities.nearby(ENTITY_RADIUS)),
    })
  }
}

function groupEntities(entities: readonly EntityInfo[]): EntityGroup[] {
  const groups = new Map<string, EntityGroup>()
  for (const entity of entities) {
    const key = `${entity.category}:${entity.name}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        name: entity.name,
        category: entity.category,
        count: 1,
        nearestDistance: round1(entity.distance),
      })
    } else {
      groups.set(key, { ...existing, count: existing.count + 1 }) // entities arrive nearest first
    }
  }
  return [...groups.values()].slice(0, MAX_ENTITY_GROUPS)
}
