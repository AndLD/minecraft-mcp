import type {
  AttackOutcome,
  Combatant,
  CombatFailure,
  GearReport,
} from '../../src/core/combatant.port.js'
import type { EntityInfo } from '../../src/core/entity-scanner.port.js'
import type { Eater, FoodCatalog, FoodInfo } from '../../src/core/food.port.js'
import type { Locomotion } from '../../src/core/locomotion.port.js'
import type {
  NavigationFailure,
  NavigationOptions,
  Navigator,
} from '../../src/core/navigator.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { ReflexContext, ReflexState } from '../../src/reflexes/reflex.types.js'
import { buildVitals } from './fake-ports.js'

let nextId = 1

/** A nearby entity at `distance` blocks in front of the bot (which stands at the origin). */
export function entity(
  name: string,
  distance = 5,
  overrides: Partial<EntityInfo> = {},
): EntityInfo {
  nextId += 1
  return {
    id: nextId,
    category: 'hostile',
    name,
    position: { x: distance, y: 64, z: 0 },
    distance,
    ...overrides,
  }
}

export function reflexState(
  overrides: Partial<ReflexState> & { health?: number; food?: number } = {},
): ReflexState {
  const { health, food, ...rest } = overrides
  return {
    vitals: buildVitals({
      ...(health === undefined ? {} : { health }),
      ...(food === undefined ? {} : { food }),
      ...(rest.vitals ?? {}),
    }),
    entities: [],
    now: 0,
    ...rest,
  }
}

/** A reflex context for unit tests: sleeps do not wait, and `state()` walks through the given readings. */
export class FakeReflexContext implements ReflexContext {
  readonly controller = new AbortController()
  readonly emitted: string[] = []
  readonly sleeps: number[] = []
  private readings: (ReflexState | undefined)[]

  constructor(readings: (ReflexState | undefined)[] = []) {
    this.readings = [...readings]
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  emit(message: string): void {
    this.emitted.push(message)
  }

  /** The next reading; the last one repeats when they run out. */
  state(): ReflexState | undefined {
    return this.readings.length > 1 ? this.readings.shift() : this.readings[0]
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    return Promise.resolve()
  }

  withTimeout(): { readonly signal: AbortSignal; dispose(): void } {
    return { signal: new AbortController().signal, dispose: () => undefined }
  }
}

export class FakeCombatant implements Combatant {
  readonly attacks: number[] = []
  gearCalls = 0
  gear: GearReport = { weapon: 'iron_sword', armor: [] }
  /** Results handed out in order; when empty, `target_gone`. */
  results: Result<AttackOutcome, CombatFailure>[] = []
  /** Runs when an attack starts, so a test can change the world. */
  onAttack: (entityId: number) => void = () => undefined

  equipBestGear(): Promise<GearReport> {
    this.gearCalls += 1
    return Promise.resolve(this.gear)
  }

  attack(entityId: number): Promise<Result<AttackOutcome, CombatFailure>> {
    this.attacks.push(entityId)
    this.onAttack(entityId)
    return Promise.resolve(this.results.shift() ?? ok('target_gone'))
  }
}

/** A navigator whose trips end at once. */
export class InstantNavigator implements Navigator {
  readonly goTos: { target: Position; within: number }[] = []
  result: Result<Position, NavigationFailure> = ok({ x: 0, y: 64, z: 0 })
  onGoTo: (target: Position) => void = () => undefined

  goToPosition(
    target: Position,
    within: number,
    _options: NavigationOptions,
  ): Promise<Result<Position, NavigationFailure>> {
    this.goTos.push({ target, within })
    this.onGoTo(target)
    return Promise.resolve(this.result)
  }

  goToPlayer(): Promise<Result<Position, NavigationFailure>> {
    return Promise.resolve(err({ reason: 'target_not_found', message: 'unused' }))
  }

  follow(): Promise<Result<void, NavigationFailure>> {
    return Promise.resolve(ok(undefined))
  }
}

export class FakeLocomotion implements Locomotion {
  readonly jumps: boolean[] = []

  setJump(active: boolean): void {
    this.jumps.push(active)
  }
}

export class FakeEater implements Eater {
  readonly eaten: string[] = []
  result: Result<void> = ok(undefined)

  eat(item: string): Promise<Result<void>> {
    this.eaten.push(item)
    return Promise.resolve(this.result)
  }
}

export class FakeFoodCatalog implements FoodCatalog {
  constructor(
    private readonly foods: Readonly<Record<string, { foodPoints: number; saturation: number }>> = {
      cooked_beef: { foodPoints: 8, saturation: 12.8 },
      bread: { foodPoints: 5, saturation: 6 },
      apple: { foodPoints: 4, saturation: 2.4 },
      rotten_flesh: { foodPoints: 4, saturation: 0.8 },
      golden_apple: { foodPoints: 4, saturation: 9.6 },
    },
  ) {}

  info(item: string): FoodInfo | undefined {
    const food = this.foods[item]
    return food === undefined ? undefined : { name: item, ...food }
  }
}
