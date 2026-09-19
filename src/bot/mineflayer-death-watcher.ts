import type { Clock } from '../core/clock.port.js'
import type { Unsubscribe } from '../core/connection.port.js'
import type { DeathEvent, DeathWatcher } from '../core/death-watcher.port.js'
import type { ItemCount } from '../core/recipes.port.js'
import type { BotHolder, BotLike, ItemLike } from './bot-like.types.js'

/** Totals per name over every slot (inventory, hotbar, armor, off hand, crafting grid). */
export function countSlots(slots: readonly (ItemLike | null)[]): ItemCount[] {
  const totals = new Map<string, number>()
  for (const item of slots) {
    if (!item) continue // Mineflayer leaves holes as well as nulls in the slot array
    totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  }
  return [...totals].map(([name, count]) => ({ name, count }))
}

const total = (items: readonly ItemCount[]): number =>
  items.reduce((sum, item) => sum + item.count, 0)

/** Looks this far back from the death for the fullest inventory: the server may empty it before announcing the death. */
const LOOK_BACK_MS = 2_000
/** Older looks are not needed any more (one is kept from before the window, see `fullest`). */
const HISTORY_MS = 10_000

interface Look {
  readonly at: number
  readonly carried: readonly ItemCount[]
}

interface Dying {
  readonly position: DeathEvent['position']
  readonly dimension: string
  readonly carried: readonly ItemCount[]
  readonly messages: string[]
}

/**
 * Reports deaths of whichever bot is current. Mineflayer respawns the bot by itself, so the death is reported at the
 * respawn: by then the server's death message has arrived, and the inventory has been reset.
 */
export class MineflayerDeathWatcher implements DeathWatcher {
  private readonly listeners = new Set<(event: DeathEvent) => void>()
  private detach: (() => void) | undefined

  constructor(
    private readonly holder: BotHolder,
    private readonly clock: Clock,
  ) {
    holder.onChange((bot) => {
      this.attach(bot)
    })
    this.attach(holder.current())
  }

  carried(): readonly ItemCount[] {
    return countSlots(this.holder.current()?.inventory.slots ?? [])
  }

  onDeath(listener: (event: DeathEvent) => void): Unsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private attach(bot: BotLike | undefined): void {
    this.detach?.()
    this.detach = undefined
    if (bot === undefined) return

    // The server empties the inventory before it announces the death, so the inventory at the death event is
    // already bare. Every change of a slot is remembered for a while, and the fullest recent look counts.
    const history: Look[] = [{ at: this.clock.now(), carried: countSlots(bot.inventory.slots) }]
    let dying: Dying | undefined
    const remember = (): void => {
      if (dying !== undefined) return
      const now = this.clock.now()
      history.push({ at: now, carried: countSlots(bot.inventory.slots) })
      // Keep one look older than the limit: it is what the inventory held when the newer ones began.
      while (history.length > 1 && now - (history[1]?.at ?? now) > HISTORY_MS) history.shift()
    }
    const fullest = (deathAt: number): readonly ItemCount[] => {
      const inWindow = history.filter((look) => deathAt - look.at <= LOOK_BACK_MS)
      // The look just before the window is what the inventory held when the window began.
      const before = history.filter((look) => deathAt - look.at > LOOK_BACK_MS).at(-1)
      const candidates = [...(before === undefined ? [] : [before]), ...inWindow]
      const now = countSlots(bot.inventory.slots)
      return [...candidates.map((look) => look.carried), now].reduce((best, current) =>
        total(current) > total(best) ? current : best,
      )
    }
    const onDeath = (): void => {
      const position = bot.entity?.position
      if (position === undefined) return
      dying = {
        position: { x: position.x, y: position.y, z: position.z },
        dimension: bot.game.dimension,
        carried: fullest(this.clock.now()),
        messages: [],
      }
    }
    const onMessage = (message: string): void => {
      if (dying !== undefined && message.includes(bot.username)) dying.messages.push(message)
    }
    const onRespawn = (): void => {
      if (dying === undefined) return
      const { position, dimension, carried, messages } = dying
      dying = undefined
      for (const listener of this.listeners)
        listener({ position, dimension, carried, cause: messages[0] })
    }

    bot.inventory.on('updateSlot', remember)
    bot.on('death', onDeath)
    bot.on('messagestr', onMessage)
    bot.on('respawn', onRespawn)
    this.detach = () => {
      bot.inventory.removeListener('updateSlot', remember)
      bot.removeListener('death', onDeath)
      bot.removeListener('messagestr', onMessage)
      bot.removeListener('respawn', onRespawn)
    }
  }
}
