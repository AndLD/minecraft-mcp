import type { Result } from './result.js'

export type AnimalInteractionFailureReason = 'not_connected' | 'no_item' | 'not_found' | 'failed'

export interface AnimalInteractionFailure {
  readonly reason: AnimalInteractionFailureReason
  readonly message: string
}

/** Holding food attracts nearby animals; feeding one (right-clicking it while holding food) is how breeding starts. */
export interface AnimalInteraction {
  /** Equips the item in hand. */
  hold(item: string): Promise<Result<void, AnimalInteractionFailure>>
  /** Right-clicks the animal with whatever is in hand, consuming one of it. */
  feed(entityId: number): Promise<Result<void, AnimalInteractionFailure>>
}
