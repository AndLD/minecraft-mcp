import type { z } from 'zod'
import type { Position } from '../../core/position.types.js'
import type { WorkPlan } from '../construction/work-plan.types.js'

export interface FarmLayoutContext {
  /** Where the layout starts; see each kind for what that cell is. */
  readonly origin: Position
  /**
   * What the world holds in a cell right now (undefined when not loaded), for layouts that must react to the ground
   * they are built on. Absent where nothing can be read (a plain unit test of a layout).
   */
  readonly blockAt?: (position: Position) => string | undefined
}

/**
 * Builds a farm component (a field, a pen, later a grove) as a `WorkPlan`, executed by the shared `PlanExecutor`
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
  /** The animal species this component keeps, for the `FarmRegistry` entry, when the kind is a pen. */
  speciesOf?(params: Params): string | undefined
}
