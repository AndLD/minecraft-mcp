import type { InventoryWriter } from '../core/inventory-writer.port.js'
import type { ContainerWindowLike } from './window-transfer.js'

/** Clicking outside the window puts the stack on the cursor on the ground. */
const OUTSIDE = -999
/** Click mode 4 throws items out: button 0 one item, button 1 the whole stack. */
const THROW_MODE = 4
const MAX_STACKS = 64
/** How often to look before believing that a throw changed nothing. */
const LOOKS = 4

/**
 * Throws items out of the inventory by clicking, the way a player does (Q and Ctrl+Q), and syncs with the server
 * after every step: Mineflayer's own `toss` predicts clicks, and since 1.17 the server silently ignores a click that
 * comes from an outdated picture of the window (see `WindowCrafter`).
 */
export class WindowDropper implements InventoryWriter {
  constructor(private readonly window: ContainerWindowLike) {}

  async toss(item: string, count: number): Promise<number> {
    await this.window.sync()
    const before = this.carried(item)
    const wanted = Math.min(count, before)

    for (let round = 0; round < MAX_STACKS; round += 1) {
      const remaining = wanted - (before - this.carried(item))
      if (remaining <= 0) break
      const slot = this.findSlot(item)
      if (slot === undefined) break
      const stack = this.window.slots[slot]?.count ?? 0

      if (remaining >= stack) {
        await this.window.click(slot, 1, THROW_MODE)
        if (await this.unchanged(slot, stack)) break
      } else {
        await this.tossPart(slot, stack, remaining)
        break
      }
    }
    return before - this.carried(item)
  }

  /** Throws `amount` out of a bigger stack: one by one, or by picking the stack up and putting the rest back. */
  private async tossPart(slot: number, stack: number, amount: number): Promise<void> {
    const keep = stack - amount
    if (amount <= keep) {
      for (let i = 0; i < amount; i += 1) {
        await this.window.click(slot, 0, THROW_MODE)
        await this.window.settle()
      }
    } else {
      await this.window.click(slot, 0, 0) // pick the stack up
      await this.window.settle()
      for (let i = 0; i < keep; i += 1) {
        await this.window.click(slot, 1, 0) // put the part to keep back, one by one
        await this.window.settle()
      }
      await this.window.click(OUTSIDE, 0, 0) // and throw what is left on the cursor
      await this.window.settle()
    }
    await this.window.sync()
  }

  /** Syncs until the stack has gone down; an unchanged slot is only believed after a few looks. */
  private async unchanged(slot: number, before: number): Promise<boolean> {
    for (let look = 0; look < LOOKS; look += 1) {
      await this.window.settle()
      await this.window.sync()
      if ((this.window.slots[slot]?.count ?? 0) < before) return false
    }
    return true
  }

  private findSlot(item: string): number | undefined {
    for (let slot = this.window.inventoryStart; slot < this.window.inventoryEnd; slot += 1)
      if (this.window.slots[slot]?.name === item) return slot
    return undefined
  }

  private carried(item: string): number {
    let total = 0
    for (let slot = this.window.inventoryStart; slot < this.window.inventoryEnd; slot += 1) {
      const there = this.window.slots[slot]
      if (there?.name === item) total += there.count
    }
    return total
  }
}
