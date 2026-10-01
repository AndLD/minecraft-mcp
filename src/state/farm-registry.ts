import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const spotSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  size: z.union([z.literal(1), z.literal(2)]),
})
const farmSchema = z.object({
  id: z.string(),
  kind: z.enum(['field', 'pen', 'grove', 'apiary']),
  /** The crop this field grows, or the tree species of a grove; null for anything else, or none set. */
  crop: z.string().nullable(),
  /** The animal species this pen keeps, or null for anything else, or a pen with none set. */
  species: z.string().nullable(),
  /** The herd size `tend_farm` breeds up to and culls down to, for a pen; null leaves the herd alone. */
  herdTarget: z.number().int().min(1).nullable(),
  bounds: z.object({ from: pointSchema, to: pointSchema }),
  /** The side of the fence the gate is on (a field or pen the bot built with one), or null when unknown. */
  gateSide: z.enum(['north', 'south', 'east', 'west']).nullable(),
  /** A grove's planting spots (sapling cells; `size` 2 is a 2x2 of four saplings), or null when none are recorded. */
  spots: z.array(spotSchema).nullable(),
  label: z.string().nullable(),
  /** Ties several components into one farm, for example "home". */
  group: z.string().nullable(),
  /** Built by `build_farm`, or pointed out by the player with `register_farm`. */
  builtByBot: z.boolean(),
  registeredAt: z.string(),
})

export type FarmEntry = z.infer<typeof farmSchema>
export type GroveSpot = z.infer<typeof spotSchema>

const farmsDocument = defineDocument({
  key: 'farms',
  version: 4,
  schema: z.object({ farms: z.array(farmSchema), nextId: z.number().int() }),
  initial: () => ({ farms: [] as FarmEntry[], nextId: 1 }),
  migrations: {
    1: (data) => {
      const doc = data as { farms: readonly Record<string, unknown>[]; nextId: number }
      return {
        ...doc,
        farms: doc.farms.map((entry) => ({ ...entry, species: null, herdTarget: null })),
      }
    },
    2: (data) => {
      const doc = data as { farms: readonly Record<string, unknown>[]; nextId: number }
      return { ...doc, farms: doc.farms.map((entry) => ({ ...entry, spots: null })) }
    },
    3: (data) => {
      const doc = data as { farms: readonly Record<string, unknown>[]; nextId: number }
      return { ...doc, farms: doc.farms.map((entry) => ({ ...entry, gateSide: null })) }
    },
  },
})

export const MAX_FARMS = 100
const NOT_ACTIVE =
  'No world is active, so farms cannot be saved or read. Connect to a world (and name it if asked) first.'

export interface RegisterFarmOptions {
  readonly kind: FarmEntry['kind']
  readonly crop?: string | undefined
  readonly species?: string | undefined
  readonly herdTarget?: number | undefined
  readonly spots?: readonly GroveSpot[] | undefined
  readonly gateSide?: FarmEntry['gateSide'] | undefined
  readonly bounds: { readonly from: Position; readonly to: Position }
  readonly label?: string | undefined
  readonly group?: string | undefined
  readonly builtByBot?: boolean | undefined
}

/**
 * The fields, pens, and groves the bot knows about in this world: where, what kind, and an optional group (for
 * example "home", tying a cow pen, a chicken pen, and a wheat field into one farm `tend_farm`/`inspect_farm` can
 * work on together). Modeled on `ContainerIndex`.
 */
export class FarmRegistry implements ProfileScoped {
  private store: StateStore | undefined
  private farms: FarmEntry[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(farmsDocument)
    this.store = store
    this.farms = [...loaded.value.farms]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.farms = []
  }

  register(options: RegisterFarmOptions): Result<FarmEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (this.farms.length >= MAX_FARMS)
      return err(`There are already ${String(MAX_FARMS)} farms. Remove some first.`)
    const label = options.label?.trim()
    if (label !== undefined && label !== '' && this.byLabel(label) !== undefined)
      return err(`The label "${label}" is already used by another farm.`)
    const group = options.group?.trim()
    const entry: FarmEntry = {
      id: `farm-${String(this.nextId)}`,
      kind: options.kind,
      crop: options.crop ?? null,
      species: options.species ?? null,
      herdTarget: options.herdTarget ?? null,
      bounds: options.bounds,
      gateSide: options.gateSide ?? null,
      spots: options.spots === undefined ? null : [...options.spots],
      label: label === undefined || label === '' ? null : label,
      group: group === undefined || group === '' ? null : group,
      builtByBot: options.builtByBot ?? false,
      registeredAt: new Date(this.clock.now()).toISOString(),
    }
    this.nextId += 1
    this.farms.push(entry)
    this.persist()
    return ok(entry)
  }

  remove(id: string): Result<FarmEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const entry = this.farms.find((candidate) => candidate.id === id)
    if (entry === undefined) return err(`There is no farm ${id}.`)
    this.farms = this.farms.filter((candidate) => candidate.id !== id)
    this.persist()
    return ok(entry)
  }

  /** Adds planting spots to a grove (a spot already recorded is not added twice). */
  addSpots(id: string, spots: readonly GroveSpot[]): Result<FarmEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const index = this.farms.findIndex((candidate) => candidate.id === id)
    const entry = this.farms[index]
    if (entry === undefined) return err(`There is no farm ${id}.`)
    const known = entry.spots ?? []
    const fresh = spots.filter(
      (spot) => !known.some((have) => have.x === spot.x && have.y === spot.y && have.z === spot.z),
    )
    const updated: FarmEntry = { ...entry, spots: [...known, ...fresh] }
    this.farms[index] = updated
    this.persist()
    return ok(updated)
  }

  list(): Result<readonly FarmEntry[]> {
    return this.store === undefined ? err(NOT_ACTIVE) : ok([...this.farms])
  }

  /** Every known farm; empty when no world is active. */
  all(): readonly FarmEntry[] {
    return this.farms
  }

  get(id: string): FarmEntry | undefined {
    return this.farms.find((entry) => entry.id === id)
  }

  byLabel(label: string): FarmEntry | undefined {
    const wanted = label.trim().toLowerCase()
    return this.farms.find((entry) => entry.label?.toLowerCase() === wanted)
  }

  /** A farm by id (`farm-3`) or label. */
  resolve(reference: string): FarmEntry | undefined {
    return this.get(reference) ?? this.byLabel(reference)
  }

  /** Every farm sharing a group (case-insensitive), for `tend_farm`/`inspect_farm` on a group name. */
  byGroup(group: string): readonly FarmEntry[] {
    const wanted = group.trim().toLowerCase()
    return this.farms.filter((entry) => entry.group?.toLowerCase() === wanted)
  }

  private persist(): void {
    this.store?.save(farmsDocument, { farms: this.farms, nextId: this.nextId })
  }
}
