import type { CampfireAccess, CampfireState } from '../core/campfire.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

const CAMPFIRES = new Set(['campfire', 'soul_campfire'])
/** How many ticks to wait, at most, for the inventory to show that the item went on. */
const CONFIRM_TICKS = 8

const carried = (bot: NonNullable<ReturnType<BotHolder['current']>>, item: string): number =>
  bot.inventory
    .items()
    .filter((stack) => stack.name === item)
    .reduce((sum, stack) => sum + stack.count, 0)

export class MineflayerCampfireAccess implements CampfireAccess {
  constructor(private readonly holder: BotHolder) {}

  stateAt(position: Position): CampfireState {
    const block = this.holder.current()?.blockAt(toVec3(position))
    if (block === null || block === undefined || !CAMPFIRES.has(block.name)) return 'none'
    return block.getProperties?.()['lit'] === false ? 'out' : 'lit'
  }

  async put(position: Position, item: string): Promise<Result<void>> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    const block = bot.blockAt(toVec3(position))
    if (block === null || !CAMPFIRES.has(block.name)) return err('There is no campfire there.')
    const id = bot.registry.itemsByName[item]?.id
    if (id === undefined) return err(`${item} is not an item.`)
    const before = carried(bot, item)
    try {
      await bot.equip(id, 'hand')
      // Face the block first: the server checks the click against where the bot looks.
      await bot.lookAt(
        toVec3({ x: position.x + 0.5, y: position.y + 0.4, z: position.z + 0.5 }),
        true,
      )
      await bot.activateBlock(block)
      for (let tick = 0; tick < CONFIRM_TICKS; tick += 1) {
        await bot.waitForTicks(1)
        if (carried(bot, item) < before) return ok(undefined)
      }
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
    return err('The campfire did not take the item: all four spots are probably taken.')
  }
}
