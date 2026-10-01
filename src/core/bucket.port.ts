import type { Position } from './position.types.js'
import type { Result } from './result.js'

export type Liquid = 'water' | 'lava'

/** A water or lava cell as the world reports it. */
export interface LiquidState {
  readonly liquid: Liquid
  /**
   * True for a source block (blockstate `level` 0), the only kind a bucket can take. A flowing cell (level 1 to 7) or a
   * falling one (level 8 and up) is not.
   */
  readonly source: boolean
}

/** Reads what liquid a cell holds. */
export interface LiquidReader {
  /** The cell's liquid, or undefined when it is not loaded or holds no water or lava. */
  liquidAt(position: Position): LiquidState | undefined
}

export interface BucketFailure {
  readonly reason: 'not_connected' | 'no_bucket' | 'not_a_source' | 'out_of_reach' | 'failed'
  readonly message: string
}

export interface FilledBucket {
  /** What the bucket became: `water_bucket` or `lava_bucket`. */
  readonly item: string
}

/** Fills an empty bucket from a liquid source block. */
export interface BucketFiller {
  /**
   * Takes the liquid at `source` with an empty bucket from the inventory (the bot must already stand within reach) and
   * confirms that the inventory gained the filled bucket. Aborting stops the wait.
   */
  fill(source: Position, signal: AbortSignal): Promise<Result<FilledBucket, BucketFailure>>
}
