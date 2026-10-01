import type { EquipSlot, ItemLike } from './bot-like.types.js'

const MATERIAL_TIERS: Readonly<Record<string, number>> = {
  wooden: 1,
  leather: 1,
  golden: 2,
  stone: 2,
  chainmail: 3,
  iron: 4,
  diamond: 5,
  netherite: 6,
}

const materialTier = (name: string): number => MATERIAL_TIERS[name.split('_')[0] ?? ''] ?? 0

/** Swords beat axes; within a kind, the better material wins. Everything else is not a weapon. */
export function weaponScore(name: string | undefined): number {
  if (name === undefined) return 0
  if (name.endsWith('_sword')) return 100 + materialTier(name)
  if (name.endsWith('_axe')) return 50 + materialTier(name)
  return 0
}

/** The best weapon in the inventory, if it is better than what is in hand. */
export function chooseWeapon(
  items: readonly ItemLike[],
  heldName: string | undefined,
): string | undefined {
  const best = [...items].sort((a, b) => weaponScore(b.name) - weaponScore(a.name))[0]
  return best !== undefined && weaponScore(best.name) > weaponScore(heldName)
    ? best.name
    : undefined
}

export const ARMOR_SLOTS: readonly {
  readonly suffix: string
  readonly slot: EquipSlot
  readonly index: number
}[] = [
  { suffix: '_helmet', slot: 'head', index: 5 },
  { suffix: '_chestplate', slot: 'torso', index: 6 },
  { suffix: '_leggings', slot: 'legs', index: 7 },
  { suffix: '_boots', slot: 'feet', index: 8 },
]

export interface ArmorChoice {
  readonly item: string
  readonly slot: EquipSlot
}

/** For each armor slot, the best piece in the inventory that beats what is worn there. */
export function chooseArmor(
  items: readonly ItemLike[],
  slots: readonly (ItemLike | null)[],
): ArmorChoice[] {
  const choices: ArmorChoice[] = []
  for (const { suffix, slot, index } of ARMOR_SLOTS) {
    const worn = slots[index]
    const wornTier = worn === null || worn === undefined ? -1 : materialTier(worn.name)
    const best = items
      .filter((item) => item.name.endsWith(suffix))
      .sort((a, b) => materialTier(b.name) - materialTier(a.name))[0]
    if (best !== undefined && materialTier(best.name) > wornTier)
      choices.push({ item: best.name, slot })
  }
  return choices
}

/** How long to wait between swings for a full-strength hit (the 1.9+ attack cooldown). */
export function attackIntervalMs(weapon: string | undefined): number {
  if (weapon === undefined) return 250
  if (weapon.endsWith('_sword')) return 625
  if (weapon.endsWith('_axe')) return 1250
  if (weapon.endsWith('_pickaxe')) return 833
  if (weapon === 'trident') return 909
  return 500
}
