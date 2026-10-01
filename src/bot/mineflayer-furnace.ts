import type { FurnaceAccess, FurnaceContents, FurnaceSession } from '../core/furnace.port.js'
import type { ItemStackInfo } from '../core/inventory.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder, BotLike, FurnaceLike, ItemLike } from './bot-like.types.js'
import { toVec3 } from './vec3.js'

const stack = (item: ItemLike | null): ItemStackInfo | undefined =>
  item === null ? undefined : { name: item.name, count: item.count }

class MineflayerFurnaceSession implements FurnaceSession {
  constructor(
    private readonly bot: BotLike,
    private readonly furnace: FurnaceLike,
  ) {}

  contents(): FurnaceContents {
    return {
      input: stack(this.furnace.inputItem()),
      fuel: stack(this.furnace.fuelItem()),
      output: stack(this.furnace.outputItem()),
      burning: this.furnace.fuel > 0,
    }
  }

  async putInput(item: string, count: number): Promise<void> {
    await this.furnace.putInput(this.itemId(item), null, count)
  }

  async putFuel(item: string, count: number): Promise<void> {
    await this.furnace.putFuel(this.itemId(item), null, count)
  }

  async takeInput(): Promise<ItemStackInfo | undefined> {
    return this.furnace.inputItem() === null ? undefined : stack(await this.furnace.takeInput())
  }

  async takeFuel(): Promise<ItemStackInfo | undefined> {
    return this.furnace.fuelItem() === null ? undefined : stack(await this.furnace.takeFuel())
  }

  async takeOutput(): Promise<ItemStackInfo | undefined> {
    return this.furnace.outputItem() === null ? undefined : stack(await this.furnace.takeOutput())
  }

  async close(): Promise<void> {
    await this.furnace.close()
  }

  private itemId(name: string): number {
    const id = this.bot.registry.itemsByName[name]?.id
    if (id === undefined) throw new Error(`${name} is not an item.`)
    return id
  }
}

const SMELTING_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker'])

export class MineflayerFurnaceAccess implements FurnaceAccess {
  constructor(private readonly holder: BotHolder) {}

  async open(position: Position): Promise<Result<FurnaceSession>> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    const block = bot.blockAt(toVec3(position))
    if (block === null || !SMELTING_BLOCKS.has(block.name))
      return err('There is no furnace, blast furnace, or smoker there.')
    try {
      return ok(new MineflayerFurnaceSession(bot, await bot.openFurnace(block)))
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
  }
}
