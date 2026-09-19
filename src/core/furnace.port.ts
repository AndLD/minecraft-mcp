import type { ItemStackInfo } from './inventory.port.js'
import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface FurnaceContents {
  readonly input: ItemStackInfo | undefined
  readonly fuel: ItemStackInfo | undefined
  readonly output: ItemStackInfo | undefined
  /** True while the furnace is lit. */
  readonly burning: boolean
}

/** An opened furnace. Always `close()` it. */
export interface FurnaceSession {
  contents(): FurnaceContents
  putInput(item: string, count: number): Promise<void>
  putFuel(item: string, count: number): Promise<void>
  /** Moves what is in the slot into the inventory; undefined when the slot is empty. */
  takeInput(): Promise<ItemStackInfo | undefined>
  takeFuel(): Promise<ItemStackInfo | undefined>
  takeOutput(): Promise<ItemStackInfo | undefined>
  close(): Promise<void>
}

export interface FurnaceAccess {
  /** Opens the furnace block at the position. */
  open(position: Position): Promise<Result<FurnaceSession>>
}
