import type {
  AnimalInteraction,
  AnimalInteractionFailure,
} from '../core/animal-interaction.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { BotHolder } from './bot-like.types.js'

export class MineflayerAnimalInteraction implements AnimalInteraction {
  constructor(private readonly holder: BotHolder) {}

  async hold(item: string): Promise<Result<void, AnimalInteractionFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const id = bot.registry.itemsByName[item]?.id
    if (id === undefined || !bot.inventory.items().some((held) => held.name === item))
      return err({ reason: 'no_item', message: `The bot has no ${item} to hold.` })
    try {
      await bot.equip(id, 'hand')
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return ok(undefined)
  }

  use(entityId: number): Promise<Result<void, AnimalInteractionFailure>> {
    return this.feed(entityId)
  }

  async feed(entityId: number): Promise<Result<void, AnimalInteractionFailure>> {
    const bot = this.holder.current()
    if (bot === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    const entity = bot.entities[String(entityId)]
    if (entity === undefined)
      return err({ reason: 'not_found', message: `Entity ${String(entityId)} is not in view.` })
    try {
      await bot.activateEntity(entity)
    } catch (error) {
      return err({
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return ok(undefined)
  }
}
