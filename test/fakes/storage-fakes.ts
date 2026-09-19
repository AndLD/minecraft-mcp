import type {
  ContainerAccess,
  ContainerContents,
  ContainerSession,
} from '../../src/core/container.port.js'
import type { Position } from '../../src/core/position.types.js'
import { err, ok, type Result } from '../../src/core/result.js'
import { FakeBlockScanner, FakeInventory, FakeVitals, buildVitals } from './fake-ports.js'
import { InstantNavigator } from './gathering-fakes.js'

const STACK = 64
const key = (p: Position): string => `${String(p.x)},${String(p.y)},${String(p.z)}`

interface FakeContainer {
  name: string
  slots: number
  stacks: Map<string, number>
}

const slotsUsed = (stacks: ReadonlyMap<string, number>): number =>
  [...stacks.values()].reduce((sum, count) => sum + Math.ceil(count / STACK), 0)

/**
 * A world of containers and a bot's carried items, behind the same port the real adapter implements. What the bot
 * carries is mirrored into the fake inventory after every change.
 */
export class FakeStorageWorld implements ContainerAccess {
  readonly containers = new Map<string, FakeContainer>()
  readonly carried = new Map<string, number>()
  readonly opened: string[] = []
  openFailure: string | undefined
  playerSlots = 36

  readonly scanner = new FakeBlockScanner()
  readonly inventory = new FakeInventory()
  readonly vitals = new FakeVitals()
  readonly navigator = new InstantNavigator()

  constructor() {
    this.vitals.vitals = buildVitals({ position: { x: 0, y: 64, z: 0 } })
    this.scanner.names = ['chest', 'barrel', 'stone']
    this.sync()
  }

  /** Puts a container in the world (and lets the scanner see it). */
  addContainer(position: Position, name = 'chest', slots = 27): void {
    this.containers.set(key(position), { name, slots, stacks: new Map() })
    this.scanner.blockNames.set(key(position), name)
    this.scanner.blocks = [
      ...this.scanner.blocks,
      { name, position, distance: Math.hypot(position.x, position.y - 64, position.z) },
    ]
  }

  /** Removes it from the world without telling anybody (a griefer, or the player). */
  breakContainer(position: Position): void {
    this.containers.delete(key(position))
    this.scanner.blockNames.set(key(position), 'air')
    this.scanner.blocks = this.scanner.blocks.filter((b) => key(b.position) !== key(position))
  }

  stock(position: Position, item: string, count: number): void {
    const container = this.containers.get(key(position))
    if (container === undefined) throw new Error('no container there')
    container.stacks.set(item, (container.stacks.get(item) ?? 0) + count)
  }

  inside(position: Position, item: string): number {
    return this.containers.get(key(position))?.stacks.get(item) ?? 0
  }

  carry(item: string, count: number): void {
    this.carried.set(item, (this.carried.get(item) ?? 0) + count)
    this.sync()
  }

  have(item: string): number {
    return this.carried.get(item) ?? 0
  }

  /** Mirrors the carried items into the fake inventory. */
  sync(): void {
    this.inventory.value = {
      stacks: [...this.carried]
        .filter(([, count]) => count > 0)
        .map(([name, count]) => ({ name, count })),
      emptySlots: this.playerSlots - slotsUsed(this.carried),
      heldItem: undefined,
    }
  }

  open(position: Position): Promise<Result<ContainerSession>> {
    this.opened.push(key(position))
    const container = this.containers.get(key(position))
    if (this.openFailure !== undefined) return Promise.resolve(err(this.openFailure))
    if (container === undefined)
      return Promise.resolve(err('There is no chest, barrel, or shulker box there.'))
    return Promise.resolve(ok(new FakeStorageSession(this, container)))
  }
}

class FakeStorageSession implements ContainerSession {
  constructor(
    private readonly world: FakeStorageWorld,
    private readonly container: FakeContainer,
  ) {}

  contents(): ContainerContents {
    return {
      stacks: [...this.container.stacks].map(([name, count]) => ({ name, count })),
      totalSlots: this.container.slots,
      emptySlots: this.container.slots - slotsUsed(this.container.stacks),
    }
  }

  deposit(item: string, count: number | undefined): Promise<number> {
    const have = this.world.carried.get(item) ?? 0
    const wanted = Math.min(count ?? have, have)
    const inside = this.container.stacks.get(item) ?? 0
    const freeSlots = this.container.slots - slotsUsed(this.container.stacks)
    const room = freeSlots * STACK + ((STACK - (inside % STACK)) % STACK)
    const moved = Math.min(wanted, room)
    if (moved > 0) {
      this.container.stacks.set(item, inside + moved)
      this.world.carried.set(item, have - moved)
      this.world.sync()
    }
    return Promise.resolve(moved)
  }

  withdraw(item: string, count: number | undefined): Promise<number> {
    const inside = this.container.stacks.get(item) ?? 0
    const wanted = Math.min(count ?? inside, inside)
    const carried = this.world.carried.get(item) ?? 0
    const freeSlots = this.world.playerSlots - slotsUsed(this.world.carried)
    const room = freeSlots * STACK + ((STACK - (carried % STACK)) % STACK)
    const moved = Math.min(wanted, room)
    if (moved > 0) {
      this.container.stacks.set(item, inside - moved)
      if (inside - moved === 0) this.container.stacks.delete(item)
      this.world.carried.set(item, carried + moved)
      this.world.sync()
    }
    return Promise.resolve(moved)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
