import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/** Dropped items vanish five minutes after they hit the ground. */
export const DROP_DESPAWN_MS = 300_000
const MAX_RECORDS = 50

/** `death`: the bot's inventory at the place it died. `unclaimed`: items dropped for a player that nobody picked up. */
export const DROP_KINDS = ['death', 'unclaimed'] as const
export type DropKind = (typeof DROP_KINDS)[number]

/**
 * `pending`: waiting to be fetched. `recovering`: an attempt is running. `recovered`: everything is back. `partial`:
 * some is back, the rest is missing. `abandoned`: given up or skipped on purpose, coordinates kept, may be fetched
 * later. `expired`: despawned. `gone`: nothing was left at the spot (somebody took it).
 */
export const DROP_STATUSES = [
  'pending',
  'recovering',
  'recovered',
  'partial',
  'abandoned',
  'expired',
  'gone',
] as const
export type DropStatus = (typeof DROP_STATUSES)[number]

const itemCounts = z.array(z.object({ name: z.string(), count: z.number().int().min(1) }))

const recordSchema = z.object({
  id: z.string(),
  kind: z.enum(DROP_KINDS),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  dimension: z.string(),
  /** Epoch milliseconds of the death, or of the moment the items were dropped. */
  at: z.number(),
  cause: z.string().nullable(),
  /** What should lie at the spot. */
  lost: itemCounts,
  recovered: itemCounts,
  status: z.enum(DROP_STATUSES),
  attempts: z.number().int().min(0),
  note: z.string().nullable(),
})

export type DropRecord = z.output<typeof recordSchema>

const dropRecordsDocument = defineDocument({
  key: 'drop-records',
  version: 1,
  schema: z.object({ records: z.array(recordSchema) }),
  initial: (): { records: DropRecord[] } => ({ records: [] }),
})

const NOT_ACTIVE =
  'No world is active, so the drop record cannot be saved. Connect to a world first.'

export type NewDropRecord = Pick<
  DropRecord,
  'kind' | 'position' | 'dimension' | 'at' | 'lost' | 'cause' | 'note'
> &
  Partial<Pick<DropRecord, 'status'>>

const ACTIVE: readonly DropStatus[] = ['pending', 'recovering', 'partial', 'abandoned']

/** Where the bot died and where drops lie, saved per world so a relaunch does not forget them. */
export class DropRecords implements ProfileScoped {
  private store: StateStore | undefined
  private records: DropRecord[] = []

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(dropRecordsDocument)
    this.store = store
    this.records = [...loaded.value.records]
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.records = []
  }

  /** Oldest first. */
  all(): readonly DropRecord[] {
    return this.records
  }

  get(id: string): DropRecord | undefined {
    return this.records.find((record) => record.id === id)
  }

  /** Records that have not expired and may still be fetched, newest first. */
  recoverable(): readonly DropRecord[] {
    this.expireStale()
    return this.records
      .filter((record) => record.status !== 'recovering' && ACTIVE.includes(record.status))
      .reverse()
  }

  recovering(): readonly DropRecord[] {
    return this.records.filter((record) => record.status === 'recovering')
  }

  add(input: NewDropRecord): Result<DropRecord> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const record: DropRecord = {
      ...input,
      id: `drop-${String(this.nextNumber())}`,
      status: input.status ?? 'pending',
      recovered: [],
      attempts: 0,
    }
    this.records = [...this.records, record].slice(-MAX_RECORDS)
    this.save()
    return ok(record)
  }

  update(id: string, patch: Partial<Omit<DropRecord, 'id'>>): DropRecord | undefined {
    const current = this.get(id)
    if (current === undefined) return undefined
    const next = { ...current, ...patch }
    this.records = this.records.map((record) => (record.id === id ? next : record))
    this.save()
    return next
  }

  /** Marks records whose items have despawned. */
  expireStale(): void {
    const now = this.clock.now()
    for (const record of this.records) {
      if (ACTIVE.includes(record.status) && now - record.at >= DROP_DESPAWN_MS)
        this.update(record.id, { status: 'expired' })
    }
  }

  private nextNumber(): number {
    const numbers = this.records.map((record) => Number(record.id.replace('drop-', '')))
    return Math.max(0, ...numbers.filter(Number.isFinite)) + 1
  }

  private save(): void {
    this.store?.save(dropRecordsDocument, { records: [...this.records] })
  }
}
