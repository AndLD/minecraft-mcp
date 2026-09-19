import type { ConnectTarget } from '../core/connection.port.js'
import type { Position } from '../core/position.types.js'
import type { ContainerWindowLike } from './window-transfer.js'

export interface BotEvents {
  spawn: () => void
  end: (reason: string) => void
  kicked: (reason: unknown) => void
  error: (error: Error) => void
  chat: (username: string, message: string) => void
  whisper: (username: string, message: string) => void
  /** The bot's health reached zero. Mineflayer respawns it by itself. */
  death: () => void
  respawn: () => void
  health: () => void
  /** Every chat line as plain text, including the server's own messages (deaths, joins). */
  messagestr: (message: string) => void
}

export interface EntityLike {
  readonly id: number
  /** Mineflayer's coarse type: `player`, `hostile`, `animal`, `passive`, `object`, ... */
  readonly type: string
  readonly name?: string | undefined
  readonly username?: string | undefined
  readonly position: Position
  /** False once the entity has been removed from the world. */
  readonly isValid?: boolean | undefined
  /**
   * True once the entity died. A dead mob lingers for a second (death animation) and must not count as a threat
   * or a target. Set by our factory from Mineflayer's `entityDead` event, which never marks the entity itself.
   */
  readonly isDead?: boolean | undefined
  /** Raw entity metadata by index; `registry.entitiesByName[name].metadataKeys` names the indexes. */
  readonly metadata?: readonly unknown[] | undefined
  /** Where the entity looks, in radians (Mineflayer's convention: yaw 0 faces -z, positive pitch looks up). */
  readonly yaw?: number | undefined
  readonly pitch?: number | undefined
  /** Entities riding this one. */
  readonly passengers?: readonly unknown[] | undefined
  /** For item entities: what lies on the ground. */
  getDroppedItem?(): ItemLike | null
}

export type EquipSlot = 'hand' | 'off-hand' | 'head' | 'torso' | 'legs' | 'feet'

export interface PlayerLike {
  readonly username: string
  /** Undefined when the player is out of the bot's view distance. */
  readonly entity?: EntityLike | undefined
}

export interface ItemLike {
  readonly name: string
  readonly count: number
}

export interface BlockLike {
  readonly name: string
  /** `block` for full solid blocks, `empty` for air, liquids, and plants. */
  readonly boundingBox?: string | undefined
}

/** A crafting recipe as Mineflayer builds it. `delta` lists what changes in the inventory (ingredients negative). */
export interface RecipeLike {
  readonly result: { readonly id: number; readonly count: number }
  readonly delta: readonly { readonly id: number; readonly count: number }[]
  readonly requiresTable: boolean
  /** The grid pattern of a shaped recipe (rows of cells; id -1 is an empty cell), or null. */
  readonly inShape: readonly (readonly { readonly id: number }[])[] | null
  /** The items of a shapeless recipe, or null. */
  readonly ingredients: readonly { readonly id: number }[] | null
}

/** An opened furnace window. */
export interface FurnaceLike {
  /** Fuel left in the current piece, from 0 to 1 (0 when unlit). */
  readonly fuel: number
  inputItem(): ItemLike | null
  fuelItem(): ItemLike | null
  outputItem(): ItemLike | null
  putInput(itemType: number, metadata: number | null, count: number): Promise<void>
  putFuel(itemType: number, metadata: number | null, count: number): Promise<void>
  takeInput(): Promise<ItemLike | null>
  takeFuel(): Promise<ItemLike | null>
  takeOutput(): Promise<ItemLike | null>
  close(): void | Promise<void>
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
  readonly foodSaturation: number
  readonly oxygenLevel: number
  readonly entity: { readonly position: Position } | undefined
  readonly game: { readonly dimension: string }
  readonly time: { readonly timeOfDay: number }
  readonly spawnPoint: Position
  /** The hashed world seed (hex) from the login packet. Set by our factory, not by Mineflayer. */
  readonly worldSeed?: string | undefined
  /** The commands the server offers this player (from its `declare_commands` packet). Set by our factory, not by Mineflayer. */
  readonly commandNames?: readonly string[] | undefined
  readonly entities: Readonly<Record<string, EntityLike>>
  readonly players: Readonly<Record<string, PlayerLike>>
  /** Only `raycast` is used: the first block a ray hits, for "the chest the player looks at". */
  readonly world: {
    raycast(
      from: Position,
      direction: Position,
      range: number,
    ): { readonly name: string; readonly position: Position } | null
  }
  readonly registry: {
    readonly blocksByName: Readonly<
      Record<
        string,
        {
          readonly id: number
          readonly diggable?: boolean | undefined
          /** For example `mineable/pickaxe`. */
          readonly material?: string | undefined
          /** Item ids of the tools that make the block drop its items; undefined when any tool does. */
          readonly harvestTools?: Readonly<Record<number, boolean>> | undefined
        }
      >
    >
    readonly itemsByName: Readonly<Record<string, { readonly id: number }>>
    readonly items: Readonly<Record<number, { readonly name: string; readonly stackSize?: number }>>
    readonly entitiesByName: Readonly<
      Record<string, { readonly metadataKeys?: readonly string[] | undefined }>
    >
    /** Keyed by the id of the item that is made. Only the keys are used. */
    readonly recipes: Readonly<Record<string, unknown>>
    readonly foodsByName: Readonly<
      Record<string, { readonly foodPoints: number; readonly saturation: number }>
    >
  }
  readonly inventory: {
    /** Fires whenever a slot changes (`updateSlot` in Mineflayer). */
    on(event: 'updateSlot', listener: () => void): unknown
    removeListener(event: 'updateSlot', listener: () => void): unknown
    items(): readonly ItemLike[]
    emptySlotCount(): number
    /** All window slots; 5 to 8 are the armor slots (head, torso, legs, feet). */
    readonly slots: readonly (ItemLike | null)[]
  }
  readonly heldItem: ItemLike | null
  readonly pathfinder: PathfinderLike
  chat(message: string): void
  whisper(username: string, message: string): void
  quit(reason?: string): void
  blockAt(position: Position): BlockLike | null
  findBlocks(options: {
    matching: number | number[]
    maxDistance: number
    count: number
  }): readonly Position[]
  clearControlStates(): void
  setControlState(control: 'jump' | 'sprint', active: boolean): void
  /** Puts the item type (an id from `registry.itemsByName`) into the slot. */
  equip(itemType: number, destination: EquipSlot): Promise<void>
  /** Eats or drinks the item in hand. */
  consume(): Promise<void>
  /** Hits an entity taken from `entities`. */
  attack(entity: EntityLike): void
  /** Breaks a block returned by `blockAt`. Resolves when it is gone. */
  dig(block: BlockLike): Promise<void>
  stopDigging(): void
  /** Places the item in hand against the face (a unit vector) of a block returned by `blockAt`. */
  placeBlock(reference: BlockLike, face: Position): Promise<void>
  openFurnace(block: BlockLike): Promise<FurnaceLike>
  /** The bot's own inventory window with raw click, wait, and sync operations. Installed by our factory after spawn. */
  readonly inventoryWindow: ContainerWindowLike
  /** Turns to face a point. */
  lookAt(point: Position, force?: boolean): Promise<void>
  /** Waits for game ticks (50 ms each). */
  waitForTicks(ticks: number): Promise<void>
  /** Opens a chest, barrel, or shulker box for `WindowTransfer`. Installed by our factory after spawn. */
  openContainerWindow(block: BlockLike): Promise<ContainerWindowLike>
  /** Every recipe for the item; those needing a table are included when `craftingTable` is true. */
  recipesAll(
    itemType: number,
    metadata: number | null,
    craftingTable: boolean,
  ): readonly RecipeLike[]
  craft(recipe: RecipeLike, count: number, craftingTable?: BlockLike | null): Promise<void>
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
