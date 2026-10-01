export interface ItemStackInfo {
  readonly name: string
  readonly count: number
}

export interface InventorySnapshot {
  readonly stacks: readonly ItemStackInfo[]
  readonly emptySlots: number
  readonly heldItem: string | undefined
}

export interface InventoryReader {
  /** Undefined while not connected. */
  snapshot(): InventorySnapshot | undefined
}
