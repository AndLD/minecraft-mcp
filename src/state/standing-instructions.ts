import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const standingDocument = defineDocument({
  key: 'standing-instructions',
  version: 1,
  schema: z.object({ instructions: z.record(z.string(), z.string()) }),
  initial: () => ({ instructions: {} }),
})

const KEY_PATTERN = /^[a-z0-9_]{1,40}$/
export const MAX_INSTRUCTION_LENGTH = 500
const NOT_ACTIVE =
  'No world is active, so standing instructions cannot be saved. Connect to a world first.'

/** Rules the player has given for how to behave from now on ("bring resources to the home chest when full"). */
export class StandingInstructions implements ProfileScoped {
  private store: StateStore | undefined
  private instructions: Record<string, string> = {}

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(standingDocument)
    this.store = store
    this.instructions = { ...loaded.value.instructions }
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.instructions = {}
  }

  set(key: string, text: string): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (!KEY_PATTERN.test(key))
      return err('The key must be lowercase letters, digits, and underscores (1-40 characters).')
    const trimmed = text.trim()
    if (trimmed === '')
      return err('The instruction is empty. Use remove_standing_instruction to delete one.')
    if (trimmed.length > MAX_INSTRUCTION_LENGTH) {
      return err(
        `The instruction is too long (${String(MAX_INSTRUCTION_LENGTH)} characters at most).`,
      )
    }
    this.instructions[key] = trimmed
    this.persist()
    return ok(undefined)
  }

  remove(key: string): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (!(key in this.instructions)) return err(`There is no standing instruction "${key}".`)
    this.instructions = Object.fromEntries(
      Object.entries(this.instructions).filter(([k]) => k !== key),
    )
    this.persist()
    return ok(undefined)
  }

  all(): Readonly<Record<string, string>> {
    return { ...this.instructions }
  }

  private persist(): void {
    this.store?.save(standingDocument, { instructions: this.instructions })
  }
}
