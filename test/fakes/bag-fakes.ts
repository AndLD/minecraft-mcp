import { FakeInventory } from './fake-ports.js'

/** An inventory whose contents a test (or a fake world) can change by name. */
export class Bag extends FakeInventory {
  constructor(items: Record<string, number> = {}) {
    super()
    this.value = {
      stacks: Object.entries(items).map(([name, count]) => ({ name, count })),
      emptySlots: 30,
      heldItem: undefined,
    }
  }

  count(name: string): number {
    return this.value?.stacks.find((stack) => stack.name === name)?.count ?? 0
  }

  give(name: string, by: number): void {
    const stacks = [...(this.value?.stacks ?? [])]
    const index = stacks.findIndex((stack) => stack.name === name)
    if (index >= 0) {
      const count = (stacks[index]?.count ?? 0) + by
      if (count > 0) stacks[index] = { name, count }
      else stacks.splice(index, 1)
    } else if (by > 0) stacks.push({ name, count: by })
    if (this.value !== undefined) this.value = { ...this.value, stacks }
  }
}
