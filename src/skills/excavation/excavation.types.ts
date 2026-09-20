import type { z } from 'zod'
import type { Position } from '../../core/position.types.js'
import type { WorkPlan } from '../construction/work-plan.types.js'

export interface ExcavationContext {
  /** Where the dig starts (see each shape for what that cell is). */
  readonly origin: Position
  /** The lowest layer of the dimension the bot is in: -64 in the overworld, 0 in the Nether and the End. */
  readonly minY: number
}

/**
 * A shape to dig. A new shape is a new provider registered in the composition root (Open/Closed); each validates its
 * own parameters with a zod schema, which also documents them for the agent.
 */
export interface ExcavationProvider<Params = unknown> {
  readonly name: string
  /** What it digs, written for the agent, including what the origin is and how sizes are meant. */
  readonly description: string
  readonly params: z.ZodType<Params>
  /** Where the dig starts when the request names no place: derived from where the bot stands. */
  defaultOrigin(feet: Position, params: Params): Position
  /** The plan, or a message saying why the parameters cannot be dug. */
  generate(params: Params, context: ExcavationContext): WorkPlan | { readonly error: string }
}
