import type { BlockScanner } from '../core/block-scanner.port.js'
import type { Locomotion } from '../core/locomotion.port.js'
import type { Navigator } from '../core/navigator.port.js'
import type { Position } from '../core/position.types.js'
import type { Reflex, ReflexContext, ReflexOutcome, ReflexState } from './reflex.types.js'
import type { SafeSpotFinder } from './safe-spot.js'

export interface AvoidLavaOptions {
  readonly blocks: BlockScanner
  readonly navigator: Navigator
  readonly locomotion: Locomotion
  readonly safeSpots: SafeSpotFinder
}

const STEP_MS = 3_000
const ARRIVAL_RANGE = 1.5

/** Gets out of lava, and away from lava next to the bot (it flows, and a bump could push the bot in). */
export class AvoidLava implements Reflex {
  readonly name = 'avoid_lava'
  readonly priority = 100
  readonly preemptsTask = true

  constructor(private readonly options: AvoidLavaOptions) {}

  wants(state: ReflexState): boolean {
    return state.vitals.inLava || this.lavaNear(state.vitals.position)
  }

  async run(context: ReflexContext, initial: ReflexState): Promise<ReflexOutcome> {
    let state: ReflexState | undefined = initial
    context.emit(initial.vitals.inLava ? 'In lava! Getting out.' : 'Lava next to me: moving away.')
    try {
      while (state !== undefined && !context.signal.aborted && this.wants(state)) {
        this.options.locomotion.setJump(state.vitals.inLava) // swim up out of it
        const spot = this.options.safeSpots.find(state.vitals.position, ['lava'])
        if (spot === undefined) {
          context.emit('No safe spot away from the lava was found.')
          break
        }
        const step = context.withTimeout(STEP_MS)
        try {
          await this.options.navigator.goToPosition(spot, ARRIVAL_RANGE, { signal: step.signal })
        } finally {
          step.dispose()
        }
        state = context.state()
      }
    } finally {
      this.options.locomotion.setJump(false)
    }
    return { resumeTask: true }
  }

  private lavaNear(position: Position): boolean {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (this.options.blocks.blockAt({ x: x + dx, y: y + dy, z: z + dz }) === 'lava')
            return true
        }
      }
    }
    return false
  }
}
