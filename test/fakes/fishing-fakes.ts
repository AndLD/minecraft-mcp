import type { FishFailure, Fisher } from '../../src/core/fisher.port.js'
import type { Gaze } from '../../src/core/gaze.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { Scheduler } from '../../src/core/scheduler.port.js'
import type { FakeClock } from './fake-clock.js'
import { FakeInventory } from './fake-ports.js'
import { GroveWorld } from './grove-fakes.js'

export const GROUND = 64
export const at = (x: number, y: number, z: number): Position => ({ x, y, z })

/**
 * Short waits (the settle after a catch) pass at once. A wait of a minute or more (the bite timeout) passes only
 * when a test calls `expire`, so a cast that never bites can be told apart from one that does.
 */
export class FishingScheduler implements Scheduler {
  private readonly long = new Set<() => void>()

  constructor(private readonly clock: FakeClock) {}

  after(delayMs: number, callback: () => void): () => void {
    if (delayMs >= 60_000) {
      const fire = (): void => {
        this.clock.advance(delayMs)
        callback()
      }
      this.long.add(fire)
      return () => {
        this.long.delete(fire)
      }
    }
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

  /** The bite timeout of the running cast passes. */
  expire(): void {
    for (const fire of [...this.long]) {
      this.long.delete(fire)
      fire()
    }
  }
}

export class RecordingGaze implements Gaze {
  readonly looked: Position[] = []

  lookAt(target: Position): Promise<void> {
    this.looked.push(target)
    return Promise.resolve()
  }
}

export type Cast = { bite: readonly string[] } | 'never' | { fail: FishFailure['reason'] }

/** Casts follow a script; a bite hands the named items to the inventory, a `never` waits for the line to be reeled in. */
export class ScriptedFisher implements Fisher {
  readonly script: Cast[] = []
  casts = 0
  /** Called for each item that a bite brings in. */
  onCatch: (item: string) => void = () => undefined
  /** Called when a cast starts waiting for a bite that never comes. */
  onWaiting: () => void = () => undefined

  async cast(signal: AbortSignal): Promise<Result<void, FishFailure>> {
    this.casts += 1
    const next = this.script.shift() ?? { bite: ['cod'] }
    if (next === 'never') {
      queueMicrotask(this.onWaiting)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        signal.addEventListener('abort', () => {
          resolve()
        })
      })
      return err({ reason: 'aborted', message: 'The line was reeled in.' })
    }
    if ('fail' in next) return err({ reason: next.fail, message: next.fail })
    for (const item of next.bite) this.onCatch(item)
    return Promise.resolve(ok(undefined))
  }
}

/** A pond of water (5 by 5) with grass around it, and an inventory holding what the bot carries. */
export function fishingWorld(carried: Record<string, number> = { fishing_rod: 1 }) {
  const world = new GroveWorld({ x0: -30, x1: 30, z0: -30, z1: 30, y0: 50, y1: 90 })
  world.ground(-30, -30, 30, 30, GROUND)
  for (let x = 10; x <= 14; x += 1) for (let z = 0; z <= 4; z += 1) world.set(x, GROUND, z, 'water')
  const items = new Map(Object.entries(carried))
  const inventory = new FakeInventory()
  let empty = 20
  const sync = (): void => {
    inventory.value = {
      stacks: [...items].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
      emptySlots: empty,
      heldItem: undefined,
    }
  }
  sync()
  return {
    world,
    inventory,
    items,
    sync,
    setEmptySlots: (value: number): void => {
      empty = value
      sync()
    },
    give: (item: string, count = 1): void => {
      items.set(item, (items.get(item) ?? 0) + count)
      sync()
    },
  }
}
