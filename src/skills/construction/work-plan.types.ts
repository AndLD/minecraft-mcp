import type { Position } from '../../core/position.types.js'

/**
 * One block operation. Cells are whole-number block coordinates. Shape generators (blueprints, excavation, railways)
 * produce steps; the `PlanExecutor` carries them out.
 */
export type WorkStep =
  /** Put `block` (an item name) into the cell. */
  | {
      readonly kind: 'place'
      readonly at: Position
      readonly block: string
      /**
       * For blocks whose orientation follows where the bot looks (doors): the bot must stand in line with the cell
       * along this axis, so the block ends up parallel to a wall that runs along the other axis.
       */
      readonly alignAxis?: 'x' | 'z'
      /**
       * For blocks that hang on a wall (a ladder): the offset from the cell to the block it must be placed against.
       * Without it the block is placed against whatever supports it, preferring the block below.
       */
      readonly against?: Position
      /** The chain this step belongs to: it is skipped when a hazard ends that chain. */
      readonly branch?: string
      /**
       * The block has no collision (a rail, a torch): the bot can stand in its cell while it is placed, so the cell is
       * not kept free for it. Without this a line of rails through a tunnel keeps the bot out of the tunnel it is digging.
       */
      readonly passable?: boolean
      /**
       * The plan clears this cell with a `break` step of its own: wait for that instead of breaking whatever is in the
       * cell as part of placing (which would dig without the hazard rule and out of order).
       */
      readonly clearedFirst?: boolean
      /**
       * A best-effort placement (a door): counted in `needs`, fetched from storage and crafted from what the bot
       * carries when possible, but never blocks the plan from running or finishing when it cannot be had — unlike an
       * ordinary `place` step, whose material is required.
       */
      readonly optional?: boolean
    }
  /** Break whatever is in the cell. */
  | {
      readonly kind: 'break'
      readonly at: Position
      /** The chain this cell belongs to (a tunnel, one side branch). When a hazard ends it, the rest of the chain is skipped. */
      readonly branch?: string
      /** The cell must already be open before this one can be dug (where a side branch leaves the main tunnel). */
      readonly needs?: Position
      /** Failing to break it is not a failure of the plan (an ore of a vein that turned out to be out of reach). */
      readonly optional?: boolean
      /**
       * Offsets of the neighbours that must not be an open cavity (a *cave breakthrough*): everything around the
       * opening except the way the bot came from. Only checked when the plan asks for it.
       */
      readonly probe?: readonly Position[]
    }
  /** Put a torch in the cell when it is darker than `minLight` and no torch is close enough already. */
  | {
      readonly kind: 'light'
      readonly at: Position
      readonly minLight: number
      /** No torch closer than this many blocks (default 4). */
      readonly spacing?: number
      /** Stop the plan with `no_torches` when there is none to place, instead of carrying on in the dark. */
      readonly required?: boolean
      /** The chain this step belongs to: it is skipped when a hazard ends that chain. */
      readonly branch?: string
    }
  /**
   * Make sure the cell is solid: a wall, floor, ceiling, or a stair or ladder's own support that the plan never digs
   * or places by itself, so it must already be there. Satisfied when it already is (the ordinary case); `block` (an
   * item name) is placed only when the cell is unexpectedly open (a cave that hollowed it out before the dig got
   * there). Unlike `place`, any solid block satisfies it, not only `block` itself.
   */
  | {
      readonly kind: 'seal'
      readonly at: Position
      readonly block: string
      /** The chain this step belongs to: it is skipped when a hazard ends that chain. */
      readonly branch?: string
    }
  /** Hoe the cell (dirt or grass) into farmland. Satisfied once the cell reads back as `farmland`. */
  | {
      readonly kind: 'till'
      readonly at: Position
      /** The chain this step belongs to: it is skipped when a hazard ends that chain. */
      readonly branch?: string
    }

export interface WorkPlan {
  /** For messages, for example `box 5x4x3`. */
  readonly name: string
  /** In the order the provider prefers; the executor takes the first step that can be done right now. */
  readonly steps: readonly WorkStep[]
  /** Where the bot works from: outside the volume (default), or inside it (a shelter built around the bot). */
  readonly standing?: 'outside' | 'inside'
  /**
   * What to do about lava beside the site: `refuse` (default) does nothing and says why; `end_branch` (digging) checks
   * every break with the hazard rule and only stops the chain that meets the hazard.
   */
  readonly hazards?: 'refuse' | 'end_branch'
  /**
   * The plan digs a whole volume (a pit, a quarry, a room): an open cell inside it is its own to dig, never a cave to
   * seal. Off for a tunnel, where an open cell ahead in the line is a real breakthrough.
   */
  readonly ownVolume?: boolean
  /**
   * What to do about sand or gravel above a block about to be broken: `stop` (default) ends the chain there and names
   * the cells; `clear` digs the column from the top down first (after the check for lava and water beside it).
   */
  readonly fallingBlocks?: 'stop' | 'clear'
  /** Check every break for a cave breakthrough (see `probe`). */
  readonly cavityCheck?: boolean
  /** Mine any ore that touches a dug cell, vein by vein, up to this many blocks per vein. */
  readonly veins?: { readonly maxSize: number }
  /**
   * When set, a `cave_breakthrough` hazard is closed instead of ending the chain: the open cell is filled with
   * `block` (falling back to `fallback` when none is carried) and the chain carries on past it to its planned
   * extent. Also what `seal` steps place when they find their cell unexpectedly open. Undefined (the default) keeps
   * the old behaviour: a cave breakthrough always ends the chain, and there are no `seal` steps.
   */
  readonly seal?: { readonly block: string; readonly fallback: string }
  /**
   * Read the result back at the end: clear stray blocks from the dug cells (never special blocks), close the open cells
   * a sealed dig should have closed, and fail with `verification_failed` when the shape still does not match. Off by
   * default; set for every excavation shape.
   */
  readonly verify?: boolean
  /** Informational notes for the preview (for example: a door leaves a gap above it). Never affects execution. */
  readonly warnings?: readonly string[]
}

/** Makes a plan out of parameters. A new shape is a new provider (Open/Closed). */
export interface PlanProvider<Params> {
  readonly name: string
  plan(params: Params): WorkPlan
}
