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
  /** Check every break for a cave breakthrough (see `probe`). */
  readonly cavityCheck?: boolean
  /** Mine any ore that touches a dug cell, vein by vein, up to this many blocks per vein. */
  readonly veins?: { readonly maxSize: number }
}

/** Makes a plan out of parameters. A new shape is a new provider (Open/Closed). */
export interface PlanProvider<Params> {
  readonly name: string
  plan(params: Params): WorkPlan
}
