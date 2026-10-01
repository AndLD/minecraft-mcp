import type { ItemStackInfo } from './inventory.port.js'
import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface ContainerContents {
  /** Stacks inside, as the server shows them right now. */
  readonly stacks: readonly ItemStackInfo[]
  readonly totalSlots: number
  readonly emptySlots: number
}

/** An opened chest, barrel, or shulker box (a double chest is one container). Always `close()` it. */
export interface ContainerSession {
  contents(): ContainerContents
  /** Moves up to `count` of the item (all of it when undefined) from the inventory in. Returns how many went in. */
  deposit(item: string, count: number | undefined): Promise<number>
  /** Moves up to `count` of the item (all of it when undefined) into the inventory. Returns how many came out. */
  withdraw(item: string, count: number | undefined): Promise<number>
  close(): Promise<void>
}

export interface ContainerAccess {
  /** Opens the container block at the position. The bot must be within reach. */
  open(position: Position): Promise<Result<ContainerSession>>
}

/** Which face of a block a look ray hit: the side facing whoever looked at it. */
export type LookFace = 'top' | 'bottom' | 'north' | 'south' | 'east' | 'west'

/** Where the player is looking, for "the chest I am looking at" and "dig a room behind this wall". */
export interface LookTarget {
  /** The block the player's crosshair points at (within a few blocks), or undefined. */
  blockLookedAt(
    player: string,
  ): { readonly name: string; readonly position: Position; readonly face: LookFace } | undefined
}
