import type { ConnectTarget } from '../core/connection.port.js'
import type { Position } from '../core/position.types.js'

export interface BotEvents {
  spawn: () => void
  end: (reason: string) => void
  kicked: (reason: unknown) => void
  error: (error: Error) => void
  chat: (username: string, message: string) => void
  whisper: (username: string, message: string) => void
}

export interface EntityLike {
  readonly id: number
  /** Mineflayer's coarse type: `player`, `hostile`, `animal`, `passive`, `object`, ... */
  readonly type: string
  readonly name?: string | undefined
  readonly username?: string | undefined
  readonly position: Position
}

export interface PlayerLike {
  readonly username: string
  /** Undefined when the player is out of the bot's view distance. */
  readonly entity?: EntityLike | undefined
}

export interface ItemLike {
  readonly name: string
  readonly count: number
}

/**
 * The pathfinder plugin API this project uses. To halt movement, call `setGoal(null)`, which clears
 * the path at once. Do not use the plugin's `stop()`: it only sets a flag that is honored at the next
 * path node, and if the bot is idle the flag lingers and makes the next `goto` fail immediately.
 */
export interface PathfinderLike {
  goto(goal: unknown): Promise<void>
  setGoal(goal: unknown, dynamic?: boolean): void
}

/**
 * The small part of the Mineflayer `Bot` this project uses. The real bot satisfies it
 * structurally; tests use a stub. Nothing outside `src/bot` sees Mineflayer types.
 */
export interface BotLike {
  readonly username: string
  readonly version: string
  readonly health: number
  readonly food: number
  readonly entity: { readonly position: Position } | undefined
  readonly game: { readonly dimension: string }
  readonly time: { readonly timeOfDay: number }
  readonly spawnPoint: Position
  /** The hashed world seed (hex) from the login packet. Set by our factory, not by Mineflayer. */
  readonly worldSeed?: string | undefined
  readonly entities: Readonly<Record<string, EntityLike>>
  readonly players: Readonly<Record<string, PlayerLike>>
  readonly registry: { readonly blocksByName: Readonly<Record<string, { readonly id: number }>> }
  readonly inventory: { items(): readonly ItemLike[]; emptySlotCount(): number }
  readonly heldItem: ItemLike | null
  readonly pathfinder: PathfinderLike
  chat(message: string): void
  whisper(username: string, message: string): void
  quit(reason?: string): void
  blockAt(position: Position): { readonly name: string } | null
  findBlocks(options: {
    matching: number | number[]
    maxDistance: number
    count: number
  }): readonly Position[]
  clearControlStates(): void
  on<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
  once<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
  removeListener<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): unknown
}

export type BotFactory = (target: ConnectTarget) => BotLike

/** Tells the adapters which bot is current, and when it changes. */
export interface BotHolder {
  current(): BotLike | undefined
  onChange(listener: (bot: BotLike | undefined) => void): () => void
}
