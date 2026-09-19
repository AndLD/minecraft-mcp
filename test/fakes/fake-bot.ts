import { EventEmitter } from 'node:events'
import minecraftData from 'minecraft-data'
import prismarineRecipe from 'prismarine-recipe'
import { FakeContainerWindow } from './container-window-fake.js'
import type { ContainerWindowLike } from '../../src/bot/window-transfer.js'
import type {
  BlockLike,
  BotEvents,
  BotLike,
  EntityLike,
  EquipSlot,
  FurnaceLike,
  ItemLike,
  PathfinderLike,
  PlayerLike,
  RecipeLike,
} from '../../src/bot/bot-like.types.js'
import type { Position } from '../../src/core/position.types.js'

/** A pathfinder whose movements finish only when the test says so, and which behaves like the real plugin. */
export class FakePathfinder implements PathfinderLike {
  readonly gotoGoals: unknown[] = []
  readonly followGoals: { goal: unknown; dynamic: boolean | undefined }[] = []
  /** How many times movement was halted with `setGoal(null)`. */
  stopCalls = 0
  private pending: { resolve: () => void; reject: (error: Error) => void }[] = []
  /** When set, trips finish at once: this moves the bot to the goal. */
  onGoto: ((goal: unknown) => void) | undefined

  goto(goal: unknown): Promise<void> {
    this.gotoGoals.push(goal)
    if (this.onGoto !== undefined) {
      this.onGoto(goal)
      return Promise.resolve()
    }
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

interface RecipeFactory {
  find(itemType: number, metadata: number | null): RecipeLike[]
}

const key = (p: Position): string =>
  `${String(Math.floor(p.x))},${String(Math.floor(p.y))},${String(Math.floor(p.z))}`

/** A block the fake world knows, with where it is (the real Mineflayer block has a position too). */
export interface FakeBlock extends BlockLike {
  readonly position: Position
}

/** The metadata keys the game data lists for an ageable animal (`baby` is index 16). */
export const ANIMAL_KEYS = [
  'shared_flags',
  'air_supply',
  'custom_name',
  'custom_name_visible',
  'silent',
  'no_gravity',
  'pose',
  'ticks_frozen',
  'living_entity_flags',
  'health',
  'effect_particles',
  'effect_ambience',
  'arrow_count',
  'stinger_count',
  'sleeping_pos',
  'mob_flags',
  'baby',
]

const SMELT_MS_PER_ITEM = 10_000
const FUEL_ITEMS_PER_UNIT: Record<string, number> = {
  coal: 8,
  charcoal: 8,
  oak_planks: 1.5,
  oak_log: 1.5,
  stick: 0.5,
}
const SMELTS_TO: Record<string, string> = {
  raw_iron: 'iron_ingot',
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  iron_ore: 'iron_ingot',
  oak_log: 'charcoal',
  sand: 'glass',
  cobblestone: 'stone',
}
const STACK_SIZE = 64

/** A furnace that smelts as time passes (read from the injected clock), like the real one. */
export class FakeFurnace implements FurnaceLike {
  input: ItemLike | null = null
  fuelSlot: ItemLike | null = null
  output: ItemLike | null = null
  closed = false
  private burnLeftMs = 0
  private progressMs = 0
  private lastUpdate: number

  constructor(
    private readonly bot: FakeBot,
    private readonly now: () => number,
  ) {
    this.lastUpdate = now()
  }

  get fuel(): number {
    this.catchUp()
    return this.burnLeftMs > 0 ? 1 : 0
  }

  inputItem(): ItemLike | null {
    this.catchUp()
    return this.input
  }

  fuelItem(): ItemLike | null {
    this.catchUp()
    return this.fuelSlot
  }

  outputItem(): ItemLike | null {
    this.catchUp()
    return this.output
  }

  putInput(itemType: number, _metadata: number | null, count: number): Promise<void> {
    this.catchUp()
    const name = this.bot.nameOf(itemType)
    this.bot.removeItems(name, count)
    this.input = { name, count: (this.input?.count ?? 0) + count }
    return Promise.resolve()
  }

  putFuel(itemType: number, _metadata: number | null, count: number): Promise<void> {
    this.catchUp()
    const name = this.bot.nameOf(itemType)
    this.bot.removeItems(name, count)
    this.fuelSlot = { name, count: (this.fuelSlot?.count ?? 0) + count }
    return Promise.resolve()
  }

  takeInput(): Promise<ItemLike | null> {
    this.catchUp()
    return Promise.resolve(this.emptyInto('input'))
  }

  takeFuel(): Promise<ItemLike | null> {
    this.catchUp()
    return Promise.resolve(this.emptyInto('fuelSlot'))
  }

  takeOutput(): Promise<ItemLike | null> {
    this.catchUp()
    return Promise.resolve(this.emptyInto('output'))
  }

  close(): void {
    this.closed = true
  }

  private emptyInto(slot: 'input' | 'fuelSlot' | 'output'): ItemLike | null {
    const item = this[slot]
    if (item === null) return null
    this[slot] = null
    this.bot.addItems(item.name, item.count)
    return item
  }

  /** Plays out the time since the last look, item by item. */
  private catchUp(): void {
    let remaining = this.now() - this.lastUpdate
    this.lastUpdate = this.now()
    while (remaining > 0) {
      if (this.input === null || SMELTS_TO[this.input.name] === undefined) return
      if (this.burnLeftMs <= 0) {
        if (this.fuelSlot === null) return
        const perUnit = FUEL_ITEMS_PER_UNIT[this.fuelSlot.name] ?? 1
        this.burnLeftMs = perUnit * SMELT_MS_PER_ITEM
        this.fuelSlot =
          this.fuelSlot.count > 1 ? { ...this.fuelSlot, count: this.fuelSlot.count - 1 } : null
      }
      const step = Math.min(remaining, this.burnLeftMs, SMELT_MS_PER_ITEM - this.progressMs)
      this.burnLeftMs -= step
      this.progressMs += step
      remaining -= step
      if (this.progressMs >= SMELT_MS_PER_ITEM) {
        this.progressMs = 0
        const made = SMELTS_TO[this.input.name] ?? ''
        this.output = { name: made, count: (this.output?.count ?? 0) + 1 }
        this.input = this.input.count > 1 ? { ...this.input, count: this.input.count - 1 } : null
      }
    }
  }
}

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
  /** What a ray hits; tests set it (or leave null for "nothing"). */
  rayHit: { name: string; position: Position } | null = null
  readonly rays: { from: Position; direction: Position; range: number }[] = []
  world = {
    raycast: (
      from: Position,
      direction: Position,
      range: number,
    ): { name: string; position: Position } | null => {
      this.rays.push({ from, direction, range })
      return this.rayHit
    },
  }
  registry = {
    blocksByName: {
      air: { id: 0 },
      stone: { id: 1 },
      dirt: { id: 2 },
      oak_log: { id: 3 },
      iron_ore: { id: 4 },
      crafting_table: { id: 5 },
    },
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
      shield: { id: 130 },
    },
    foodsByName: {
      cooked_beef: { foodPoints: 8, saturation: 12.8 },
      bread: { foodPoints: 5, saturation: 6 },
      apple: { foodPoints: 4, saturation: 2.4 },
      rotten_flesh: { foodPoints: 4, saturation: 0.8 },
      golden_apple: { foodPoints: 4, saturation: 9.6 },
    },
    items: {},
    recipes: {},
    entitiesByName: {
      cow: { metadataKeys: ANIMAL_KEYS },
      sheep: { metadataKeys: [...ANIMAL_KEYS, 'wool'] },
      pig: { metadataKeys: [...ANIMAL_KEYS, 'saddle'] },
      wolf: { metadataKeys: [...ANIMAL_KEYS, 'flags', 'owneruuid'] },
    },
  } as BotLike['registry']
  inventoryItems: ItemLike[] = []
  emptySlots = 36
  heldItem: ItemLike | null = null
  readonly pathfinder = new FakePathfinder()
  clearControlStatesCalls = 0
  /** The block world, by integer coordinates. Unknown positions are unloaded (null). */
  private readonly blocks = new Map<string, string>()
  /** Armor slots are 5 (head), 6 (torso), 7 (legs), 8 (feet). */
  slots: (ItemLike | null)[] = Array.from({ length: 46 }, () => null)
  /** When set, free slots are worked out from the stacks (64 per slot) instead of `emptySlots`. */
  slotLimit: number | undefined
  private readonly inventoryEmitter = new EventEmitter()
  /** Tells listeners a slot changed, as Mineflayer's window does. */
  inventoryChanged(): void {
    this.inventoryEmitter.emit('updateSlot')
  }
  inventory = ((owner: FakeBot) => ({
    on: (_event: 'updateSlot', listener: () => void): unknown =>
      owner.inventoryEmitter.on('updateSlot', listener),
    removeListener: (_event: 'updateSlot', listener: () => void): unknown =>
      owner.inventoryEmitter.removeListener('updateSlot', listener),
    listenerCount: (): number => owner.inventoryEmitter.listenerCount('updateSlot'),
    items: (): readonly ItemLike[] => owner.inventoryItems,
    emptySlotCount: (): number =>
      owner.slotLimit === undefined
        ? owner.emptySlots
        : owner.slotLimit -
          owner.inventoryItems.reduce((sum, item) => sum + Math.ceil(item.count / STACK_SIZE), 0),
    /** Armor and off hand (set through `slots`), plus the carried items from slot 9 on, like the real window. */
    get slots(): (ItemLike | null)[] {
      const merged = [...owner.slots]
      owner.inventoryItems.forEach((item, index) => {
        merged[9 + index] ??= item
      })
      return merged
    },
  }))(this)
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

  blockAt(position: Position): FakeBlock | null {
    // The real world lookup calls `position.floored()`: a plain { x, y, z } crashes it.
    if (typeof (position as { floored?: unknown }).floored !== 'function')
      throw new TypeError('pos.floored is not a function')
    const name = this.blocks.get(key(position))
    if (name === undefined) return null
    return {
      name,
      boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block',
      position: {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      },
    }
  }

  /** Time source for furnaces; tests point it at their fake clock. */
  now: () => number = () => 0

  /**
   * Switches to the real Minecraft 1.21.1 data (blocks, items, recipes), so gathering and crafting are tested
   * against the game's own rules, and lets the bot walk anywhere instantly (picking up drops on the way).
   */
  useGameData(): this {
    const data = minecraftData('1.21.1')
    this.registry = data
    // The loader accepts a registry as well as a version string, which its typings do not say.
    const load = prismarineRecipe as unknown as (registry: unknown) => { Recipe: RecipeFactory }
    this.recipeFactory = load(data).Recipe
    this.slotLimit = 36
    // Trips end a little short of the goal (80% of its range, along the line from where the bot was), like real ones.
    this.pathfinder.onGoto = (goal) => {
      const near = goal as { x?: number; y?: number; z?: number; range?: number } | undefined
      if (near?.x === undefined || near.y === undefined || near.z === undefined) return
      // Like the real GoalNear, the goal is the block cell containing the coordinates.
      const center = {
        x: Math.floor(near.x) + 0.5,
        y: Math.floor(near.y),
        z: Math.floor(near.z) + 0.5,
      }
      const from = this.entity?.position ?? center
      const stop = (near.range ?? 1) * 0.8
      const dx = from.x - center.x
      const dz = from.z - center.z
      const away = Math.hypot(dx, dz)
      if (away <= stop) {
        this.pickUpNearby() // already there: anything lying next to the bot is picked up
        return
      }
      this.moveTo({
        x: center.x + (dx / away) * stop,
        y: Math.min(from.y, center.y),
        z: center.z + (dz / away) * stop,
      })
    }
    return this
  }

  private recipeFactory: RecipeFactory | undefined
  private nextEntityId = 1000
  readonly furnaces = new Map<string, FakeFurnace>()
  readonly placed: { name: string; position: Position }[] = []
  readonly dug: { name: string; position: Position }[] = []
  /** The drops a block leaves when dug with a fitting tool; blocks not listed drop themselves. */
  drops: Record<string, string> = {
    stone: 'cobblestone',
    iron_ore: 'raw_iron',
    deepslate_iron_ore: 'raw_iron',
  }
  digFailure: Error | undefined
  /** Makes `dig` wait until the test calls `finishDig` (or `stopDigging` cancels it). */
  holdDigs = false
  private heldDig: { resolve: () => void; reject: (error: Error) => void } | undefined
  stopDiggingCalls = 0

  nameOf(itemType: number): string {
    const found = Object.entries(this.registry.itemsByName).find(([, item]) => item.id === itemType)
    if (found === undefined) throw new Error(`Unknown item id ${String(itemType)}`)
    return found[0]
  }

  count(name: string): number {
    return this.inventoryItems.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0)
  }

  addItems(name: string, count: number): void {
    const existing = this.inventoryItems.find((item) => item.name === name)
    if (existing === undefined) this.inventoryItems = [...this.inventoryItems, { name, count }]
    else
      this.inventoryItems = this.inventoryItems.map((item) =>
        item === existing ? { name, count: item.count + count } : item,
      )
  }

  removeItems(name: string, count: number): void {
    if (this.count(name) < count) throw new Error(`Not enough ${name}`)
    this.inventoryItems = this.inventoryItems
      .map((item) =>
        item.name === name ? { name, count: item.count - Math.min(count, item.count) } : item,
      )
      .filter((item) => item.count > 0)
  }

  /** Moves the bot and picks up any dropped items it lands next to. */
  moveTo(position: Position): void {
    this.entity = { position }
    this.pickUpNearby()
  }

  /** Items within reach of the bot are picked up, as the game does when they lie next to it. */
  pickUpNearby(): void {
    const position = this.entity?.position
    if (position === undefined) return
    for (const [id, entity] of Object.entries(this.entities)) {
      if (entity.name !== 'item') continue
      if (
        Math.hypot(
          entity.position.x - position.x,
          entity.position.y - position.y,
          entity.position.z - position.z,
        ) > 1.5
      )
        continue
      const stack = entity.getDroppedItem?.()
      if (stack === undefined || stack === null) continue
      if (
        this.slotLimit !== undefined &&
        this.inventory.emptySlotCount() <= 0 &&
        this.count(stack.name) % STACK_SIZE === 0
      )
        continue
      this.addItems(stack.name, stack.count)
      this.removeEntity(Number(id))
    }
  }

  /** Puts an item on the ground. */
  dropItem(name: string, count: number, position: Position): number {
    const id = this.nextEntityId
    this.nextEntityId += 1
    this.entities[String(id)] = {
      id,
      type: 'other',
      name: 'item',
      position,
      getDroppedItem: () => ({ name, count }),
    }
    return id
  }

  dig(block: BlockLike): Promise<void> {
    const at = (block as FakeBlock).position
    if (this.digFailure !== undefined) return Promise.reject(this.digFailure)
    const finish = (): void => {
      this.dug.push({ name: block.name, position: at })
      this.setBlock(at, 'air')
      const data = this.registry.blocksByName[block.name]
      const harvestable =
        data?.harvestTools === undefined ||
        (this.heldItem !== null &&
          data.harvestTools[this.registry.itemsByName[this.heldItem.name]?.id ?? -1] === true)
      if (harvestable)
        this.dropItem(this.drops[block.name] ?? block.name, 1, {
          x: at.x + 0.5,
          y: this.groundLevel(at) + 0.3,
          z: at.z + 0.5,
        })
    }
    if (!this.holdDigs) {
      finish()
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.heldDig = {
        resolve: () => {
          finish()
          resolve()
        },
        reject,
      }
    })
  }

  /** Where a drop lands: it falls until a solid block is below it. */
  private groundLevel(from: Position): number {
    let y = from.y
    const isSolid = (cell: Position): boolean => {
      const name = this.blocks.get(key(cell))
      return name !== undefined && !['air', 'cave_air', 'water', 'lava'].includes(name)
    }
    while (y > -64 && !isSolid({ x: from.x, y: y - 1, z: from.z })) y -= 1
    return y
  }

  /** Completes a held dig. */
  finishDig(): void {
    this.heldDig?.resolve()
    this.heldDig = undefined
  }

  stopDigging(): void {
    this.stopDiggingCalls += 1
    this.heldDig?.reject(new Error('Digging aborted'))
    this.heldDig = undefined
  }

  placeBlock(reference: BlockLike, face: Position): Promise<void> {
    const base = (reference as FakeBlock).position
    const target = { x: base.x + face.x, y: base.y + face.y, z: base.z + face.z }
    const name = this.heldItem?.name
    if (name === undefined) return Promise.reject(new Error('Nothing in hand'))
    this.removeItems(name, 1)
    this.heldItem = this.count(name) > 0 ? { name, count: this.count(name) } : null
    this.setBlock(target, name)
    this.placed.push({ name, position: target })
    return Promise.resolve()
  }

  /** Container contents by block cell; each is the container's slot list. */
  readonly containers = new Map<string, (ItemLike | null)[]>()
  /** Slots per container (27 for a chest, 54 for a double chest). */
  containerSlots = 27
  readonly openedContainers: string[] = []
  windows: FakeContainerWindow[] = []

  /** Puts items into the container at a position, opening no window. */
  stock(position: Position, name: string, count: number): void {
    const slots = this.slotsAt(position)
    let left = count
    for (let i = 0; i < slots.length && left > 0; i += 1) {
      if (slots[i] !== null) continue
      const put = Math.min(left, name === 'ender_pearl' ? 16 : 64)
      slots[i] = { name, count: put }
      left -= put
    }
  }

  /** How many of an item are in the container at a position. */
  inContainer(position: Position, name: string): number {
    return this.slotsAt(position)
      .filter((item) => item?.name === name)
      .reduce((sum, item) => sum + (item?.count ?? 0), 0)
  }

  private slotsAt(position: Position): (ItemLike | null)[] {
    const id = key(position)
    let slots = this.containers.get(id)
    if (slots === undefined) {
      slots = Array.from({ length: this.containerSlots }, () => null)
      this.containers.set(id, slots)
    }
    return slots
  }

  /** What the bot threw on the ground, in order. */
  readonly tossed: { name: string; count: number }[] = []
  readonly lookedAt: Position[] = []
  /** The bot's own inventory as a window (slots 0-35 are the player's; a real one starts at 9). */
  get inventoryWindow(): ContainerWindowLike {
    return new FakeContainerWindow(
      [],
      this.inventoryItems,
      (_container, player) => {
        this.inventoryItems = player
      },
      (name, count) => {
        this.tossed.push({ name, count })
        const here = this.entity?.position ?? { x: 0, y: 64, z: 0 }
        this.dropItem(name, count, { x: here.x + 1, y: here.y + 0.3, z: here.z })
      },
    )
  }

  waitedTicks = 0

  waitForTicks(ticks: number): Promise<void> {
    this.waitedTicks += ticks
    return Promise.resolve()
  }

  lookAt(point: Position): Promise<void> {
    this.lookedAt.push(point)
    return Promise.resolve()
  }

  openContainerWindow(block: BlockLike): Promise<ContainerWindowLike> {
    const at = (block as FakeBlock).position
    this.openedContainers.push(key(at))
    const window = new FakeContainerWindow(
      this.slotsAt(at),
      this.inventoryItems,
      (container, player) => {
        this.containers.set(key(at), container)
        this.inventoryItems = player
      },
    )
    this.windows.push(window)
    return Promise.resolve(window)
  }

  openFurnace(block: BlockLike): Promise<FurnaceLike> {
    const at = (block as FakeBlock).position
    const id = key(at)
    const furnace = this.furnaces.get(id) ?? new FakeFurnace(this, () => this.now())
    furnace.closed = false
    this.furnaces.set(id, furnace)
    return Promise.resolve(furnace)
  }

  recipesAll(
    itemType: number,
    _metadata: number | null,
    craftingTable: boolean,
  ): readonly RecipeLike[] {
    const factory = this.recipeFactory
    if (factory === undefined) return []
    return factory.find(itemType, null).filter((recipe) => !recipe.requiresTable || craftingTable)
  }

  readonly crafted: { item: string; times: number }[] = []

  craft(recipe: RecipeLike, count: number, craftingTable?: BlockLike | null): Promise<void> {
    if (recipe.requiresTable && (craftingTable === undefined || craftingTable === null))
      return Promise.reject(new Error('A crafting table is required'))
    for (const entry of recipe.delta) {
      if (entry.count < 0 && this.count(this.nameOf(entry.id)) < -entry.count * count)
        return Promise.reject(new Error(`missing ingredient ${this.nameOf(entry.id)}`))
    }
    for (const entry of recipe.delta) {
      if (entry.count < 0) this.removeItems(this.nameOf(entry.id), -entry.count * count)
    }
    this.addItems(this.nameOf(recipe.result.id), recipe.result.count * count)
    this.crafted.push({ item: this.nameOf(recipe.result.id), times: count })
    return Promise.resolve()
  }

  setControlState(control: 'jump' | 'sprint', active: boolean): void {
    this.controlStates.push({ control, active })
  }

  equip(itemType: number, slot: EquipSlot): Promise<void> {
    if (this.failEquip !== undefined) return Promise.reject(this.failEquip)
    this.equipped.push({ itemType, slot })
    if (slot === 'hand') {
      const name = Object.entries(this.registry.itemsByName).find(
        ([, item]) => item.id === itemType,
      )?.[0]
      const held = this.inventoryItems.find((item) => item.name === name)
      if (held !== undefined) this.heldItem = held
    }
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
