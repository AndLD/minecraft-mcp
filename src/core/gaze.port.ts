import type { Position } from './position.types.js'

/** Where the bot looks: it faces a point before it throws something there. */
export interface Gaze {
  lookAt(target: Position): Promise<void>
}
