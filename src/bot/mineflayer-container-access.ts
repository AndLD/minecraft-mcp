import type {
  ContainerAccess,
  ContainerContents,
  ContainerSession,
} from '../core/container.port.js'
import type { ItemFacts } from '../core/item-facts.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'
import { toVec3 } from './vec3.js'
import { WindowTransfer } from './window-transfer.js'

const CONTAINER_BLOCK = /^(chest|trapped_chest|barrel)$|shulker_box$/

class MineflayerContainerSession implements ContainerSession {
  constructor(private readonly transfer: WindowTransfer) {}

  contents(): ContainerContents {
    return this.transfer.contents()
  }

  deposit(item: string, count: number | undefined): Promise<number> {
    return this.transfer.deposit(item, count)
  }

  withdraw(item: string, count: number | undefined): Promise<number> {
    return this.transfer.withdraw(item, count)
  }

  close(): Promise<void> {
    return this.transfer.close()
  }
}

export class MineflayerContainerAccess implements ContainerAccess {
  constructor(
    private readonly holder: BotHolder,
    private readonly facts: ItemFacts,
  ) {}

  async open(position: Position): Promise<Result<ContainerSession>> {
    const bot = this.holder.current()
    if (bot === undefined) return err('Not connected to a Minecraft world.')
    const block = bot.blockAt(toVec3(position))
    if (block === null || !CONTAINER_BLOCK.test(block.name))
      return err('There is no chest, barrel, or shulker box there.')
    try {
      const window = await bot.openContainerWindow(block)
      const transfer = new WindowTransfer(window, (item) => this.facts.stackSize(item))
      await window.sync() // the picture of the contents must be the server's
      return ok(new MineflayerContainerSession(transfer))
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error))
    }
  }
}
