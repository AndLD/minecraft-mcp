import type {
  BucketFailure,
  BucketFiller,
  FilledBucket,
  Liquid,
  LiquidReader,
  LiquidState,
} from '../../src/core/bucket.port.js'
import type { BlockInfo, BlockQuery } from '../../src/core/block-scanner.port.js'
import { distanceBetween } from '../../src/core/position.js'
import type { Position } from '../../src/core/position.types.js'
import { EYE_HEIGHT, REACH } from '../../src/core/reach.js'
import { err, ok, type Result } from '../../src/core/result.js'
import { ConstructionWorld } from './construction-fakes.js'

const key = (p: Position): string =>
  `${String(Math.floor(p.x))},${String(Math.floor(p.y))},${String(Math.floor(p.z))}`

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const

/**
 * A construction world (dirt up to y 63, air above) with water and lava in it, that also fills buckets: the bot needs an
 * empty bucket and must be within reach, and a water source with two water sources beside it is made again, like the game.
 */
export class BucketWorld extends ConstructionWorld implements LiquidReader, BucketFiller {
  private readonly levels = new Map<string, number>()
  /** The blocks taken into a bucket, in order. */
  readonly taken: Position[] = []
  /** The bot's position at each take. */
  readonly takenFrom: Position[] = []
  /** Failures for the next fills, in order. */
  fillFailures: (BucketFailure | undefined)[] = []
  /** Called after each successful take, so a test can react (let lava flow, abort). */
  afterTake: (source: Position) => void = () => undefined

  constructor() {
    super()
    this.give('bucket', 1)
  }

  /** A rectangle of source blocks at height `y` (both corners included). */
  pool(liquid: Liquid, from: Position, to: Position): void {
    for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x += 1)
      for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z += 1)
        this.setBlock({ x, y: from.y, z }, liquid)
  }

  /** A cell of flowing liquid (level 1 to 7 flowing, 8 and up falling). */
  flowing(liquid: Liquid, at: Position, level = 1): void {
    this.setBlock(at, liquid)
    this.levels.set(key(at), level)
  }

  override setBlock(at: Position, name: string): void {
    super.setBlock(at, name)
    this.levels.delete(key(at))
  }

  liquidAt(position: Position): LiquidState | undefined {
    const name = this.blockAt(position)
    if (name !== 'water' && name !== 'lava') return undefined
    return { liquid: name, source: (this.levels.get(key(position)) ?? 0) === 0 }
  }

  override findBlocks(query: BlockQuery): readonly BlockInfo[] {
    const found: BlockInfo[] = []
    for (const [cell, name] of this.cells) {
      if (!query.names.includes(name)) continue
      const [x, y, z] = cell.split(',').map(Number) as [number, number, number]
      const distance = distanceBetween(this.bot, { x: x + 0.5, y, z: z + 0.5 })
      if (distance <= query.maxDistance) found.push({ name, position: { x, y, z }, distance })
    }
    return found.sort((a, b) => a.distance - b.distance).slice(0, query.count)
  }

  fill(source: Position, signal: AbortSignal): Promise<Result<FilledBucket, BucketFailure>> {
    if (signal.aborted) return Promise.resolve(err({ reason: 'failed', message: 'Cancelled.' }))
    const failure = this.fillFailures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    if ((this.carried.get('bucket') ?? 0) === 0)
      return Promise.resolve(err({ reason: 'no_bucket', message: 'No empty bucket.' }))
    const state = this.liquidAt(source)
    if (state === undefined || !state.source)
      return Promise.resolve(err({ reason: 'not_a_source', message: 'Not a source block.' }))
    const away = Math.hypot(
      this.bot.x - (source.x + 0.5),
      this.bot.y + EYE_HEIGHT - (source.y + 0.5),
      this.bot.z - (source.z + 0.5),
    )
    if (away > REACH)
      return Promise.resolve(err({ reason: 'out_of_reach', message: 'Too far away.' }))

    const remade =
      state.liquid === 'water' &&
      SIDES.filter(([dx, dz]) => {
        const beside = this.liquidAt({ x: source.x + dx, y: source.y, z: source.z + dz })
        return beside?.liquid === 'water' && beside.source
      }).length >= 2
    if (!remade) this.setBlock(source, 'air')
    this.carried.set('bucket', (this.carried.get('bucket') ?? 0) - 1)
    const item = `${state.liquid}_bucket`
    this.give(item, 1)
    this.taken.push(source)
    this.takenFrom.push(this.bot)
    this.afterTake(source)
    return Promise.resolve(ok({ item }))
  }
}
