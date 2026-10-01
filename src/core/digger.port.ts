import type { Position } from './position.types.js'
import type { Result } from './result.js'

export interface DigAssessment {
  readonly blockName: string
  /** False for air, liquids, bedrock, and anything else that cannot be broken. */
  readonly diggable: boolean
  /** Tools that make the block drop its items. Empty when anything, even a bare hand, does. */
  readonly requiredTools: readonly string[]
  /** True when digging yields the drops: no tool needed, or a fitting one is carried. */
  readonly canHarvest: boolean
  /** The tool that will be taken in hand, or undefined when bare hands are the best available. */
  readonly tool: string | undefined
}

export type DigFailureReason =
  'not_diggable' | 'out_of_reach' | 'aborted' | 'not_connected' | 'failed'

export interface DigFailure {
  readonly reason: DigFailureReason
  readonly message: string
}

export interface Digger {
  /** What digging this block takes. Undefined when the block is not loaded. */
  assess(position: Position): DigAssessment | undefined
  /** Takes the best tool in hand and breaks the block. Aborting stops the digging. */
  dig(position: Position, signal: AbortSignal): Promise<Result<void, DigFailure>>
}
