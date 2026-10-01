import type { AreaGuard, ProtectedArea } from '../../src/core/area-guard.port.js'
import type { DigAssessment, DigFailure, Digger } from '../../src/core/digger.port.js'
import type { DroppedItem, DroppedItemScanner } from '../../src/core/dropped-items.port.js'
import type { FurnaceAccess, FurnaceContents, FurnaceSession } from '../../src/core/furnace.port.js'
import type { ItemStackInfo } from '../../src/core/inventory.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import type { PlaceFailure, Placer } from '../../src/core/placer.port.js'
import type { Position } from '../../src/core/position.types.js'
import type {
  CraftFailure,
  Crafter,
  ItemCount,
  Recipe,
  RecipeBook,
} from '../../src/core/recipes.port.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Scheduler } from '../../src/core/scheduler.port.js'
import type { SkillContext } from '../../src/core/skill.types.js'
import type { FakeClock } from './fake-clock.js'

/** A scheduler that lets time pass at once: the clock jumps by the delay and the callback runs on the next tick. */
export class AutoScheduler implements Scheduler {
  constructor(private readonly clock: FakeClock) {}

  after(delayMs: number, callback: () => void): () => void {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      this.clock.advance(delayMs)
      callback()
    })
    return () => {
      cancelled = true
    }
  }
}

export interface Trip {
  readonly target: Position
  readonly within: number
}

/** Walks anywhere at once (unless told to fail) and records where it went. */
export class InstantNavigator implements Navigator {
  readonly trips: Trip[] = []
  /** Failures to hand out for the next trips, in order; `undefined` lets a trip succeed. */
  failures: (NavigationFailure | undefined)[] = []
  /** Called after every successful trip. */
  onArrive: (target: Position) => void = () => undefined

  goToPosition(
    target: Position,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.trips.push({ target, within })
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.failures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    this.onArrive(target)
    return Promise.resolve(ok(target))
  }

  /** Where the players are; a player not listed cannot be found. */
  readonly players = new Map<string, Position>()
  readonly playerTrips: { player: string; within: number }[] = []
  /** Failures to hand out for the next trips to a player, in order; `undefined` lets a trip succeed. */
  playerFailures: (NavigationFailure | undefined)[] = []

  goToPlayer(
    player: string,
    within: number,
    options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.playerTrips.push({ player, within })
    if (options.signal.aborted)
      return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.playerFailures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    const where = this.players.get(player)
    if (where === undefined)
      return Promise.resolve(
        err({ reason: 'target_not_found', message: `${player} is not in view.` }),
      )
    // The bot stops `within` blocks short of the player, on the side it came from.
    const arrival = { x: where.x - within, y: where.y, z: where.z }
    this.onArrive(arrival)
    return Promise.resolve(ok(arrival))
  }

  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

export const assessment = (overrides: Partial<DigAssessment> = {}): DigAssessment => ({
  blockName: 'oak_log',
  diggable: true,
  requiredTools: [],
  canHarvest: true,
  tool: undefined,
  ...overrides,
})

const keyOf = (position: Position): string =>
  `${String(position.x)},${String(position.y)},${String(position.z)}`

export class FakeDigger implements Digger {
  readonly dug: Position[] = []
  /** What `assess` answers, by block name; any other block is an easy one. */
  assessments = new Map<string, DigAssessment>()
  private readonly names = new Map<string, string>()
  /** Results for the next digs, in order; `undefined` lets a dig succeed. */
  failures: (DigFailure | undefined)[] = []
  onDug: (position: Position) => void = () => undefined

  nameAt(position: Position, name: string): void {
    this.names.set(keyOf(position), name)
  }

  assess(position: Position): DigAssessment | undefined {
    const name = this.names.get(keyOf(position)) ?? 'oak_log'
    return this.assessments.get(name) ?? assessment({ blockName: name })
  }

  dig(position: Position, signal: AbortSignal): Promise<Result<void, DigFailure>> {
    if (signal.aborted) return Promise.resolve(err({ reason: 'aborted', message: 'Cancelled.' }))
    const failure = this.failures.shift()
    if (failure !== undefined) return Promise.resolve(err(failure))
    this.dug.push(position)
    this.onDug(position)
    return Promise.resolve(ok(undefined))
  }
}

export class FakeDroppedItems implements DroppedItemScanner {
  items: DroppedItem[] = []
  private nextId = 500

  nearby(maxDistance: number): readonly DroppedItem[] {
    return this.items
      .filter((item) => item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
  }

  drop(name: string, position: Position, distance = 2, count = 1): number {
    const entityId = this.nextId
    this.nextId += 1
    this.items = [...this.items, { entityId, name, count, position, distance }]
    return entityId
  }

  remove(entityId: number): void {
    this.items = this.items.filter((item) => item.entityId !== entityId)
  }
}

export class FakeAreaGuard implements AreaGuard {
  private readonly areas: { label: string; contains: (position: Position) => boolean }[] = []

  protect(label: string, contains: (position: Position) => boolean): void {
    this.areas.push({ label, contains })
  }

  protectedAt(position: Position): ProtectedArea | undefined {
    const area = this.areas.find((candidate) => candidate.contains(position))
    return area === undefined ? undefined : { id: 'area-1', label: area.label }
  }
}

export const recipe = (
  result: ItemCount,
  ingredients: readonly ItemCount[],
  index = 0,
  needsTable = false,
): Recipe => ({ result, ingredients, needsTable, index })

/** Recipes from a table, and a crafter that only records what it was asked to do. */
export class FakeRecipeBook implements RecipeBook, Crafter {
  readonly crafted: {
    item: string
    recipeIndex: number
    times: number
    table: Position | undefined
  }[] = []
  failure: CraftFailure | undefined
  /** Fails this many of the next crafts, then works again. */
  transientFailures = 0
  onCraft: (item: string, recipe: Recipe, times: number) => void = () => undefined

  constructor(private readonly table: Record<string, readonly Recipe[]>) {}

  recipesFor(item: string): readonly Recipe[] {
    return this.table[item] ?? []
  }

  craftableItems(): readonly string[] {
    return Object.keys(this.table)
  }

  isItem(name: string): boolean {
    return (
      name in this.table ||
      Object.values(this.table).some((recipes) =>
        recipes.some((r) => r.ingredients.some((i) => i.name === name)),
      )
    )
  }

  craft(
    item: string,
    recipeIndex: number,
    times: number,
    table: Position | undefined,
  ): Promise<Result<void, CraftFailure>> {
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    if (this.transientFailures > 0) {
      this.transientFailures -= 1
      return Promise.resolve(err({ reason: 'failed', message: 'missing ingredient' }))
    }
    this.crafted.push({ item, recipeIndex, times, table })
    const found = this.recipesFor(item)[recipeIndex]
    if (found !== undefined) this.onCraft(item, found, times)
    return Promise.resolve(ok(undefined))
  }
}

export class FakePlacer implements Placer {
  readonly placed: { item: string; target: Position }[] = []
  failure: PlaceFailure | undefined
  onPlace: (item: string, target: Position) => void = () => undefined

  placeAt(item: string, target: Position): Promise<Result<void, PlaceFailure>> {
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.placed.push({ item, target })
    this.onPlace(item, target)
    return Promise.resolve(ok(undefined))
  }

  readonly placedAgainst: { item: string; reference: Position; face: Position }[] = []

  placeAgainst(
    item: string,
    reference: Position,
    face: Position,
  ): Promise<Result<void, PlaceFailure>> {
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.placedAgainst.push({ item, reference, face })
    return Promise.resolve(ok(undefined))
  }
}

/** A furnace session whose slots the test controls directly. */
export class FakeFurnaceSession implements FurnaceSession {
  input: ItemStackInfo | undefined
  fuel: ItemStackInfo | undefined
  output: ItemStackInfo | undefined
  burning = false
  closed = false
  /** How often the window was closed, and how often it was read while closed (which the game would not allow). */
  closes = 0
  readsWhileClosed = 0
  readonly log: string[] = []
  /** Runs before every `contents()` call, so a test can advance the smelting. */
  onLook: () => void = () => undefined
  failPutFuel: Error | undefined

  contents(): FurnaceContents {
    if (this.closed) this.readsWhileClosed += 1
    this.onLook()
    return { input: this.input, fuel: this.fuel, output: this.output, burning: this.burning }
  }

  putInput(item: string, count: number): Promise<void> {
    this.log.push(`input ${item} ${String(count)}`)
    this.input = { name: item, count: (this.input?.count ?? 0) + count }
    return Promise.resolve()
  }

  putFuel(item: string, count: number): Promise<void> {
    if (this.failPutFuel !== undefined) return Promise.reject(this.failPutFuel)
    this.log.push(`fuel ${item} ${String(count)}`)
    this.fuel = { name: item, count }
    this.burning = true
    return Promise.resolve()
  }

  takeInput(): Promise<ItemStackInfo | undefined> {
    return Promise.resolve(this.empty('input'))
  }

  takeFuel(): Promise<ItemStackInfo | undefined> {
    return Promise.resolve(this.empty('fuel'))
  }

  takeOutput(): Promise<ItemStackInfo | undefined> {
    return Promise.resolve(this.empty('output'))
  }

  close(): Promise<void> {
    this.closed = true
    this.closes += 1
    return Promise.resolve()
  }

  private empty(slot: 'input' | 'fuel' | 'output'): ItemStackInfo | undefined {
    const taken = this[slot]
    this[slot] = undefined
    if (taken !== undefined) this.log.push(`took ${slot} ${taken.name} ${String(taken.count)}`)
    return taken
  }
}

export class FakeFurnaceAccess implements FurnaceAccess {
  readonly session = new FakeFurnaceSession()
  readonly opened: Position[] = []
  failure: string | undefined

  open(position: Position): Promise<Result<FurnaceSession>> {
    this.opened.push(position)
    if (this.failure !== undefined) return Promise.resolve(err(this.failure))
    this.session.closed = false
    return Promise.resolve(ok(this.session))
  }
}

/** A skill context that records progress and lets the test abort. */
export function skillContext(): {
  context: SkillContext
  controller: AbortController
  progress: string[]
} {
  const controller = new AbortController()
  const progress: string[] = []
  return {
    context: {
      signal: controller.signal,
      progress: (message) => {
        progress.push(message)
      },
    },
    controller,
    progress,
  }
}
