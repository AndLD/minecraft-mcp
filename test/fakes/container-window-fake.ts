import type { ItemLike } from '../../src/bot/bot-like.types.js'
import type { ContainerWindowLike } from '../../src/bot/window-transfer.js'

const STACK = 64
export const PLAYER_SLOTS = 36

export const stackSizeOf = (name: string): number =>
  ['ender_pearl', 'snowball', 'egg', 'bucket'].includes(name) ? 16 : STACK

/**
 * A chest window as the server keeps it, close enough to check the order of clicks: left click picks up, puts down,
 * merges, or swaps a stack; right click puts one item down; shift-click moves a whole stack to the other side
 * (merging first, then into empty slots) and leaves what does not fit. The player's side is built from, and written
 * back to, the owner of the window (the fake bot's inventory).
 */
export class FakeContainerWindow implements ContainerWindowLike {
  slots: (ItemLike | null)[]
  selectedItem: ItemLike | null = null
  readonly inventoryStart: number
  readonly inventoryEnd: number
  readonly log: string[] = []
  closed = false
  /** Clicks to swallow, like a server that considers them stale. */
  ignoreClicks = 0

  constructor(
    private readonly container: (ItemLike | null)[],
    playerStacks: readonly ItemLike[],
    private readonly commit: (container: (ItemLike | null)[], player: ItemLike[]) => void,
  ) {
    this.inventoryStart = container.length
    this.inventoryEnd = container.length + PLAYER_SLOTS
    const player: (ItemLike | null)[] = Array.from({ length: PLAYER_SLOTS }, () => null)
    let slot = 0
    for (const stack of playerStacks) {
      let left = stack.count
      while (left > 0 && slot < PLAYER_SLOTS) {
        const put = Math.min(left, stackSizeOf(stack.name))
        player[slot] = { name: stack.name, count: put }
        left -= put
        slot += 1
      }
    }
    this.slots = [...container, ...player]
  }

  click(slot: number, mouseButton: number, mode: number): Promise<void> {
    this.log.push(`click ${String(slot)} b${String(mouseButton)} m${String(mode)}`)
    if (this.ignoreClicks > 0) {
      this.ignoreClicks -= 1
      return Promise.resolve()
    }
    if (mode === 1) this.shiftClick(slot)
    else if (mouseButton === 0) this.leftClick(slot)
    else this.rightClick(slot)
    this.publish()
    return Promise.resolve()
  }

  settle(): Promise<void> {
    return Promise.resolve()
  }

  sync(): Promise<void> {
    this.log.push('sync')
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.publish()
    return Promise.resolve()
  }

  private leftClick(slot: number): void {
    const inSlot = this.slots[slot] ?? null
    const held = this.selectedItem
    if (held === null) {
      this.selectedItem = inSlot
      this.slots[slot] = null
    } else if (inSlot === null) {
      this.slots[slot] = held
      this.selectedItem = null
    } else if (inSlot.name === held.name) {
      const room = stackSizeOf(held.name) - inSlot.count
      const put = Math.min(room, held.count)
      this.slots[slot] = { name: held.name, count: inSlot.count + put }
      this.selectedItem = held.count > put ? { name: held.name, count: held.count - put } : null
    } else {
      this.slots[slot] = held
      this.selectedItem = inSlot
    }
  }

  private rightClick(slot: number): void {
    const held = this.selectedItem
    if (held === null) return
    const inSlot = this.slots[slot] ?? null
    if (inSlot !== null && (inSlot.name !== held.name || inSlot.count >= stackSizeOf(held.name)))
      return
    this.slots[slot] = { name: held.name, count: (inSlot?.count ?? 0) + 1 }
    this.selectedItem = held.count > 1 ? { name: held.name, count: held.count - 1 } : null
  }

  private shiftClick(slot: number): void {
    const stack = this.slots[slot]
    if (stack === null || stack === undefined) return
    const [start, end] =
      slot < this.inventoryStart
        ? [this.inventoryStart, this.inventoryEnd]
        : [0, this.inventoryStart]
    let left = stack.count
    for (let target = start; target < end && left > 0; target += 1) {
      const there = this.slots[target]
      if (there?.name !== stack.name || there.count >= stackSizeOf(stack.name)) continue
      const put = Math.min(left, stackSizeOf(stack.name) - there.count)
      this.slots[target] = { name: stack.name, count: there.count + put }
      left -= put
    }
    for (let target = start; target < end && left > 0; target += 1) {
      if (this.slots[target] !== null) continue
      const put = Math.min(left, stackSizeOf(stack.name))
      this.slots[target] = { name: stack.name, count: put }
      left -= put
    }
    this.slots[slot] = left > 0 ? { name: stack.name, count: left } : null
  }

  /** Writes the state back to the owner, so it is visible outside the window at every moment. */
  private publish(): void {
    const container = this.slots.slice(0, this.inventoryStart)
    const totals = new Map<string, number>()
    for (const item of this.slots.slice(this.inventoryStart)) {
      if (item !== null) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
    }
    this.commit(
      container,
      [...totals].map(([name, count]) => ({ name, count })),
    )
  }
}
