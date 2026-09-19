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
  /** What the server holds. */
  private truth: (ItemLike | null)[]
  /** What the client still believes while the server's answer is late. */
  private view: (ItemLike | null)[] | undefined
  /** The next click's effect only reaches the client after this many more syncs. */
  lateSyncs = 0
  private lateUntil = 0
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
    this.truth = [...container, ...player]
  }

  get slots(): (ItemLike | null)[] {
    return this.view ?? this.truth
  }

  click(slot: number, mouseButton: number, mode: number): Promise<void> {
    this.log.push(`click ${String(slot)} b${String(mouseButton)} m${String(mode)}`)
    if (this.ignoreClicks > 0) {
      this.ignoreClicks -= 1
      return Promise.resolve()
    }
    const before = this.truth.map((item) => (item === null ? null : { ...item }))
    if (mode === 1) this.shiftClick(slot)
    else if (mouseButton === 0) this.leftClick(slot)
    else this.rightClick(slot)
    if (this.lateSyncs > 0) {
      this.view = before // the client has not heard yet
      this.lateUntil = this.lateSyncs
      this.lateSyncs = 0
    }
    this.publish()
    return Promise.resolve()
  }

  settle(): Promise<void> {
    return Promise.resolve()
  }

  sync(): Promise<void> {
    this.log.push('sync')
    if (this.view !== undefined) {
      if (this.lateUntil > 0) this.lateUntil -= 1
      else this.view = undefined
    }
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.closed = true
    this.publish()
    return Promise.resolve()
  }

  private leftClick(slot: number): void {
    const inSlot = this.truth[slot] ?? null
    const held = this.selectedItem
    if (held === null) {
      this.selectedItem = inSlot
      this.truth[slot] = null
    } else if (inSlot === null) {
      this.truth[slot] = held
      this.selectedItem = null
    } else if (inSlot.name === held.name) {
      const room = stackSizeOf(held.name) - inSlot.count
      const put = Math.min(room, held.count)
      this.truth[slot] = { name: held.name, count: inSlot.count + put }
      this.selectedItem = held.count > put ? { name: held.name, count: held.count - put } : null
    } else {
      this.truth[slot] = held
      this.selectedItem = inSlot
    }
  }

  private rightClick(slot: number): void {
    const held = this.selectedItem
    if (held === null) return
    const inSlot = this.truth[slot] ?? null
    if (inSlot !== null && (inSlot.name !== held.name || inSlot.count >= stackSizeOf(held.name)))
      return
    this.truth[slot] = { name: held.name, count: (inSlot?.count ?? 0) + 1 }
    this.selectedItem = held.count > 1 ? { name: held.name, count: held.count - 1 } : null
  }

  private shiftClick(slot: number): void {
    const stack = this.truth[slot]
    if (stack === null || stack === undefined) return
    const [start, end] =
      slot < this.inventoryStart
        ? [this.inventoryStart, this.inventoryEnd]
        : [0, this.inventoryStart]
    let left = stack.count
    for (let target = start; target < end && left > 0; target += 1) {
      const there = this.truth[target]
      if (there?.name !== stack.name || there.count >= stackSizeOf(stack.name)) continue
      const put = Math.min(left, stackSizeOf(stack.name) - there.count)
      this.truth[target] = { name: stack.name, count: there.count + put }
      left -= put
    }
    for (let target = start; target < end && left > 0; target += 1) {
      if (this.truth[target] !== null) continue
      const put = Math.min(left, stackSizeOf(stack.name))
      this.truth[target] = { name: stack.name, count: put }
      left -= put
    }
    this.truth[slot] = left > 0 ? { name: stack.name, count: left } : null
  }

  /** Writes the state back to the owner, so it is visible outside the window at every moment. */
  private publish(): void {
    const container = this.truth.slice(0, this.inventoryStart)
    const totals = new Map<string, number>()
    for (const item of this.truth.slice(this.inventoryStart)) {
      if (item !== null) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count)
    }
    this.commit(
      container,
      [...totals].map(([name, count]) => ({ name, count })),
    )
  }
}
