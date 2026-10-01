import type { GearReport } from '../core/combatant.port.js'
import type { Position } from '../core/position.types.js'
import { chooseArmor, chooseWeapon } from './gear.js'
import type { BotHolder } from './bot-like.types.js'
import type { PathDriver, PathHandle } from './path-driver.js'

/** The window slot of the off hand. */
const OFF_HAND_SLOT = 45

/** What melee combat needs from the game, replaceable in tests. */
export interface CombatDriver {
  /** Where the entity is, or undefined once it is gone. */
  target(entityId: number): { readonly position: Position } | undefined
  selfPosition(): Position | undefined
  approach(entityId: number, distance: number): PathHandle
  swing(entityId: number): void
  heldItem(): string | undefined
  equipBestGear(): Promise<GearReport>
}

export class MineflayerCombatDriver implements CombatDriver {
  constructor(
    private readonly holder: BotHolder,
    private readonly paths: PathDriver,
  ) {}

  target(entityId: number): { readonly position: Position } | undefined {
    const entity = this.holder.current()?.entities[String(entityId)]
    return entity === undefined || entity.isValid === false || entity.isDead === true
      ? undefined
      : entity
  }

  selfPosition(): Position | undefined {
    return this.holder.current()?.entity?.position
  }

  approach(entityId: number, distance: number): PathHandle {
    return this.paths.approachEntity(entityId, distance)
  }

  swing(entityId: number): void {
    const bot = this.holder.current()
    const entity = bot?.entities[String(entityId)]
    if (bot !== undefined && entity !== undefined) bot.attack(entity)
  }

  heldItem(): string | undefined {
    return this.holder.current()?.heldItem?.name
  }

  async equipBestGear(): Promise<GearReport> {
    const bot = this.holder.current()
    if (bot === undefined) return { weapon: undefined, armor: [] }
    const items = bot.inventory.items()

    const armor: string[] = []
    for (const { item, slot } of chooseArmor(items, bot.inventory.slots)) {
      const id = bot.registry.itemsByName[item]?.id
      if (id === undefined) continue
      try {
        await bot.equip(id, slot)
        armor.push(item)
      } catch {
        // A piece that cannot be put on is skipped; fighting goes on without it.
      }
    }

    let weapon = bot.heldItem?.name
    const better = chooseWeapon(items, weapon)
    const id = better === undefined ? undefined : bot.registry.itemsByName[better]?.id
    if (better !== undefined && id !== undefined) {
      try {
        await bot.equip(id, 'hand')
        weapon = better
      } catch {
        // Keep whatever is in hand.
      }
    }

    // A shield goes in the off hand; without one there, the first shield carried is put on.
    const shield = items.find((item) => item.name === 'shield')
    const shieldId = bot.registry.itemsByName['shield']?.id
    if (shield !== undefined && shieldId !== undefined && !bot.inventory.slots[OFF_HAND_SLOT]) {
      try {
        await bot.equip(shieldId, 'off-hand')
        armor.push('shield')
      } catch {
        // No shield then.
      }
    }
    return { weapon, armor }
  }
}
