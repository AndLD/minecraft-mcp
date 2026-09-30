import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { STRUCTURE_KINDS, type StructureKind } from '../core/structure-kinds.js'
import { defineDocument } from '../state/define-document.js'
import type { ProfileScoped } from '../state/profile-scoped.types.js'

const coordinates = { x: z.number().int(), y: z.number().int(), z: z.number().int() }

const landmarkSchema = z.object({
  name: z.string(),
  ...coordinates,
  note: z.string().optional(),
  setAt: z.string(),
})

const structureSchema = z.object({
  id: z.string(),
  kind: z.enum(STRUCTURE_KINDS),
  ...coordinates,
  foundAt: z.string(),
  /** `scan`: the bot saw its blocks; `locate`: the server named the place (the bot has not seen it yet). */
  source: z.enum(['scan', 'locate']),
  detail: z.string().optional(),
})

const biomeSchema = z.object({
  id: z.string(),
  name: z.string(),
  ...coordinates,
  foundAt: z.string(),
  source: z.enum(['scan', 'locate']),
})

const findSchema = z.object({
  id: z.string(),
  kind: z.enum(['ore', 'spawner', 'geode']),
  name: z.string(),
  ...coordinates,
  /** How many blocks of the vein were in view. */
  count: z.number().int(),
  foundAt: z.string(),
})

export type FindRecord = z.infer<typeof findSchema>
export type BiomeRecord = z.infer<typeof biomeSchema>
export type Landmark = z.infer<typeof landmarkSchema>
export type StructureRecord = z.infer<typeof structureSchema>

const knowledgeDocument = defineDocument({
  key: 'knowledge',
  version: 1,
  schema: z.object({
    landmarks: z.array(landmarkSchema),
    structures: z.array(structureSchema),
    biomes: z.array(biomeSchema).default([]),
    finds: z.array(findSchema).default([]),
    nextId: z.number().int(),
  }),
  initial: () => ({
    landmarks: [] as Landmark[],
    structures: [] as StructureRecord[],
    biomes: [] as BiomeRecord[],
    finds: [] as FindRecord[],
    nextId: 1,
  }),
})

const NOT_ACTIVE =
  'No world is active, so landmarks and structures cannot be saved. Connect to a world first.'

/** Two finds of one kind closer than this (across, ignoring height) are the same structure. */
export const SAME_STRUCTURE_RADIUS = 96

const across = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.z - b.z)
const cell = (position: Position): Position => ({
  x: Math.round(position.x),
  y: Math.round(position.y),
  z: Math.round(position.z),
})

export interface Recorded {
  readonly entry: StructureRecord
  /** False when the find matched a structure that was already known. */
  readonly isNew: boolean
}

/** What the bot knows about the world beyond its containers: named places (landmarks) and structures it found. */
export class WorldKnowledgeStore implements ProfileScoped {
  private store: StateStore | undefined
  private landmarkList: Landmark[] = []
  private structureList: StructureRecord[] = []
  private biomeList: BiomeRecord[] = []
  private findList: FindRecord[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(knowledgeDocument)
    this.store = store
    this.landmarkList = [...loaded.value.landmarks]
    this.structureList = [...loaded.value.structures]
    this.biomeList = [...loaded.value.biomes]
    this.findList = [...loaded.value.finds]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.landmarkList = []
    this.structureList = []
    this.biomeList = []
    this.findList = []
  }

  get active(): boolean {
    return this.store !== undefined
  }

  landmarks(): readonly Landmark[] {
    return this.landmarkList
  }

  landmark(name: string): Landmark | undefined {
    const wanted = name.trim().toLowerCase()
    return this.landmarkList.find((entry) => entry.name.toLowerCase() === wanted)
  }

  /** Names a place; a second landmark with the same name (any case) replaces the first. */
  setLandmark(name: string, position: Position, note?: string): Result<Landmark> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const trimmed = name.trim()
    const at = cell(position)
    const entry: Landmark = {
      name: trimmed,
      ...at,
      ...(note === undefined || note === '' ? {} : { note }),
      setAt: new Date(this.clock.now()).toISOString(),
    }
    this.landmarkList = [
      ...this.landmarkList.filter((known) => known.name.toLowerCase() !== trimmed.toLowerCase()),
      entry,
    ]
    this.save()
    return ok(entry)
  }

  removeLandmark(name: string): boolean {
    const known = this.landmark(name)
    if (known === undefined || this.store === undefined) return false
    this.landmarkList = this.landmarkList.filter((entry) => entry !== known)
    this.save()
    return true
  }

  structures(kind?: StructureKind): readonly StructureRecord[] {
    return kind === undefined
      ? this.structureList
      : this.structureList.filter((entry) => entry.kind === kind)
  }

  /** The known structure of a kind nearest to a place (across, ignoring height). */
  nearest(kind: StructureKind, from: Position): StructureRecord | undefined {
    let best: StructureRecord | undefined
    for (const entry of this.structures(kind)) {
      if (best === undefined || across(entry, from) < across(best, from)) best = entry
    }
    return best
  }

  /** The already-known structure this find belongs to, if any. */
  matching(kind: StructureKind, position: Position): StructureRecord | undefined {
    return this.structureList.find(
      (entry) => entry.kind === kind && across(entry, position) <= SAME_STRUCTURE_RADIUS,
    )
  }

  /**
   * Records a find. One that matches a known structure is not added again; a sighting by the bot replaces a place the
   * server merely named, because the blocks give the exact spot.
   */
  record(
    kind: StructureKind,
    position: Position,
    details: { source: 'scan' | 'locate'; detail?: string },
  ): Result<Recorded> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const known = this.matching(kind, position)
    if (known !== undefined) {
      if (known.source === 'locate' && details.source === 'scan') {
        const upgraded: StructureRecord = {
          ...known,
          ...cell(position),
          source: 'scan',
          ...(details.detail === undefined ? {} : { detail: details.detail }),
        }
        this.structureList = this.structureList.map((entry) => (entry === known ? upgraded : entry))
        this.save()
        return ok({ entry: upgraded, isNew: false })
      }
      return ok({ entry: known, isNew: false })
    }
    const entry: StructureRecord = {
      id: `structure-${String(this.nextId)}`,
      kind,
      ...cell(position),
      foundAt: new Date(this.clock.now()).toISOString(),
      source: details.source,
      ...(details.detail === undefined ? {} : { detail: details.detail }),
    }
    this.nextId += 1
    this.structureList = [...this.structureList, entry]
    this.save()
    return ok({ entry, isNew: true })
  }

  finds(name?: string): readonly FindRecord[] {
    return name === undefined ? this.findList : this.findList.filter((entry) => entry.name === name)
  }

  /** Records an ore vein, spawner, or geode seen underground; one of the same name within 8 blocks is the same find. */
  recordFind(
    kind: FindRecord['kind'],
    name: string,
    position: Position,
    count: number,
  ): Result<{ entry: FindRecord; isNew: boolean }> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const known = this.findList.find(
      (entry) =>
        entry.name === name &&
        Math.hypot(entry.x - position.x, entry.y - position.y, entry.z - position.z) <= 8,
    )
    if (known !== undefined) return ok({ entry: known, isNew: false })
    const entry: FindRecord = {
      id: `find-${String(this.nextId)}`,
      kind,
      name,
      ...cell(position),
      count,
      foundAt: new Date(this.clock.now()).toISOString(),
    }
    this.nextId += 1
    this.findList = [...this.findList, entry]
    this.save()
    return ok({ entry, isNew: true })
  }

  biomes(name?: string): readonly BiomeRecord[] {
    return name === undefined
      ? this.biomeList
      : this.biomeList.filter((entry) => entry.name === name)
  }

  /** The known place of any of these biomes nearest to a place (across, ignoring height). */
  nearestBiome(names: readonly string[], from: Position): BiomeRecord | undefined {
    let best: BiomeRecord | undefined
    for (const entry of this.biomeList) {
      if (!names.includes(entry.name)) continue
      if (best === undefined || across(entry, from) < across(best, from)) best = entry
    }
    return best
  }

  /** Records where a biome was seen, with the same rules as `record` for structures. */
  recordBiome(
    name: string,
    position: Position,
    details: { source: 'scan' | 'locate' },
  ): Result<{ entry: BiomeRecord; isNew: boolean }> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const known = this.biomeList.find(
      (entry) => entry.name === name && across(entry, position) <= SAME_STRUCTURE_RADIUS,
    )
    if (known !== undefined) {
      if (known.source === 'locate' && details.source === 'scan') {
        const upgraded: BiomeRecord = { ...known, ...cell(position), source: 'scan' }
        this.biomeList = this.biomeList.map((entry) => (entry === known ? upgraded : entry))
        this.save()
        return ok({ entry: upgraded, isNew: false })
      }
      return ok({ entry: known, isNew: false })
    }
    const entry: BiomeRecord = {
      id: `biome-${String(this.nextId)}`,
      name,
      ...cell(position),
      foundAt: new Date(this.clock.now()).toISOString(),
      source: details.source,
    }
    this.nextId += 1
    this.biomeList = [...this.biomeList, entry]
    this.save()
    return ok({ entry, isNew: true })
  }

  private save(): void {
    this.store?.save(knowledgeDocument, {
      landmarks: this.landmarkList,
      structures: this.structureList,
      biomes: this.biomeList,
      finds: this.findList,
      nextId: this.nextId,
    })
  }
}
