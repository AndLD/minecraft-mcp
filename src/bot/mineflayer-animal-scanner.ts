import type { AnimalInfo, AnimalScanner } from '../core/animal-scanner.port.js'
import { distanceBetween } from '../core/position.js'
import type { BotHolder, BotLike, EntityLike } from './bot-like.types.js'

/** Mineflayer's coarse types for animals and other peaceful creatures. */
const ANIMAL_TYPES = new Set(['animal', 'passive'])

/** Reads a named metadata field, using the key list the game data has for the entity. */
function field(bot: BotLike, entity: EntityLike, key: string): unknown {
  const keys = bot.registry.entitiesByName[entity.name ?? '']?.metadataKeys
  const index = keys?.indexOf(key)
  return index === undefined || index < 0 ? undefined : entity.metadata?.[index]
}

const present = (value: unknown): boolean => value !== undefined && value !== null

function describe(bot: BotLike, entity: EntityLike, origin: BotLike['entity']): AnimalInfo {
  return {
    id: entity.id,
    species: entity.name ?? entity.type,
    position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
    distance: origin === undefined ? 0 : distanceBetween(origin.position, entity.position),
    baby: field(bot, entity, 'baby') === true,
    named: present(field(bot, entity, 'custom_name')),
    owned: present(field(bot, entity, 'owneruuid')),
    saddled: field(bot, entity, 'saddle') === true,
    ridden: (entity.passengers?.length ?? 0) > 0,
    dead: entity.isDead === true,
  }
}

export class MineflayerAnimalScanner implements AnimalScanner {
  constructor(private readonly holder: BotHolder) {}

  nearby(maxDistance: number): readonly AnimalInfo[] {
    const bot = this.holder.current()
    if (bot?.entity === undefined) return []
    const found: AnimalInfo[] = []
    for (const entity of Object.values(bot.entities)) {
      if (!ANIMAL_TYPES.has(entity.type) || entity.isDead === true || entity.isValid === false)
        continue
      const animal = describe(bot, entity, bot.entity)
      if (animal.distance <= maxDistance) found.push(animal)
    }
    return found.sort((a, b) => a.distance - b.distance)
  }

  find(id: number): AnimalInfo | undefined {
    const bot = this.holder.current()
    const entity = bot?.entities[String(id)]
    if (bot === undefined || entity === undefined || entity.isValid === false) return undefined
    return describe(bot, entity, bot.entity)
  }
}
