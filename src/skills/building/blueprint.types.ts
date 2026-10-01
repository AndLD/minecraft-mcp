import type { z } from 'zod'

/** One block of a blueprint, relative to the blueprint's lowest corner. */
export interface Placement {
  readonly dx: number
  readonly dy: number
  readonly dz: number
  /** An item name that places this block. */
  readonly block: string
  /** Doors: the axis the bot must stand along when placing it (see `WorkStep`). */
  readonly alignAxis?: 'x' | 'z'
}

export interface Blueprint {
  readonly name: string
  /** Bottom layer first, so walls grow from the ground up. */
  readonly placements: readonly Placement[]
  /** Cells that get a torch when they are dark. */
  readonly lights: readonly { readonly dx: number; readonly dy: number; readonly dz: number }[]
  /** Where the bot works from (default outside the building). */
  readonly standing?: 'outside' | 'inside'
  /**
   * A cell of the blueprint that should be where the bot stands, when no origin is given (a shelter is built around
   * the bot). Without it the default origin is beside the bot.
   */
  readonly anchor?: { readonly dx: number; readonly dy: number; readonly dz: number }
  /** Extent along x, y, and z. */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number }
}

/**
 * A shape a player can ask for. A new shape is a new provider registered in the composition root (Open/Closed); the
 * parameters are validated by the provider's own schema, which also documents them for the agent.
 */
export interface BlueprintProvider<Params = unknown> {
  readonly name: string
  /** What it builds, written for the agent, including how `height` and the origin are meant. */
  readonly description: string
  readonly params: z.ZodType<Params>
  generate(params: Params): Blueprint
}
