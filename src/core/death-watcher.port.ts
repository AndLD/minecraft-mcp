import type { Unsubscribe } from './connection.port.js'
import type { Position } from './position.types.js'
import type { ItemCount } from './recipes.port.js'

export interface DeathEvent {
  readonly position: Position
  readonly dimension: string
  /** Everything carried and worn just before the death (all slots, including armor and the off hand). */
  readonly carried: readonly ItemCount[]
  /** What the server said about the death ("ClaudeBot was slain by Zombie"), when it arrived in time. */
  readonly cause: string | undefined
}

export interface DeathWatcher {
  /** Called once the bot has respawned, so that what it carries afterwards can be compared with `carried`. */
  onDeath(listener: (event: DeathEvent) => void): Unsubscribe
  /** Everything carried and worn now, including armor and the off hand. */
  carried(): readonly ItemCount[]
}
