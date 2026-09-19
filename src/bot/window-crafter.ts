import type { ItemLike, RecipeLike } from './bot-like.types.js'

/** What the crafter needs to know about an inventory or crafting-table window. */
export interface CraftWindow {
  readonly slots: readonly (ItemLike | null)[]
  /** The stack on the mouse cursor, as the client last learned it. */
  readonly selectedItem: ItemLike | null
  /** The player's own slots, `[inventoryStart, inventoryEnd)`. */
  readonly inventoryStart: number
  readonly inventoryEnd: number
}

/** The window operations crafting is built from. The Mineflayer factory implements them over the real bot. */
export interface CraftWindowBot {
  readonly inventoryWindow: CraftWindow
  itemName(id: number): string | undefined
  /** Opens the crafting table the caller picked. */
  openTable(): Promise<CraftWindow>
  closeWindow(window: CraftWindow): Promise<void>
  /** A raw window click: mouse button 0 (left) or 1 (right), and a click mode (0 normal, 1 shift). */
  click(slot: number, mouseButton: number, mode: number): Promise<void>
  /** Waits a few game ticks, so the server's answer to the last click has arrived before the next one is sent. */
  settle(): Promise<void>
  /** Asks the server for the window's true state and adopts it (also refreshes what the next click is checked against). */
  sync(window: CraftWindow): Promise<void>
}

const RESULT_SLOT = 0
const DROP_SLOT = -999

/**
 * Crafts by clicking, the way a player does, and lets the server say what came out.
 *
 * Mineflayer's own `bot.craft` predicts the outcome on the client and reports success either way. Since 1.17 the
 * server silently ignores a click whose picture of the window is stale, so on a real server a craft can fail half way:
 * ingredients stay in the grid, part of a stack stays on the cursor, and the next craft reports "missing ingredient".
 * Here every phase is followed by a sync, the result is taken with a shift-click (the server crafts it), and
 * it is checked that the server actually offered the expected result before it is taken.
 */
export class WindowCrafter {
  constructor(private readonly bot: CraftWindowBot) {}

  /** Crafts `recipe` `times` times, on a crafting table when `onTable` (3x3), otherwise in the inventory grid (2x2). */
  async craft(recipe: RecipeLike, times: number, onTable: boolean): Promise<void> {
    const window = onTable ? await this.bot.openTable() : this.bot.inventoryWindow
    const width = onTable ? 3 : 2
    let failure: unknown
    try {
      for (let round = 0; round < times; round += 1) await this.craftOnce(window, width, recipe)
    } catch (error) {
      failure = error
    }
    // Closing the table hands back anything still in its grid.
    if (onTable) await this.bot.closeWindow(window).catch(() => undefined)
    await this.bot.sync(this.bot.inventoryWindow).catch(() => undefined)
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error(typeof failure === 'string' ? failure : 'The craft failed.')
  }

  private async craftOnce(window: CraftWindow, width: number, recipe: RecipeLike): Promise<void> {
    const wanted = this.name(recipe.result.id)
    await this.bot.sync(window)
    await this.putCursorAway(window)
    for (const cell of this.cells(recipe, width)) await this.placeOne(window, cell.item, cell.slot)

    await this.bot.sync(window) // the server works out the result and sends it
    const offered = window.slots[RESULT_SLOT]
    if (offered?.name !== wanted) {
      throw new Error(
        `The game did not offer ${wanted} for these ingredients (it offered ${offered?.name ?? 'nothing'}).`,
      )
    }
    await this.click(RESULT_SLOT, 0, 1) // shift-click: the server crafts and moves the result to the inventory
    await this.bot.sync(window)
  }

  /** Where each ingredient goes: the recipe's shape from the top-left corner, or one after another for shapeless recipes. */
  private cells(recipe: RecipeLike, width: number): { slot: number; item: string }[] {
    const cells: { slot: number; item: string }[] = []
    if (recipe.inShape !== null) {
      recipe.inShape.forEach((row, y) => {
        row.forEach((cell, x) => {
          if (cell.id !== -1) cells.push({ slot: 1 + x + width * y, item: this.name(cell.id) })
        })
      })
    } else {
      ;(recipe.ingredients ?? []).forEach((ingredient, index) => {
        cells.push({ slot: 1 + index, item: this.name(ingredient.id) })
      })
    }
    return cells
  }

  /** Moves one item of the kind from the inventory into a grid slot. */
  private async placeOne(window: CraftWindow, item: string, destination: number): Promise<void> {
    const source = this.findInInventory(window, item)
    if (source === undefined) throw new Error(`missing ingredient ${item}`)
    await this.click(source, 0, 0) // pick up the whole stack
    await this.click(destination, 1, 0) // put one into the grid
    // The grid changed, so the server sends an update of its own (the new result); a click sent before it arrives
    // would carry an outdated window state and be ignored. Wait for the update.
    await this.bot.sync(window)
    if (window.selectedItem !== null) await this.click(source, 0, 0) // and the rest back
  }

  private findInInventory(window: CraftWindow, item: string): number | undefined {
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1)
      if (window.slots[slot]?.name === item) return slot
    return undefined
  }

  /** A stack left on the cursor by something else would be picked up instead of the ingredient. */
  private async putCursorAway(window: CraftWindow): Promise<void> {
    if (window.selectedItem === null) return
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
      if (window.slots[slot] === null) {
        await this.click(slot, 0, 0)
        return
      }
    }
    await this.click(DROP_SLOT, 0, 0) // no room anywhere: drop it
  }

  /** Every click is followed by a short wait: the server corrects clicks it disagrees with, and a click sent meanwhile is ignored. */
  private async click(slot: number, mouseButton: number, mode: number): Promise<void> {
    await this.bot.click(slot, mouseButton, mode)
    await this.bot.settle()
  }

  private name(id: number): string {
    return this.bot.itemName(id) ?? `item_${String(id)}`
  }
}
