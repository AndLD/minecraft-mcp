import type { Position } from '../../core/position.types.js'

/**
 * One block operation. Cells are whole-number block coordinates. Shape generators (blueprints, excavation, railways)
 * produce steps; the `PlanExecutor` carries them out.
 */
export type WorkStep =
  /** Put `block` (an item name) into the cell. */
  | { readonly kind: 'place'; readonly at: Position; readonly block: string }
  /** Break whatever is in the cell. */
  | { readonly kind: 'break'; readonly at: Position }
  /** Put a torch in the cell when it is darker than `minLight` and no torch is close enough already. */
  | { readonly kind: 'light'; readonly at: Position; readonly minLight: number }

export interface WorkPlan {
  /** For messages, for example `box 5x4x3`. */
  readonly name: string
  /** In the order the provider prefers; the executor takes the first step that can be done right now. */
  readonly steps: readonly WorkStep[]
}

/** Makes a plan out of parameters. A new shape is a new provider (Open/Closed). */
export interface PlanProvider<Params> {
  readonly name: string
  plan(params: Params): WorkPlan
}
