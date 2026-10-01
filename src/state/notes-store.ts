import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const noteSchema = z.object({
  id: z.string(),
  text: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type Note = z.infer<typeof noteSchema>

const notesDocument = defineDocument({
  key: 'notes',
  version: 1,
  schema: z.object({ notes: z.array(noteSchema), nextId: z.number().int() }),
  initial: () => ({ notes: [] as Note[], nextId: 1 }),
})

export const MAX_NOTES = 200
export const MAX_NOTE_LENGTH = 2000
const MAX_TAGS = 10
const MAX_TAG_LENGTH = 30
const NOT_ACTIVE =
  'No world is active, so notes cannot be saved or read. Connect to a world (and name it if asked) first.'

export interface RecallQuery {
  /** Matches note text and tags, ignoring case. */
  readonly query?: string | undefined
  readonly tag?: string | undefined
  readonly limit?: number | undefined
}

/** Free-text notes the agent keeps about the world, its plans, and the player's preferences. */
export class NotesStore implements ProfileScoped {
  private store: StateStore | undefined
  private notes: Note[] = []
  private nextId = 1

  constructor(private readonly clock: Clock) {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(notesDocument)
    this.store = store
    this.notes = [...loaded.value.notes]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.notes = []
  }

  remember(text: string, tags: readonly string[] = []): Result<Note> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const trimmed = text.trim()
    if (trimmed === '') return err('The note is empty.')
    if (trimmed.length > MAX_NOTE_LENGTH)
      return err(`The note is too long (${String(MAX_NOTE_LENGTH)} characters at most).`)
    if (this.notes.length >= MAX_NOTES)
      return err(`There are already ${String(MAX_NOTES)} notes. Forget some before adding more.`)

    const now = new Date(this.clock.now()).toISOString()
    const note: Note = {
      id: `note-${String(this.nextId)}`,
      text: trimmed,
      tags: normalizeTags(tags),
      createdAt: now,
      updatedAt: now,
    }
    this.nextId += 1
    this.notes.push(note)
    this.persist()
    return ok(note)
  }

  /** Newest first. */
  recall(query: RecallQuery = {}): Result<readonly Note[]> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const needle = query.query?.trim().toLowerCase()
    const tag = query.tag?.trim().toLowerCase()
    const matches = this.notes
      .filter((note) => tag === undefined || note.tags.includes(tag))
      .filter(
        (note) =>
          needle === undefined ||
          needle === '' ||
          note.text.toLowerCase().includes(needle) ||
          note.tags.some((t) => t.includes(needle)),
      )
      .reverse()
    return ok(matches.slice(0, query.limit ?? matches.length))
  }

  forget(id: string): Result<Note> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const note = this.notes.find((n) => n.id === id)
    if (note === undefined) return err(`There is no note ${id}.`)
    this.notes = this.notes.filter((n) => n.id !== id)
    this.persist()
    return ok(note)
  }

  /** The latest notes, newest first; empty when no world is active. */
  latest(limit: number): readonly Note[] {
    return [...this.notes].reverse().slice(0, limit)
  }

  private persist(): void {
    this.store?.save(notesDocument, { notes: this.notes, nextId: this.nextId })
  }
}

function normalizeTags(tags: readonly string[]): string[] {
  const clean = tags
    .map((tag) => tag.trim().toLowerCase().slice(0, MAX_TAG_LENGTH))
    .filter((tag) => tag !== '')
  return [...new Set(clean)].slice(0, MAX_TAGS)
}
