import type { CampfireAccess, CampfireState } from '../../src/core/campfire.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import type { DropCollector, DropFilter } from '../../src/skills/gathering/drop-collector.js'
import { CAMPFIRE_MS_PER_ITEM, CAMPFIRE_SLOTS } from '../../src/skills/smelting/stations.js'
import type { FakeClock } from './fake-clock.js'
import type { FakeInventory } from './fake-ports.js'

/**
 * A campfire that works on the fake clock: four slots, 30 seconds each; the cooked item pops out as a dropped item,
 * and `drops.collect` walks over and takes it into the inventory (the picking up itself is `DropCollector`'s job).
 */
export class FakeCampfire {
  state: CampfireState = 'lit'
  /** What the campfire says when it is full, or `undefined` to take items while a slot is free. */
  refuseWith: string | undefined
  /** Runs after every item that went on. */
  onPut: () => void = () => undefined
  readonly on: { item: string; at: number }[] = []
  readonly puts: string[] = []
  private readonly popped: string[] = []

  constructor(
    private readonly clock: FakeClock,
    private readonly inventory: FakeInventory,
    private readonly cooks: Readonly<Record<string, string>>,
  ) {}

  readonly access: CampfireAccess = {
    stateAt: (): CampfireState => this.state,
    put: (_position: Position, item: string): Promise<Result<void>> => {
      this.pop()
      if (this.refuseWith !== undefined) return Promise.resolve(err(this.refuseWith))
      if (this.on.length >= CAMPFIRE_SLOTS) return Promise.resolve(err('The campfire is full.'))
      this.take(item)
      this.on.push({ item, at: this.clock.now() })
      this.puts.push(item)
      this.onPut()
      return Promise.resolve(ok(undefined))
    },
  }

  /** Stands in for the drop collector: everything that has popped out goes into the inventory. */
  readonly drops: Pick<DropCollector, 'collect'> = {
    collect: (filter: DropFilter): Promise<void> => {
      this.pop()
      for (const name of this.popped.splice(0)) {
        if (filter.names !== undefined && !filter.names.includes(name)) continue
        this.give(name)
      }
      return Promise.resolve()
    },
  }

  private pop(): void {
    const now = this.clock.now()
    for (const entry of [...this.on]) {
      if (now - entry.at < CAMPFIRE_MS_PER_ITEM) continue
      this.on.splice(this.on.indexOf(entry), 1)
      this.popped.push(this.cooks[entry.item] ?? entry.item)
    }
  }

  private take(item: string): void {
    this.change(item, -1)
  }

  private give(item: string): void {
    this.change(item, 1)
  }

  private change(item: string, by: number): void {
    const stacks = [...(this.inventory.value?.stacks ?? [])]
    const index = stacks.findIndex((stack) => stack.name === item)
    if (index >= 0) {
      const count = (stacks[index]?.count ?? 0) + by
      if (count > 0) stacks[index] = { name: item, count }
      else stacks.splice(index, 1)
    } else if (by > 0) stacks.push({ name: item, count: by })
    if (this.inventory.value !== undefined)
      this.inventory.value = { ...this.inventory.value, stacks }
  }
}
