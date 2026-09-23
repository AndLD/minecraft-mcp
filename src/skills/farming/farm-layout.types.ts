import type { z } from 'zod'
import type { Position } from '../../core/position.types.js'
import type { WorkPlan } from '../construction/work-plan.types.js'

export interface FarmLayoutContext {
  /** Where the layout starts; see each kind for what that cell is. */
  readonly origin: Position
}

/**
 * Builds a farm component (a field, later a pen or a grove) as a `WorkPlan`, executed by the shared `PlanExecutor`
 * exactly like a blueprint or an excavation shape. A new kind is a new provider (Open/Closed), registered in the
 * composition root.
 */
export interface FarmLayoutProvider<Params = unknown> {
  readonly kind: string
  /** What it builds, written for the agent, including what the origin is and how sizes are meant. */
  readonly description: string
  readonly params: z.ZodType<Params>
  /** Where the layout starts when the request names no place: derived from where the bot stands. */
  defaultOrigin(feet: Position, params: Params): Position
  /** The plan, or a message saying why the parameters cannot be built. */
  generate(params: Params, context: FarmLayoutContext): WorkPlan | { readonly error: string }
  /** The crop this component grows, for the `FarmRegistry` entry, when the kind plants one. */
  cropOf?(params: Params): string | undefined
}
