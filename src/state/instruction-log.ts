import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const HISTORY_KINDS = ['chat', 'tool', 'event'] as const
export type HistoryKind = (typeof HISTORY_KINDS)[number]

const entrySchema = z.object({ at: z.string(), kind: z.enum(HISTORY_KINDS), text: z.string() })

export type HistoryEntry = z.infer<typeof entrySchema>

const historyDocument = defineDocument({
  key: 'history',
  version: 1,
  schema: z.object({ entries: z.array(entrySchema) }),
  initial: () => ({ entries: [] as HistoryEntry[] }),
})

export const MAX_HISTORY_ENTRIES = 300
const MAX_ENTRY_LENGTH = 300

/** A bounded record of what the owner asked, what tools ran, and what happened. The oldest entries are dropped. */
export class InstructionLog implements ProfileScoped {
  private store: StateStore | undefined
  private entries: HistoryEntry[] = []

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(historyDocument)
    this.store = store
    this.entries = [...loaded.value.entries]
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.entries = []
  }

  /** Does nothing while no world is active. */
  record(kind: HistoryKind, text: string): void {
    if (this.store === undefined) return
    const clipped =
      text.length > MAX_ENTRY_LENGTH ? `${text.slice(0, MAX_ENTRY_LENGTH - 1)}…` : text
    this.entries.push({ at: new Date(this.clock.now()).toISOString(), kind, text: clipped })
    if (this.entries.length > MAX_HISTORY_ENTRIES)
      this.entries.splice(0, this.entries.length - MAX_HISTORY_ENTRIES)
    this.store.save(historyDocument, { entries: this.entries })
  }

  /** The latest entries in chronological order. */
  recent(limit: number, kind?: HistoryKind): readonly HistoryEntry[] {
    const matching =
      kind === undefined ? this.entries : this.entries.filter((entry) => entry.kind === kind)
    return matching.slice(-limit)
  }
}
