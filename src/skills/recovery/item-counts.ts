import type { ItemCount } from '../../core/recipes.port.js'

/** Adds two lists of counts, merging equal names. */
export function mergeCounts(a: readonly ItemCount[], b: readonly ItemCount[]): ItemCount[] {
  const totals = new Map<string, number>()
  for (const item of [...a, ...b]) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
  return [...totals].map(([name, count]) => ({ name, count }))
}

/** What is left of `wanted` after taking `have` off it (never below zero, empty entries left out). */
export function subtractCounts(
  wanted: readonly ItemCount[],
  have: readonly ItemCount[],
): ItemCount[] {
  const owned = new Map(have.map((item) => [item.name, item.count]))
  const left: ItemCount[] = []
  for (const item of wanted) {
    const remaining = item.count - (owned.get(item.name) ?? 0)
    if (remaining > 0) left.push({ name: item.name, count: remaining })
  }
  return left
}

export const totalOf = (items: readonly ItemCount[]): number =>
  items.reduce((sum, item) => sum + item.count, 0)

/** "12 oak_log, 3 stick and 4 more kinds", short enough for a chat line. */
export function describeBrief(items: readonly ItemCount[], shown = 4): string {
  if (items.length === 0) return 'nothing'
  const sorted = [...items].sort((a, b) => b.count - a.count)
  const head = sorted.slice(0, shown).map((item) => `${String(item.count)} ${item.name}`)
  const more = sorted.length - head.length
  return more > 0 ? `${head.join(', ')} and ${String(more)} more kinds` : head.join(', ')
}
