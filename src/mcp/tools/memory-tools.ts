import { z } from 'zod'
import type { HistoryKind, InstructionLog } from '../../state/instruction-log.js'
import { MAX_NOTE_LENGTH, type NotesStore } from '../../state/notes-store.js'
import {
  MAX_INSTRUCTION_LENGTH,
  type StandingInstructions,
} from '../../state/standing-instructions.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const rememberSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(`What to remember (${String(MAX_NOTE_LENGTH)} characters at most).`),
  tags: z
    .array(z.string().min(1))
    .max(10)
    .default([])
    .describe('Optional short labels, for example ["house", "plan"].'),
})

export class RememberTool implements ToolDefinition<typeof rememberSchema> {
  readonly name = 'remember'
  readonly description =
    'Saves a note about this world that survives restarts and new sessions: plans, where things are, the player preferences. ' +
    'Notes are saved per world and shown in the session briefing. Fails when no world is active.'
  readonly inputSchema = rememberSchema

  constructor(private readonly notes: NotesStore) {}

  execute(input: z.output<typeof rememberSchema>) {
    const note = this.notes.remember(input.text, input.tags)
    return note.ok ? toolOk({ note: note.value }) : toolFail(note.error)
  }
}

const recallSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Only notes whose text or tags contain this (ignoring case).'),
  tag: z.string().optional().describe('Only notes with exactly this tag.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('At most this many notes, newest first.'),
})

export class RecallTool implements ToolDefinition<typeof recallSchema> {
  readonly name = 'recall'
  readonly description =
    'Reads saved notes for this world, newest first, optionally filtered by text or tag. Fails when no world is active.'
  readonly inputSchema = recallSchema

  constructor(private readonly notes: NotesStore) {}

  execute(input: z.output<typeof recallSchema>) {
    const found = this.notes.recall({ query: input.query, tag: input.tag, limit: input.limit })
    return found.ok
      ? toolOk({ count: found.value.length, notes: found.value })
      : toolFail(found.error)
  }
}

const forgetSchema = z.object({
  id: z.string().min(1).describe('The note id, for example "note-4".'),
})

export class ForgetTool implements ToolDefinition<typeof forgetSchema> {
  readonly name = 'forget'
  readonly description = 'Deletes a saved note by id.'
  readonly inputSchema = forgetSchema

  constructor(private readonly notes: NotesStore) {}

  execute(input: z.output<typeof forgetSchema>) {
    const removed = this.notes.forget(input.id)
    return removed.ok ? toolOk({ forgotten: removed.value.id }) : toolFail(removed.error)
  }
}

const historySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe('How many entries, newest last.'),
  kind: z
    .enum(['chat', 'tool', 'event'])
    .optional()
    .describe('Only this kind: what the player said, tool calls, or events.'),
})

export class GetRecentHistoryTool implements ToolDefinition<typeof historySchema> {
  readonly name = 'get_recent_history'
  readonly description =
    'Shows what happened recently in this world, including earlier sessions: what the player asked (chat), the actions ' +
    'taken (tool calls and their outcome), and events. Read-only tools are not recorded.'
  readonly inputSchema = historySchema

  constructor(private readonly history: InstructionLog) {}

  execute(input: z.output<typeof historySchema>) {
    const kind: HistoryKind | undefined = input.kind
    const entries = this.history.recent(input.limit, kind)
    return toolOk({ count: entries.length, entries })
  }
}

const standingSchema = z.object({
  key: z
    .string()
    .min(1)
    .describe(
      'A short name in lowercase letters, digits, and underscores, for example "inventory_full".',
    ),
  text: z
    .string()
    .min(1)
    .describe(`The rule in plain words (${String(MAX_INSTRUCTION_LENGTH)} characters at most).`),
})

export class SetStandingInstructionTool implements ToolDefinition<typeof standingSchema> {
  readonly name = 'set_standing_instruction'
  readonly description =
    'Saves a rule the player gave for how to behave from now on, for example key "inventory_full", text "bring resources to ' +
    'the home chest when there is no space". It survives restarts and is shown in the session briefing; follow it without ' +
    'asking again. Setting an existing key replaces it.'
  readonly inputSchema = standingSchema

  constructor(private readonly standing: StandingInstructions) {}

  execute(input: z.output<typeof standingSchema>) {
    const saved = this.standing.set(input.key, input.text)
    return saved.ok
      ? toolOk({ key: input.key, instructions: this.standing.all() })
      : toolFail(saved.error)
  }
}

const removeSchema = z.object({
  key: z.string().min(1).describe('The key of the standing instruction to remove.'),
})

export class RemoveStandingInstructionTool implements ToolDefinition<typeof removeSchema> {
  readonly name = 'remove_standing_instruction'
  readonly description = 'Removes a standing instruction the player no longer wants.'
  readonly inputSchema = removeSchema

  constructor(private readonly standing: StandingInstructions) {}

  execute(input: z.output<typeof removeSchema>) {
    const removed = this.standing.remove(input.key)
    return removed.ok
      ? toolOk({ removed: input.key, instructions: this.standing.all() })
      : toolFail(removed.error)
  }
}
