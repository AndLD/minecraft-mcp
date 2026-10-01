import type { Gaze } from '../../src/core/gaze.port.js'
import type { InventoryWriter } from '../../src/core/inventory-writer.port.js'
import type { Position } from '../../src/core/position.types.js'
import type { FakeEntityScanner } from './fake-ports.js'
import type { FakeDroppedItems } from './gathering-fakes.js'
import type { FakeStorageWorld } from './storage-fakes.js'

export class FakeGaze implements Gaze {
  readonly looked: Position[] = []

  lookAt(target: Position): Promise<void> {
    this.looked.push(target)
    return Promise.resolve()
  }
}

/** Throws items out of the storage world's carried items, leaving them on the ground where the bot stands. */
export class FakeInventoryWriter implements InventoryWriter {
  readonly tosses: { item: string; count: number }[] = []
  /** Set to throw fewer items than asked (a server that ignored clicks). */
  limit: number | undefined

  constructor(
    private readonly world: FakeStorageWorld,
    private readonly drops: FakeDroppedItems,
  ) {}

  toss(item: string, count: number): Promise<number> {
    const have = this.world.carried.get(item) ?? 0
    const thrown = Math.min(count, have, this.limit ?? count)
    this.tosses.push({ item, count })
    if (thrown > 0) {
      this.world.carried.set(item, have - thrown)
      this.world.sync()
      this.drops.drop(item, this.world.vitals.vitals?.position ?? { x: 0, y: 64, z: 0 }, 1, thrown)
    }
    return Promise.resolve(thrown)
  }
}

export const playerAt = (scanner: FakeEntityScanner, name: string, position: Position): void => {
  scanner.players.set(name.toLowerCase(), {
    name,
    online: true,
    position,
    distance: Math.hypot(position.x, position.z),
  })
}
