import type { ItemLike, RecipeLike } from '../../src/bot/bot-like.types.js'
import type { CraftWindow, CraftWindowBot } from '../../src/bot/window-crafter.js'

export const ITEM_IDS: Record<string, number> = {
  oak_log: 1,
  oak_planks: 2,
  stick: 3,
  crafting_table: 4,
  wooden_pickaxe: 5,
  coal: 6,
}
const NAMES = Object.fromEntries(Object.entries(ITEM_IDS).map(([name, id]) => [id, name]))

const STACK_LIMIT = 64

/** A window as the game keeps it: slot 0 is the result, then the grid, then armor (inventory only), then the player's slots. */
export class FakeWindow implements CraftWindow {
  slots: (ItemLike | null)[]
  selectedItem: ItemLike | null = null
  readonly inventoryStart: number
  readonly inventoryEnd: number

  constructor(readonly gridWidth: 2 | 3) {
    // Inventory window: result, 4 grid slots, 4 armor slots, then 36 player slots. Table window: result, 9 grid, 36.
    this.inventoryStart = gridWidth === 2 ? 9 : 10
    this.inventoryEnd = this.inventoryStart + 36
    this.slots = Array.from({ length: this.inventoryEnd }, () => null)
  }

  put(name: string, count: number): void {
    for (let slot = this.inventoryStart; slot < this.inventoryEnd; slot += 1) {
      const existing = this.slots[slot]
      if (existing?.name === name && existing.count < STACK_LIMIT) {
        this.slots[slot] = { name, count: existing.count + count }
        return
      }
    }
    for (let slot = this.inventoryStart; slot < this.inventoryEnd; slot += 1) {
      if (this.slots[slot] === null) {
        this.slots[slot] = { name, count }
        return
      }
    }
    throw new Error('the fake inventory is full')
  }

  count(name: string): number {
    return this.slots.reduce((sum, item) => sum + (item?.name === name ? item.count : 0), 0)
  }
}

/**
 * A server's view of one crafting recipe and the clicks that operate the window, close enough to the real thing to
 * check the order of clicks: picking up and placing stacks, a result that only appears after a `sync`, and a shift-click
 * that takes it. Anything else the test does is ignored by the real server too.
 */
export class FakeCraftServer implements CraftWindowBot {
  readonly inventoryWindow = new FakeWindow(2)
  readonly tableWindow = new FakeWindow(3)
  readonly log: string[] = []
  clicksIgnored = 0
  /** Set to make clicks fail. */
  failClicksWith: unknown

  constructor(private recipe: RecipeLike) {}

  private current: FakeWindow = this.inventoryWindow

  itemName(id: number): string | undefined {
    return NAMES[id]
  }

  openTable(): Promise<CraftWindow> {
    this.log.push('open table')
    this.current = this.tableWindow
    return Promise.resolve(this.tableWindow)
  }

  closeWindow(window: CraftWindow): Promise<void> {
    this.log.push('close table')
    const table = window as FakeWindow
    // The server hands back what is left in the grid.
    for (let slot = 1; slot <= table.gridWidth * table.gridWidth; slot += 1) {
      const item = table.slots[slot]
      if (item !== null && item !== undefined) table.put(item.name, item.count)
      table.slots[slot] = null
    }
    table.slots[0] = null
    this.current = this.inventoryWindow
    return Promise.resolve()
  }

  settle(): Promise<void> {
    this.log.push('settle')
    return Promise.resolve()
  }

  sync(window: CraftWindow): Promise<void> {
    this.log.push('sync')
    this.updateResult(window as FakeWindow)
    return Promise.resolve()
  }

  click(slot: number, mouseButton: number, mode: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the tests want to see a rejection that is not an Error
    if (this.failClicksWith !== undefined) return Promise.reject(this.failClicksWith)
    this.log.push(`click ${String(slot)} b${String(mouseButton)} m${String(mode)}`)
    const window = this.current
    if (mode === 1 && slot === 0) this.takeResult(window)
    else if (slot === -999) window.selectedItem = null
    else if (mouseButton === 0) this.leftClick(window, slot)
    else this.rightClick(window, slot)
    return Promise.resolve()
  }

  private leftClick(window: FakeWindow, slot: number): void {
    const inSlot = window.slots[slot] ?? null
    const held = window.selectedItem
    if (held === null) {
      window.selectedItem = inSlot
      window.slots[slot] = null
    } else if (inSlot === null) {
      window.slots[slot] = held
      window.selectedItem = null
    } else if (inSlot.name === held.name) {
      window.slots[slot] = { name: held.name, count: inSlot.count + held.count }
      window.selectedItem = null
    } else {
      window.slots[slot] = held
      window.selectedItem = inSlot
    }
  }

  private rightClick(window: FakeWindow, slot: number): void {
    const held = window.selectedItem
    if (held === null) return
    const inSlot = window.slots[slot] ?? null
    if (inSlot !== null && inSlot.name !== held.name) return
    window.slots[slot] = { name: held.name, count: (inSlot?.count ?? 0) + 1 }
    window.selectedItem = held.count > 1 ? { name: held.name, count: held.count - 1 } : null
  }

  private takeResult(window: FakeWindow): void {
    const result = window.slots[0]
    if (result === null || result === undefined) {
      this.clicksIgnored += 1
      return
    }
    window.put(result.name, result.count)
    for (let slot = 1; slot <= window.gridWidth * window.gridWidth; slot += 1) {
      const item = window.slots[slot]
      if (item === null || item === undefined) continue
      window.slots[slot] = item.count > 1 ? { name: item.name, count: item.count - 1 } : null
    }
    window.slots[0] = null
  }

  /** The result appears when the grid holds exactly the recipe's ingredients in place. */
  private updateResult(window: FakeWindow): void {
    const wanted = new Map<number, string>()
    if (this.recipe.inShape !== null) {
      this.recipe.inShape.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (cell.id !== -1) wanted.set(1 + x + window.gridWidth * y, NAMES[cell.id] ?? '')
        })
      })
    } else {
      ;(this.recipe.ingredients ?? []).forEach((ingredient, index) => {
        wanted.set(1 + index, NAMES[ingredient.id] ?? '')
      })
    }
    let matches = true
    for (let slot = 1; slot <= window.gridWidth * window.gridWidth; slot += 1) {
      const expected = wanted.get(slot)
      const actual = window.slots[slot]
      if (
        (expected ?? null) !== (actual?.name ?? null) ||
        (actual !== null && actual !== undefined && actual.count !== 1)
      )
        matches = false
    }
    window.slots[0] = matches
      ? { name: NAMES[this.recipe.result.id] ?? '', count: this.recipe.result.count }
      : null
  }
}

const cell = (name: string): { id: number } => ({ id: ITEM_IDS[name] ?? -1 })

export const shaped = (
  result: string,
  count: number,
  rows: (string | null)[][],
  requiresTable: boolean,
): RecipeLike => ({
  result: { id: ITEM_IDS[result] ?? -1, count },
  delta: [],
  requiresTable,
  inShape: rows.map((row) => row.map((name) => (name === null ? { id: -1 } : cell(name)))),
  ingredients: null,
})

export const shapeless = (result: string, count: number, names: string[]): RecipeLike => ({
  result: { id: ITEM_IDS[result] ?? -1, count },
  delta: [],
  requiresTable: false,
  inShape: null,
  ingredients: names.map(cell),
})
