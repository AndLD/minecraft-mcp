import type {
  BucketFailure,
  BucketFiller,
  FilledBucket,
  Liquid,
  LiquidReader,
  LiquidState,
} from '../core/bucket.port.js'
import type { Position } from '../core/position.types.js'
import { EYE_HEIGHT, REACH } from '../core/reach.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

/** Ticks (50 ms each) to wait for the server to hand over the filled bucket after the click. */
const CONFIRM_TICKS = 8

const fail = (reason: BucketFailure['reason'], message: string): Result<never, BucketFailure> =>
  err({ reason, message })

const describe = (position: Position): string =>
  `${String(position.x)}, ${String(position.y)}, ${String(position.z)}`

export class MineflayerBucketFiller implements BucketFiller, LiquidReader {
  constructor(private readonly holder: BotHolder) {}

  liquidAt(position: Position): LiquidState | undefined {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined) return undefined
    const liquid: Liquid | undefined =
      block.name === 'water' ? 'water' : block.name === 'lava' ? 'lava' : undefined
    if (liquid === undefined) return undefined
    const level = block.getProperties?.()['level']
    // The level arrives as a number or as a numeric string, like other blockstate values. Without it nothing proves the
    // cell is a source, so it is treated as flowing.
    return { liquid, source: level !== undefined && Number(level) === 0 }
  }

  async fill(source: Position, signal: AbortSignal): Promise<Result<FilledBucket, BucketFailure>> {
    const bot = this.holder.current()
    if (bot === undefined) return fail('not_connected', 'Not connected to a Minecraft world.')
    const bucket = bot.inventory.items().find((item) => item.name === 'bucket')
    if (bucket === undefined) return fail('no_bucket', 'The bot has no empty bucket.')
    const state = this.liquidAt(source)
    if (state === undefined)
      return fail('not_a_source', `There is no water or lava at ${describe(source)}.`)
    if (!state.source)
      return fail(
        'not_a_source',
        `The ${state.liquid} at ${describe(source)} is flowing, not a source block: a bucket takes nothing from it.`,
      )
    const feet = bot.entity?.position
    if (feet === undefined) return fail('not_connected', 'The bot has no position yet.')
    const centre = { x: source.x + 0.5, y: source.y + 0.5, z: source.z + 0.5 }
    const distance = Math.hypot(
      feet.x - centre.x,
      feet.y + EYE_HEIGHT - centre.y,
      feet.z - centre.z,
    )
    if (distance > REACH)
      return fail('out_of_reach', `${describe(source)} is ${distance.toFixed(1)} blocks away.`)

    const item = `${state.liquid}_bucket`
    const carried = (): number =>
      bot.inventory
        .items()
        .filter((stack) => stack.name === item)
        .reduce((total, stack) => total + stack.count, 0)
    const before = carried()
    try {
      const id = bot.registry.itemsByName['bucket']?.id
      if (id !== undefined) await bot.equip(id, 'hand')
      // A bucket is used, not placed: it takes the source block the bot looks straight at.
      await bot.lookAt(toVec3(centre), true)
      bot.activateItem()
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error))
    }
    for (let tick = 0; tick < CONFIRM_TICKS; tick += 1) {
      if (signal.aborted) return fail('failed', 'Cancelled.')
      await bot.waitForTicks(1)
      if (carried() > before) return ok({ item })
    }
    return fail(
      'failed',
      `The bucket did not fill at ${describe(source)}; something may be in the way.`,
    )
  }
}
