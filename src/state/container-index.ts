import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const stackSchema = z.object({ name: z.string(), count: z.number().int() })
const containerSchema = z.object({
  id: z.string(),
  position: pointSchema,
  blockName: z.string(),
  label: z.string().nullable(),
  protected: z.boolean(),
  /** Found by scanning, not pointed at by the player. */
  auto: z.boolean(),
  contents: z.array(stackSchema),
  totalSlots: z.number().int().nullable(),
  emptySlots: z.number().int().nullable(),
  seenAt: z.string().nullable(),
})

export type ContainerEntry = z.infer<typeof containerSchema>

const containersDocument = defineDocument({
  key: 'containers',
  version: 1,
  schema: z.object({ containers: z.array(containerSchema), nextId: z.number().int() }),
  initial: () => ({ containers: [] as ContainerEntry[], nextId: 1 }),
})

export const MAX_CONTAINERS = 200
const NOT_ACTIVE =
  'No world is active, so containers cannot be saved or read. Connect to a world (and name it if asked) first.'

/** Blocks that hold items and can be opened by the bot. */
export const isContainerBlock = (name: string): boolean =>
  name === 'chest' || name === 'trapped_chest' || name === 'barrel' || name.endsWith('shulker_box')

const cell = (position: Position): Position => ({
  x: Math.floor(position.x),
  y: Math.floor(position.y),
  z: Math.floor(position.z),
})

const samePlace = (a: Position, b: Position): boolean => a.x === b.x && a.y === b.y && a.z === b.z

/** The other half of a double chest sits right next to it, at the same height. */
const adjacent = (a: Position, b: Position): boolean =>
  a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1

export interface RegisterOptions {
  readonly label?: string | undefined
  readonly protected?: boolean | undefined
  readonly auto?: boolean | undefined
}

/**
 * The chests, barrels, and shulker boxes the bot knows about in this world: where they are, an optional name
 * ("home", "wood"), whether they are protected, and what was in them the last time they were opened.
 */
export class ContainerIndex implements ProfileScoped {
  private store: StateStore | undefined
  private containers: ContainerEntry[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(containersDocument)
    this.store = store
    this.containers = [...loaded.value.containers]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.containers = []
  }

  /**
   * Remembers a container. Registering a place that is already known (or the other half of a known double chest)
   * returns the existing entry, updating the label and the protected flag when they are given.
   */
  register(
    position: Position,
    blockName: string,
    options: RegisterOptions = {},
  ): Result<ContainerEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (!isContainerBlock(blockName)) return err(`${blockName} is not a container.`)
    const at = cell(position)
    const known = this.containers.find(
      (entry) =>
        samePlace(entry.position, at) ||
        (entry.blockName === blockName &&
          (blockName === 'chest' || blockName === 'trapped_chest') &&
          adjacent(entry.position, at)),
    )
    if (known !== undefined) return this.amend(known.id, options)

    if (this.containers.length >= MAX_CONTAINERS)
      return err(`There are already ${String(MAX_CONTAINERS)} containers. Remove some first.`)
    const label = options.label?.trim() ?? undefined
    if (label !== undefined && label !== '' && this.byLabel(label) !== undefined)
      return err(`The label "${label}" is already used by another container.`)
    const entry: ContainerEntry = {
      id: `container-${String(this.nextId)}`,
      position: at,
      blockName,
      label: label === undefined || label === '' ? null : label,
      protected: options.protected ?? false,
      auto: options.auto ?? false,
      contents: [],
      totalSlots: null,
      emptySlots: null,
      seenAt: null,
    }
    this.nextId += 1
    this.containers.push(entry)
    this.persist()
    return ok(entry)
  }

  /** Changes the label and/or the protected flag. An empty label removes the label. */
  amend(id: string, options: RegisterOptions): Result<ContainerEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const entry = this.containers.find((candidate) => candidate.id === id)
    if (entry === undefined) return err(`There is no container ${id}.`)
    let label = entry.label
    if (options.label !== undefined) {
      const wanted = options.label.trim()
      const other = wanted === '' ? undefined : this.byLabel(wanted)
      if (other !== undefined && other.id !== id)
        return err(`The label "${wanted}" is already used by another container.`)
      label = wanted === '' ? null : wanted
    }
    const updated: ContainerEntry = {
      ...entry,
      label,
      protected: options.protected ?? entry.protected,
      auto: options.label !== undefined || options.protected !== undefined ? false : entry.auto,
    }
    this.replace(updated)
    return ok(updated)
  }

  /** Records what was seen inside when the container was opened. */
  recordContents(
    id: string,
    stacks: readonly { name: string; count: number }[],
    slots: { totalSlots: number; emptySlots: number },
  ): void {
    const entry = this.containers.find((candidate) => candidate.id === id)
    if (this.store === undefined || entry === undefined) return
    const totals = new Map<string, number>()
    for (const stack of stacks) totals.set(stack.name, (totals.get(stack.name) ?? 0) + stack.count)
    this.replace({
      ...entry,
      contents: [...totals].map(([name, count]) => ({ name, count })),
      totalSlots: slots.totalSlots,
      emptySlots: slots.emptySlots,
      seenAt: new Date(this.clock.now()).toISOString(),
    })
  }

  remove(id: string): Result<ContainerEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const entry = this.containers.find((candidate) => candidate.id === id)
    if (entry === undefined) return err(`There is no container ${id}.`)
    this.containers = this.containers.filter((candidate) => candidate.id !== id)
    this.persist()
    return ok(entry)
  }

  list(): Result<readonly ContainerEntry[]> {
    return this.store === undefined ? err(NOT_ACTIVE) : ok([...this.containers])
  }

  /** Every known container; empty when no world is active. */
  all(): readonly ContainerEntry[] {
    return this.containers
  }

  get(id: string): ContainerEntry | undefined {
    return this.containers.find((entry) => entry.id === id)
  }

  byLabel(label: string): ContainerEntry | undefined {
    const wanted = label.trim().toLowerCase()
    return this.containers.find((entry) => entry.label?.toLowerCase() === wanted)
  }

  /** A container by id (`container-3`) or label (`home`). */
  resolve(reference: string): ContainerEntry | undefined {
    return this.get(reference) ?? this.byLabel(reference)
  }

  at(position: Position): ContainerEntry | undefined {
    const wanted = cell(position)
    return this.containers.find((entry) => samePlace(entry.position, wanted))
  }

  private replace(updated: ContainerEntry): void {
    this.containers = this.containers.map((entry) => (entry.id === updated.id ? updated : entry))
    this.persist()
  }

  private persist(): void {
    this.store?.save(containersDocument, { containers: this.containers, nextId: this.nextId })
  }
}
