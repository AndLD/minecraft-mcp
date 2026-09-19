import { EventEmitter } from 'node:events'
import type {
  BlockLike,
  BotEvents,
  BotLike,
  EntityLike,
  EquipSlot,
  ItemLike,
  PathfinderLike,
  PlayerLike,
} from '../../src/bot/bot-like.types.js'
import type { Position } from '../../src/core/position.types.js'

/** A pathfinder whose movements finish only when the test says so, and which behaves like the real plugin. */
export class FakePathfinder implements PathfinderLike {
  readonly gotoGoals: unknown[] = []
  readonly followGoals: { goal: unknown; dynamic: boolean | undefined }[] = []
  /** How many times movement was halted with `setGoal(null)`. */
  stopCalls = 0
  private pending: { resolve: () => void; reject: (error: Error) => void }[] = []

  goto(goal: unknown): Promise<void> {
    this.gotoGoals.push(goal)
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ resolve, reject })
    })
  }

  /** Like the real plugin, changing the goal ends any trip in progress with `GoalChanged`. */
  setGoal(goal: unknown, dynamic?: boolean): void {
    if (goal === null) this.stopCalls += 1
    else this.followGoals.push({ goal, dynamic })
    const interrupted = this.pending
    this.pending = []
    for (const trip of interrupted)
      trip.reject(namedError('GoalChanged', 'The goal was changed before it could be completed!'))
  }

  /** The bot reaches the goal. */
  arrive(): void {
    this.pending.shift()?.resolve()
  }

  /** The pathfinder rejects the way the real plugin does (error names NoPath, Timeout, ...). */
  failWith(name: string, message = name): void {
    this.pending.shift()?.reject(namedError(name, message))
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

const key = (p: Position): string =>
  `${String(Math.floor(p.x))},${String(Math.floor(p.y))},${String(Math.floor(p.z))}`

/** A stub of the game bot: tests drive it by emitting events and read what it was asked to do. */
export class FakeBot implements BotLike {
  username = 'ClaudeBot'
  version = '1.21.1'
  health = 20
  food = 20
  entity: BotLike['entity'] = { position: { x: 10, y: 64, z: -5 } }
  game = { dimension: 'overworld' }
  time = { timeOfDay: 6000 }
  spawnPoint: Position = { x: 48, y: 81, z: 32 }
  worldSeed: string | undefined = 'a1b2c3d4e5f60718'
  entities: Record<string, EntityLike> = {}
  players: Record<string, PlayerLike> = {}
  registry = {
    blocksByName: {
      air: { id: 0 },
      stone: { id: 1 },
      dirt: { id: 2 },
      oak_log: { id: 3 },
      iron_ore: { id: 4 },
      crafting_table: { id: 5 },
    } as Record<string, { id: number }>,
    itemsByName: {
      cooked_beef: { id: 100 },
      bread: { id: 101 },
      apple: { id: 102 },
      rotten_flesh: { id: 103 },
      golden_apple: { id: 104 },
      wooden_sword: { id: 110 },
      iron_sword: { id: 111 },
      diamond_sword: { id: 112 },
      stone_axe: { id: 113 },
      iron_helmet: { id: 120 },
      iron_chestplate: { id: 121 },
      leather_helmet: { id: 122 },
      diamond_boots: { id: 123 },
    } as Record<string, { id: number }>,
    foodsByName: {
      cooked_beef: { foodPoints: 8, saturation: 12.8 },
      bread: { foodPoints: 5, saturation: 6 },
      apple: { foodPoints: 4, saturation: 2.4 },
      rotten_flesh: { foodPoints: 4, saturation: 0.8 },
      golden_apple: { foodPoints: 4, saturation: 9.6 },
    } as Record<string, { foodPoints: number; saturation: number }>,
  }
  inventoryItems: ItemLike[] = []
  emptySlots = 36
  heldItem: ItemLike | null = null
  readonly pathfinder = new FakePathfinder()
  clearControlStatesCalls = 0
  /** The block world, by integer coordinates. Unknown positions are unloaded (null). */
  private readonly blocks = new Map<string, string>()
  /** Armor slots are 5 (head), 6 (torso), 7 (legs), 8 (feet). */
  slots: (ItemLike | null)[] = Array.from({ length: 46 }, () => null)
  inventory = {
    items: (): readonly ItemLike[] => this.inventoryItems,
    emptySlotCount: (): number => this.emptySlots,
    slots: this.slots,
  }
  foodSaturation = 5
  oxygenLevel = 20
  readonly equipped: { itemType: number; slot: EquipSlot }[] = []
  readonly attacked: number[] = []
  readonly controlStates: { control: string; active: boolean }[] = []
  consumeCalls = 0
  /** Make equip or consume fail, to test error handling. */
  failEquip: Error | undefined
  failConsume: Error | undefined

  readonly chatLog: string[] = []
  readonly whisperLog: { player: string; text: string }[] = []
  quitCalls = 0
  /** When true, quit() ends the session like a real bot does. */
  endOnQuit = true

  private readonly emitter = new EventEmitter()

  setBlock(position: Position, name: string): void {
    this.blocks.set(key(position), name)
  }

  blockAt(position: Position): BlockLike | null {
    const name = this.blocks.get(key(position))
    if (name === undefined) return null
    return {
      name,
      boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block',
    }
  }

  setControlState(control: 'jump' | 'sprint', active: boolean): void {
    this.controlStates.push({ control, active })
  }

  equip(itemType: number, slot: EquipSlot): Promise<void> {
    if (this.failEquip !== undefined) return Promise.reject(this.failEquip)
    this.equipped.push({ itemType, slot })
    return Promise.resolve()
  }

  /** How much the food bar goes up per bite. */
  foodPerConsume = 0

  consume(): Promise<void> {
    if (this.failConsume !== undefined) return Promise.reject(this.failConsume)
    this.consumeCalls += 1
    this.food = Math.min(20, this.food + this.foodPerConsume)
    return Promise.resolve()
  }

  /** Takes an entity out of the world (it died or left). */
  removeEntity(id: number): void {
    this.entities = Object.fromEntries(
      Object.entries(this.entities).filter(([key]) => key !== String(id)),
    )
  }

  /** Runs on every hit, so a test can let the target die (call `removeEntity`). */
  onAttack: (entity: EntityLike) => void = () => undefined

  attack(entity: EntityLike): void {
    this.attacked.push(entity.id)
    this.onAttack(entity)
  }

  findBlocks(options: {
    matching: number | number[]
    maxDistance: number
    count: number
  }): readonly Position[] {
    const origin = this.entity?.position
    if (origin === undefined) return []
    const ids = new Set(Array.isArray(options.matching) ? options.matching : [options.matching])
    const found: { position: Position; distance: number }[] = []
    for (const [coordinates, name] of this.blocks) {
      if (!ids.has(this.registry.blocksByName[name]?.id ?? -1)) continue
      const [x = 0, y = 0, z = 0] = coordinates.split(',').map(Number)
      const distance = Math.hypot(x - origin.x, y - origin.y, z - origin.z)
      if (distance <= options.maxDistance) found.push({ position: { x, y, z }, distance })
    }
    return found
      .sort((a, b) => a.distance - b.distance)
      .slice(0, options.count)
      .map((f) => f.position)
  }

  clearControlStates(): void {
    this.clearControlStatesCalls += 1
  }

  chat(message: string): void {
    this.chatLog.push(message)
  }

  whisper(player: string, text: string): void {
    this.whisperLog.push({ player, text })
  }

  quit(): void {
    this.quitCalls += 1
    if (this.endOnQuit) this.emit('end', 'quit')
  }

  on<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.on(event, listener)
    return this
  }

  once<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.once(event, listener)
    return this
  }

  removeListener<E extends keyof BotEvents>(event: E, listener: BotEvents[E]): this {
    this.emitter.removeListener(event, listener)
    return this
  }

  emit<E extends keyof BotEvents>(event: E, ...args: Parameters<BotEvents[E]>): void {
    this.emitter.emit(event, ...args)
  }

  listenerCount(event: keyof BotEvents): number {
    return this.emitter.listenerCount(event)
  }
}
