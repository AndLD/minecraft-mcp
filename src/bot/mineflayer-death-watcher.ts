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

  constructor(private readonly holder: BotHolder) {
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

    // The server may already have emptied the inventory when the death is announced, so the last look from
    // before the fatal hit is kept too, and the fuller of the two counts.
    let lastAlive = countSlots(bot.inventory.slots)
    let dying: Dying | undefined
    const onHealth = (): void => {
      if (bot.health > 0 && dying === undefined) lastAlive = countSlots(bot.inventory.slots)
    }
    const onDeath = (): void => {
      const position = bot.entity?.position
      if (position === undefined) return
      const now = countSlots(bot.inventory.slots)
      dying = {
        position: { x: position.x, y: position.y, z: position.z },
        dimension: bot.game.dimension,
        carried: total(now) >= total(lastAlive) ? now : lastAlive,
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

    bot.on('health', onHealth)
    bot.on('death', onDeath)
    bot.on('messagestr', onMessage)
    bot.on('respawn', onRespawn)
    this.detach = () => {
      bot.removeListener('health', onHealth)
      bot.removeListener('death', onDeath)
      bot.removeListener('messagestr', onMessage)
      bot.removeListener('respawn', onRespawn)
    }
  }
}
