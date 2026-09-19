import { z } from 'zod'
import type { AreaGuard, ProtectedArea } from '../core/area-guard.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const areaSchema = z.object({
  id: z.string(),
  label: z.string(),
  min: pointSchema,
  max: pointSchema,
})

export type ProtectedBox = z.infer<typeof areaSchema>

const protectedAreasDocument = defineDocument({
  key: 'protected-areas',
  version: 1,
  schema: z.object({ areas: z.array(areaSchema), nextId: z.number().int() }),
  initial: () => ({ areas: [] as ProtectedBox[], nextId: 1 }),
})

export const MAX_PROTECTED_AREAS = 100
const NOT_ACTIVE =
  'No world is active, so protected areas cannot be saved or read. Connect to a world (and name it if asked) first.'

/** Boxes the bot must never dig in, saved per world. */
export class ProtectedAreas implements ProfileScoped, AreaGuard {
  private store: StateStore | undefined
  private areas: ProtectedBox[] = []
  private nextId = 1

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(protectedAreasDocument)
    this.store = store
    this.areas = [...loaded.value.areas]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.areas = []
  }

  /** Protects the box between two opposite corners (both included). */
  add(label: string, cornerA: Position, cornerB: Position): Result<ProtectedBox> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (this.areas.length >= MAX_PROTECTED_AREAS)
      return err(
        `There are already ${String(MAX_PROTECTED_AREAS)} protected areas. Remove some first.`,
      )
    const trimmed = label.trim()
    if (trimmed === '') return err('Give the area a label, for example "my house".')

    const box: ProtectedBox = {
      id: `area-${String(this.nextId)}`,
      label: trimmed,
      min: {
        x: Math.floor(Math.min(cornerA.x, cornerB.x)),
        y: Math.floor(Math.min(cornerA.y, cornerB.y)),
        z: Math.floor(Math.min(cornerA.z, cornerB.z)),
      },
      max: {
        x: Math.floor(Math.max(cornerA.x, cornerB.x)),
        y: Math.floor(Math.max(cornerA.y, cornerB.y)),
        z: Math.floor(Math.max(cornerA.z, cornerB.z)),
      },
    }
    this.nextId += 1
    this.areas.push(box)
    this.persist()
    return ok(box)
  }

  remove(id: string): Result<ProtectedBox> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const box = this.areas.find((area) => area.id === id)
    if (box === undefined) return err(`There is no protected area ${id}.`)
    this.areas = this.areas.filter((area) => area.id !== id)
    this.persist()
    return ok(box)
  }

  list(): Result<readonly ProtectedBox[]> {
    return this.store === undefined ? err(NOT_ACTIVE) : ok([...this.areas])
  }

  protectedAt(position: Position): ProtectedArea | undefined {
    const x = Math.floor(position.x)
    const y = Math.floor(position.y)
    const z = Math.floor(position.z)
    const box = this.areas.find(
      (area) =>
        x >= area.min.x &&
        x <= area.max.x &&
        y >= area.min.y &&
        y <= area.max.y &&
        z >= area.min.z &&
        z <= area.max.z,
    )
    return box === undefined ? undefined : { id: box.id, label: box.label }
  }

  private persist(): void {
    this.store?.save(protectedAreasDocument, { areas: this.areas, nextId: this.nextId })
  }
}
