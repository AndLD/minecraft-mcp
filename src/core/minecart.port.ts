import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface MinecartFailure {
  readonly reason: 'not_connected' | 'no_minecart' | 'not_a_rail' | 'out_of_reach' | 'failed'
  readonly message: string
}

/** Puts a minecart from the inventory onto a rail. */
export interface MinecartPlacer {
  place(rail: Position, signal: AbortSignal): Promise<Result<void, MinecartFailure>>
}
