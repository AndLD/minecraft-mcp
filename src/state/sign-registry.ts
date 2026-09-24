import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const signSchema = z.object({
  id: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  /** The lines of the side the bot wrote, as it wrote them. */
  lines: z.array(z.string()),
  side: z.enum(['front', 'back']),
  wood: z.string(),
  placedAt: z.string(),
})

export type SignEntry = z.infer<typeof signSchema>

const signsDocument = defineDocument({
  key: 'signs',
  version: 1,
  schema: z.object({ signs: z.array(signSchema), nextId: z.number().int() }),
  initial: () => ({ signs: [] as SignEntry[], nextId: 1 }),
})

const NOT_ACTIVE = 'No world is active, so signs cannot be saved or read. Connect to a world first.'

const samePlace = (entry: SignEntry, position: Position): boolean =>
  entry.x === position.x && entry.y === position.y && entry.z === position.z

/** The signs the bot put up in this world, with the text it wrote (a record, not a claim about what is there now). */
export class SignRegistry implements ProfileScoped {
  private store: StateStore | undefined
  private signs: SignEntry[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(signsDocument)
    this.store = store
    this.signs = [...loaded.value.signs]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.signs = []
  }

  all(): readonly SignEntry[] {
    return this.signs
  }

  at(position: Position): SignEntry | undefined {
    return this.signs.find((entry) => samePlace(entry, position))
  }

  /** Records a sign the bot placed; a second record for the same place replaces the first. */
  note(
    position: Position,
    details: { lines: readonly string[]; side: 'front' | 'back'; wood: string },
  ): Result<SignEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const known = this.at(position)
    const entry: SignEntry = {
      id: known?.id ?? `sign-${String(this.nextId)}`,
      x: position.x,
      y: position.y,
      z: position.z,
      lines: [...details.lines],
      side: details.side,
      wood: details.wood,
      placedAt: new Date(this.clock.now()).toISOString(),
    }
    if (known === undefined) this.nextId += 1
    this.signs = [...this.signs.filter((sign) => sign.id !== entry.id), entry]
    this.save()
    return ok(entry)
  }

  /** The bot changed the text of a sign it knows. Signs it did not place are not recorded. */
  retext(position: Position, side: 'front' | 'back', lines: readonly string[]): void {
    const known = this.at(position)
    if (known === undefined || this.store === undefined) return
    this.signs = this.signs.map((sign) =>
      sign.id === known.id ? { ...sign, side, lines: [...lines] } : sign,
    )
    this.save()
  }

  /** Forgets a sign that was taken down. */
  remove(position: Position): boolean {
    const known = this.at(position)
    if (known === undefined || this.store === undefined) return false
    this.signs = this.signs.filter((sign) => sign.id !== known.id)
    this.save()
    return true
  }

  private save(): void {
    this.store?.save(signsDocument, { signs: this.signs, nextId: this.nextId })
  }
}
