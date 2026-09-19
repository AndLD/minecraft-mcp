import type { Locomotion } from '../core/locomotion.port.js'
import type { Navigator } from '../core/navigator.port.js'
import type { Reflex, ReflexContext, ReflexOutcome, ReflexState } from './reflex.types.js'
import type { SafeSpotFinder } from './safe-spot.js'

/** Start surfacing at this much air left (of 20)... */
export const SURFACE_BELOW = 8
/** ...and stop once the head is out of the water or the air is back to this. */
const BREATHED_AT = 18
const STEP_MS = 3_000
const ARRIVAL_RANGE = 1.5
const ROOM_TO_BREATHE_MS = 500

export interface DrowningOptions {
  readonly navigator: Navigator
  readonly locomotion: Locomotion
  readonly safeSpots: SafeSpotFinder
}

/** Swims up for air when the air is running out. */
export class Drowning implements Reflex {
  readonly name = 'drowning'
  readonly priority = 90
  readonly preemptsTask = true

  constructor(private readonly options: DrowningOptions) {}

  wants(state: ReflexState): boolean {
    return state.vitals.headUnderwater && state.vitals.oxygen <= SURFACE_BELOW
  }

  async run(context: ReflexContext, initial: ReflexState): Promise<ReflexOutcome> {
    let state: ReflexState | undefined = initial
    context.emit(
      `Running out of air (${String(initial.vitals.oxygen)}/20): swimming to the surface.`,
    )
    try {
      while (
        state !== undefined &&
        !context.signal.aborted &&
        state.vitals.headUnderwater &&
        state.vitals.oxygen < BREATHED_AT
      ) {
        this.options.locomotion.setJump(true) // holding jump swims up
        const spot = this.options.safeSpots.find(state.vitals.position, ['water', 'lava'])
        if (spot === undefined) {
          await context.sleep(ROOM_TO_BREATHE_MS)
        } else {
          const step = context.withTimeout(STEP_MS)
          try {
            await this.options.navigator.goToPosition(spot, ARRIVAL_RANGE, { signal: step.signal })
          } finally {
            step.dispose()
          }
        }
        state = context.state()
      }
    } finally {
      this.options.locomotion.setJump(false)
    }
    return { resumeTask: true }
  }
}
