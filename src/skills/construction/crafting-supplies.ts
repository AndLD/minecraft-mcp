import type { SkillContext } from '../../core/skill.types.js'
import type { ItemCrafter } from '../crafting/craft-item-skill.js'

/** Makes things the work runs out of (torches, a spare pickaxe) from what the bot carries. */
export interface SupplyCrafter {
  /** True when at least one was made. */
  craft(item: string, count: number, context: SkillContext): Promise<boolean>
}

/** Crafting through the `craft` skill, which also makes the intermediate items and places a crafting table. */
export class CraftingSupplies implements SupplyCrafter {
  constructor(private readonly crafter: ItemCrafter) {}

  async craft(item: string, count: number, context: SkillContext): Promise<boolean> {
    context.progress(`Crafting ${String(count)} ${item}`)
    const result = await this.crafter.run({ item, count }, context)
    return result.ok && result.value.produced > 0
  }
}
