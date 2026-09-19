import type { Clock } from '../../core/clock.port.js'
import type { DroppedItem } from '../../core/dropped-items.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { DROP_DESPAWN_MS } from '../../state/drop-records.js'

/** Items lying this close to a deliberate drop, with the same name, are taken to be it. */
const SAME_PLACE_RADIUS = 6

interface Entry {
  readonly names: ReadonlySet<string>
  readonly position: Position
  readonly at: number
}

/**
 * Remembers what the bot threw away on purpose (junk), so recovery sweeps never pick it up again. Only names and
 * places are compared: an item of the same kind lying near the same spot within five minutes counts as the junk.
 * That can leave a matching death drop behind at such a spot, which is the cautious mistake to make.
 */
export class DropIgnoreList {
  private entries: Entry[] = []

  constructor(private readonly clock: Clock) {}

  add(items: readonly ItemCount[], position: Position): void {
    this.forget()
    this.entries.push({
      names: new Set(items.map((item) => item.name)),
      position,
      at: this.clock.now(),
    })
  }

  isIgnored(item: DroppedItem): boolean {
    this.forget()
    return this.entries.some(
      (entry) =>
        entry.names.has(item.name) &&
        distanceBetween(entry.position, item.position) <= SAME_PLACE_RADIUS,
    )
  }

  private forget(): void {
    const now = this.clock.now()
    this.entries = this.entries.filter((entry) => now - entry.at < DROP_DESPAWN_MS)
  }
}
