import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const recordSchema = z.object({
  id: z.string(),
  shape: z.enum(['pit', 'shaft', 'quarry']),
  /** The lowest x/z corner of the top layer, at the height the first layer was dug. */
  origin: pointSchema,
  width: z.number().int(),
  length: z.number().int(),
  /** The lowest layer planned (the y of the last layer dug). */
  bottom: z.number().int(),
  exit: z.enum(['ladder', 'stairs', 'none']),
  stairWidth: z.number().int(),
  stairHeight: z.number().int(),
  sealCaves: z.boolean(),
  sealBlock: z.string(),
  recordedAt: z.string(),
})

export type ExcavationRecord = z.infer<typeof recordSchema>
export type NewExcavationRecord = Omit<ExcavationRecord, 'id' | 'recordedAt'>

const recordsDocument = defineDocument({
  key: 'excavations',
  version: 1,
  schema: z.object({ records: z.array(recordSchema), nextId: z.number().int() }),
  initial: () => ({ records: [] as ExcavationRecord[], nextId: 1 }),
})

export const MAX_RECORDS = 50
/** How far beyond the footprint (which the stair ring and its margin lie in) a position still points at a dig. */
const NEAR = 10

const samePlace = (a: Position, b: Position): boolean => a.x === b.x && a.z === b.z && a.y === b.y

/**
 * The pits, shafts, and quarries the bot dug in this world: where, how big, how deep, and how the way out was cut, so a
 * later request ("make it deeper") can continue the same dig instead of guessing a footprint from the blocks.
 */
export class ExcavationRecords implements ProfileScoped {
  private store: StateStore | undefined
  private records: ExcavationRecord[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(recordsDocument)
    this.store = store
    this.records = [...loaded.value.records]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.records = []
  }

  all(): readonly ExcavationRecord[] {
    return this.records
  }

  /** Remembers a dig; one at the same origin is replaced (a deeper dig of the same hole updates its record). */
  record(entry: NewExcavationRecord): ExcavationRecord | undefined {
    if (this.store === undefined) return undefined
    const existing = this.records.find((r) => samePlace(r.origin, entry.origin))
    const saved: ExcavationRecord = {
      ...entry,
      id: existing?.id ?? `dig-${String(this.nextId)}`,
      recordedAt: new Date(this.clock.now()).toISOString(),
    }
    if (existing === undefined) {
      this.nextId += 1
      this.records = [...this.records, saved].slice(-MAX_RECORDS)
    } else this.records = this.records.map((r) => (r === existing ? saved : r))
    this.store.save(recordsDocument, { records: this.records, nextId: this.nextId })
    return saved
  }

  /** The digs whose footprint (and the ring around it) contains this position horizontally, nearest first. */
  near(position: Position): readonly ExcavationRecord[] {
    const cell = { x: Math.floor(position.x), z: Math.floor(position.z) }
    return this.records
      .filter(
        (r) =>
          cell.x >= r.origin.x - NEAR &&
          cell.x <= r.origin.x + r.width - 1 + NEAR &&
          cell.z >= r.origin.z - NEAR &&
          cell.z <= r.origin.z + r.length - 1 + NEAR,
      )
      .map((r) => ({
        r,
        d: Math.hypot(
          cell.x - (r.origin.x + (r.width - 1) / 2),
          cell.z - (r.origin.z + (r.length - 1) / 2),
        ),
      }))
      .sort((a, b) => a.d - b.d)
      .map((entry) => entry.r)
  }

  /** The dig recorded at exactly this origin (the top-layer corner). */
  at(origin: Position): ExcavationRecord | undefined {
    return this.records.find((r) => samePlace(r.origin, origin))
  }
}
