import type { ContainerContents } from '../core/container.port.js'
import type { ItemLike } from './bot-like.types.js'

/** An opened container window: the container's own slots come first, then the player's. */
export interface ContainerWindowLike {
  readonly slots: readonly (ItemLike | null)[]
  /** The stack on the mouse cursor. */
  readonly selectedItem: ItemLike | null
  /** The container has slots `[0, inventoryStart)`; the player's own slots are `[inventoryStart, inventoryEnd)`. */
  readonly inventoryStart: number
  readonly inventoryEnd: number
  click(slot: number, mouseButton: number, mode: number): Promise<void>
  /** Waits a few game ticks, so the server's answer to the last click arrives before the next one is sent. */
  settle(): Promise<void>
  /** Asks the server for the window's true state and adopts it. */
  sync(): Promise<void>
  close(): Promise<void>
}

interface Range {
  readonly start: number
  readonly end: number
}

const MAX_STACKS = 64
/** How often to look before believing that a shift-click moved nothing. */
const LOOKS = 4

/**
 * Moves items in and out of a container by clicking, the way a player does, and lets the server decide what fits.
 * A shift-click moves a whole stack (the server merges it into existing stacks and fills empty slots); a part of a
 * stack is moved with single right-clicks. After every step the window is synced with the server, because since 1.17
 * the server silently ignores a click sent from an outdated picture of the window (see `WindowCrafter`).
 */
export class WindowTransfer {
  constructor(
    private readonly window: ContainerWindowLike,
    private readonly stackSize: (item: string) => number,
  ) {}

  contents(): ContainerContents {
    const stacks = []
    for (let slot = 0; slot < this.window.inventoryStart; slot += 1) {
      const item = this.window.slots[slot]
      if (item !== null && item !== undefined) stacks.push({ name: item.name, count: item.count })
    }
    return {
      stacks,
      totalSlots: this.window.inventoryStart,
      emptySlots: this.window.inventoryStart - stacks.length,
    }
  }

  deposit(item: string, count: number | undefined): Promise<number> {
    return this.move(item, count, this.inventoryRange(), this.containerRange())
  }

  withdraw(item: string, count: number | undefined): Promise<number> {
    return this.move(item, count, this.containerRange(), this.inventoryRange())
  }

  close(): Promise<void> {
    return this.window.close()
  }

  private containerRange(): Range {
    return { start: 0, end: this.window.inventoryStart }
  }

  private inventoryRange(): Range {
    return { start: this.window.inventoryStart, end: this.window.inventoryEnd }
  }

  private async move(
    item: string,
    count: number | undefined,
    from: Range,
    to: Range,
  ): Promise<number> {
    await this.window.sync()
    const before = this.countIn(item, from)
    const wanted = Math.min(count ?? before, before)

    for (let round = 0; round < MAX_STACKS; round += 1) {
      const movedSoFar = before - this.countIn(item, from)
      const remaining = wanted - movedSoFar
      if (remaining <= 0) break
      const source = this.findSlot(item, from)
      if (source === undefined) break
      const stack = this.window.slots[source]?.count ?? 0

      if (remaining >= stack) {
        await this.window.click(source, 0, 1) // shift-click: the server moves the whole stack
        if (await this.stillThere(source, stack)) break // the other side is full
      } else {
        await this.movePart(source, remaining, to)
        break
      }
    }
    return before - this.countIn(item, from)
  }

  /**
   * Syncs until the stack has gone down. The server's answer can be a moment late, and a sync can be answered by an
   * older update, so an unchanged slot is only believed after a few more looks.
   */
  private async stillThere(slot: number, before: number): Promise<boolean> {
    for (let look = 0; look < LOOKS; look += 1) {
      await this.window.settle()
      await this.window.sync()
      if ((this.window.slots[slot]?.count ?? 0) < before) return false
    }
    return true
  }

  /** Moves `amount` items out of the stack in `source` (which holds more) into a slot of the other range. */
  private async movePart(source: number, amount: number, to: Range): Promise<void> {
    const stack = this.window.slots[source]
    if (stack === null || stack === undefined) return
    const target = this.findTarget(stack.name, to)
    if (target === undefined) return
    const excess = stack.count - amount

    await this.window.click(source, 0, 0) // pick the stack up
    await this.window.settle()
    if (amount <= excess) {
      for (let i = 0; i < amount; i += 1) await this.single(target) // put the wanted items down one by one
      await this.window.click(source, 0, 0) // and the rest back where it was
    } else {
      for (let i = 0; i < excess; i += 1) await this.single(source) // put the excess back one by one
      await this.window.click(target, 0, 0) // and the wanted items down in one go
    }
    await this.window.settle()
    await this.window.sync()
  }

  private async single(slot: number): Promise<void> {
    await this.window.click(slot, 1, 0)
    await this.window.settle()
  }

  private findSlot(item: string, range: Range): number | undefined {
    for (let slot = range.start; slot < range.end; slot += 1)
      if (this.window.slots[slot]?.name === item) return slot
    return undefined
  }

  /** A slot of the same item with room, else an empty one. */
  private findTarget(item: string, range: Range): number | undefined {
    const limit = this.stackSize(item)
    for (let slot = range.start; slot < range.end; slot += 1) {
      const there = this.window.slots[slot]
      if (there?.name === item && there.count < limit) return slot
    }
    for (let slot = range.start; slot < range.end; slot += 1)
      if ((this.window.slots[slot] ?? null) === null) return slot
    return undefined
  }

  private countIn(item: string, range: Range): number {
    let total = 0
    for (let slot = range.start; slot < range.end; slot += 1) {
      const there = this.window.slots[slot]
      if (there?.name === item) total += there.count
    }
    return total
  }
}
