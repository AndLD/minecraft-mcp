import type { Position } from './position.types.js'

export interface BlockInfo {
  readonly name: string
  readonly position: Position
  /** Straight-line distance from the bot, in blocks. */
  readonly distance: number
}

export interface BlockSummary {
  readonly name: string
  readonly count: number
  readonly nearest: Position
  readonly nearestDistance: number
}

export interface BlockQuery {
  /** Exact block names, for example `oak_log`. */
  readonly names: readonly string[]
  readonly maxDistance: number
  readonly count: number
}

export interface BlockScanner {
  /** Every block name the game knows. Empty while not connected. */
  knownBlockNames(): readonly string[]
  /** Nearest first. Only loaded chunks are searched. */
  findBlocks(query: BlockQuery): readonly BlockInfo[]
  blockAt(position: Position): string | undefined
  /** True for full solid blocks that can be stood on. Undefined when the block is not loaded. */
  isSolid(position: Position): boolean | undefined
  /** Counts the non-air blocks in a cube around the bot. */
  sampleBlocks(radius: number): readonly BlockSummary[]
}
