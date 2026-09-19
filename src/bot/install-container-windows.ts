import type { Bot } from 'mineflayer'
import type { BlockLike } from './bot-like.types.js'
import type { ContainerWindowLike } from './window-transfer.js'

/** Waiting this many game ticks after a click gives the server time to answer it (50 ms per tick). */
const SETTLE_TICKS = 3

/**
 * Gives the bot `openContainerWindow`: opens a chest, barrel, or shulker box and returns the window with the raw
 * click, wait, and sync operations `WindowTransfer` needs. Mineflayer's own `deposit` and `withdraw` predict clicks on
 * the client and are unreliable on 1.21 (see `WindowCrafter`), so they are not used.
 */
export function installContainerWindows(bot: Bot): void {
  const internal = bot as unknown as { _syncWindow(window: unknown): Promise<void> }

  const openContainerWindow = async (block: BlockLike): Promise<ContainerWindowLike> => {
    const window = await bot.openContainer(
      block as unknown as Parameters<typeof bot.openContainer>[0],
    )
    return {
      get slots() {
        return window.slots
      },
      get selectedItem() {
        return window.selectedItem
      },
      inventoryStart: window.inventoryStart,
      inventoryEnd: window.inventoryEnd,
      click: (slot, mouseButton, mode) => bot.clickWindow(slot, mouseButton, mode),
      settle: () => bot.waitForTicks(SETTLE_TICKS),
      sync: () => internal._syncWindow(window),
      close: () => window.close(),
    }
  }
  Object.assign(bot, { openContainerWindow })
}
