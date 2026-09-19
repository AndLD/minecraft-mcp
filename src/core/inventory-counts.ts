import type { InventorySnapshot } from './inventory.port.js'
import type { ItemCount } from './recipes.port.js'

/** Total per item name across stacks. */
export function countItems(snapshot: InventorySnapshot | undefined): Map<string, number> {
  const totals = new Map<string, number>()
  for (const stack of snapshot?.stacks ?? [])
    totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count)
  return totals
}

/** What was gained between two inventories (losses are left out), biggest first. */
export function gained(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): ItemCount[] {
  const result: ItemCount[] = []
  for (const [name, count] of after) {
    const delta = count - (before.get(name) ?? 0)
    if (delta > 0) result.push({ name, count: delta })
  }
  return result.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** "3 oak_log, 2 stick" */
export function describeItems(items: readonly ItemCount[]): string {
  return items.length === 0
    ? 'nothing'
    : items.map((item) => `${String(item.count)} ${item.name}`).join(', ')
}
