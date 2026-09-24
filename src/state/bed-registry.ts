import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import { distanceBetween } from '../core/position.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const bedSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  colour: z.string(),
  /** This bed is where the bot wakes up after a death. */
  respawn: z.boolean(),
  /** When it became the respawn point. */
  setAt: z.string().nullable(),
  /** False once the bed was found gone or the bot did not respawn at it. */
  intact: z.boolean(),
  seenAt: z.string(),
})

export type BedEntry = z.infer<typeof bedSchema>

const bedsDocument = defineDocument({
  key: 'beds',
  version: 1,
  schema: z.object({ beds: z.array(bedSchema), nextId: z.number().int() }),
  initial: () => ({ beds: [] as BedEntry[], nextId: 1 }),
})

const NOT_ACTIVE = 'No world is active, so beds cannot be saved or read. Connect to a world first.'

const positionOf = (bed: BedEntry): Position => ({ x: bed.x, y: bed.y, z: bed.z })

/** The two halves of one bed are one cell apart on the same level. */
const sameBed = (bed: BedEntry, position: Position): boolean =>
  bed.y === position.y && Math.abs(bed.x - position.x) + Math.abs(bed.z - position.z) <= 1

/** The beds the bot knows in this world, and which one is its respawn point. */
export class BedRegistry implements ProfileScoped {
  private store: StateStore | undefined
  private beds: BedEntry[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(bedsDocument)
    this.store = store
    this.beds = [...loaded.value.beds]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.beds = []
  }

  all(): readonly BedEntry[] {
    return this.beds
  }

  respawn(): BedEntry | undefined {
    return this.beds.find((bed) => bed.respawn)
  }

  /** Remembers a bed seen at `position`, or refreshes the entry when it is already known. */
  note(position: Position, colour: string): Result<BedEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const known = this.beds.find((bed) => sameBed(bed, position))
    const seenAt = new Date(this.clock.now()).toISOString()
    if (known !== undefined) return ok(this.replace(known, { colour, intact: true, seenAt }))
    const entry: BedEntry = {
      id: `bed-${String(this.nextId)}`,
      x: position.x,
      y: position.y,
      z: position.z,
      colour,
      respawn: false,
      setAt: null,
      intact: true,
      seenAt,
    }
    this.nextId += 1
    this.beds = [...this.beds, entry]
    this.save()
    return ok(entry)
  }

  /** Makes this bed the respawn point (there is only ever one). */
  setRespawn(position: Position, colour: string): Result<BedEntry> {
    const noted = this.note(position, colour)
    if (!noted.ok) return noted
    const at = new Date(this.clock.now()).toISOString()
    this.beds = this.beds.map((bed) =>
      bed.respawn && bed.id !== noted.value.id ? { ...bed, respawn: false } : bed,
    )
    return ok(this.replace(noted.value, { respawn: true, setAt: at, intact: true }))
  }

  /** The bed was found gone, or the bot did not respawn there: it is no longer the respawn point. */
  markLost(id: string): BedEntry | undefined {
    const bed = this.beds.find((entry) => entry.id === id)
    if (bed === undefined || this.store === undefined) return undefined
    return this.replace(bed, { respawn: false, intact: false })
  }

  /** Forgets a bed that no longer exists. */
  remove(id: string): boolean {
    if (this.store === undefined || !this.beds.some((bed) => bed.id === id)) return false
    this.beds = this.beds.filter((bed) => bed.id !== id)
    this.save()
    return true
  }

  /** Intact beds, nearest first. */
  nearest(from: Position): readonly BedEntry[] {
    return this.beds
      .filter((bed) => bed.intact)
      .sort((a, b) => distanceBetween(from, positionOf(a)) - distanceBetween(from, positionOf(b)))
  }

  private replace(bed: BedEntry, changes: Partial<BedEntry>): BedEntry {
    const updated = { ...bed, ...changes }
    this.beds = this.beds.map((entry) => (entry.id === bed.id ? updated : entry))
    this.save()
    return updated
  }

  private save(): void {
    this.store?.save(bedsDocument, { beds: this.beds, nextId: this.nextId })
  }
}

export const bedPosition = positionOf
