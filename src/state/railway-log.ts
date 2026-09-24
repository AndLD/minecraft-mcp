import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { Position } from '../core/position.types.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
const lineSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  start: pointSchema,
  end: pointSchema,
  layout: z.enum(['surface', 'underground']),
  variant: z.enum(['economy', 'rich']),
  rails: z.number().int(),
  builtAt: z.string(),
})

export type RailwayEntry = z.infer<typeof lineSchema>

const railwaysDocument = defineDocument({
  key: 'railways',
  version: 1,
  schema: z.object({ lines: z.array(lineSchema), nextId: z.number().int() }),
  initial: () => ({ lines: [] as RailwayEntry[], nextId: 1 }),
})

export const MAX_RAILWAYS = 50
const NOT_ACTIVE =
  'No world is active, so railways cannot be saved or read. Connect to a world first.'

export interface NewRailway {
  readonly label: string | undefined
  readonly start: Position
  readonly end: Position
  readonly layout: 'surface' | 'underground'
  readonly variant: 'economy' | 'rich'
  readonly rails: number
}

/** The lines the bot has built in this world, so "put a minecart on the railway" knows which one and where it starts. */
export class RailwayLog implements ProfileScoped {
  private store: StateStore | undefined
  private lines: RailwayEntry[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(railwaysDocument)
    this.store = store
    this.lines = [...loaded.value.lines]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.lines = []
  }

  add(line: NewRailway): Result<RailwayEntry> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const label = line.label?.trim()
    const entry: RailwayEntry = {
      id: `railway-${String(this.nextId)}`,
      label: label === undefined || label === '' ? null : label,
      start: line.start,
      end: line.end,
      layout: line.layout,
      variant: line.variant,
      rails: line.rails,
      builtAt: new Date(this.clock.now()).toISOString(),
    }
    this.nextId += 1
    this.lines = [...this.lines, entry].slice(-MAX_RAILWAYS)
    this.store.save(railwaysDocument, { lines: this.lines, nextId: this.nextId })
    return ok(entry)
  }

  /** The line built last, or undefined. */
  latest(): RailwayEntry | undefined {
    return this.lines[this.lines.length - 1]
  }

  /** A line by id (`railway-2`) or label. */
  resolve(reference: string): RailwayEntry | undefined {
    const wanted = reference.trim().toLowerCase()
    return this.lines.find((line) => line.id === wanted || line.label?.toLowerCase() === wanted)
  }

  all(): readonly RailwayEntry[] {
    return this.lines
  }
}
