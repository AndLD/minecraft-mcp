import type { Bot } from 'mineflayer'
import type { BlockLike, RecipeLike } from './bot-like.types.js'
import { WindowCrafter } from './window-crafter.js'

/** Waiting this many game ticks after a click gives the server time to answer it (50 ms per tick). */
const SETTLE_TICKS = 3

/**
 * Replaces `bot.craft` with the click-by-click `WindowCrafter` (see there for why). Must run after Mineflayer has
 * injected its own plugins, which happens as the bot joins: `bot.craft` is assigned then and would overwrite this.
 */
export function installWindowCrafter(bot: Bot): void {
  // Mineflayer keeps its window sync as an internal function.
  const internal = bot as unknown as { _syncWindow(window: unknown): Promise<void> }
  const craft = (recipe: RecipeLike, count: number, table?: BlockLike | null): Promise<void> =>
    new WindowCrafter({
      inventoryWindow: bot.inventory,
      itemName: (id) => bot.registry.items[id]?.name,
      openTable: () => {
        if (table === undefined || table === null)
          return Promise.reject(new Error('No crafting table was given.'))
        return bot.openBlock(table as unknown as Parameters<typeof bot.openBlock>[0])
      },
      // Our narrow window type is what the real `Window` looks like to the crafter.
      closeWindow: (window) =>
        bot.closeWindow(window as unknown as Parameters<typeof bot.closeWindow>[0]),
      click: (slot, mouseButton, mode) => bot.clickWindow(slot, mouseButton, mode),
      settle: () => bot.waitForTicks(SETTLE_TICKS),
      sync: (window) => internal._syncWindow(window),
    }).craft(recipe, count, table !== undefined && table !== null)

  Object.assign(bot, { craft })
}
