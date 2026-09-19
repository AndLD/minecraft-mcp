import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

const ruleSchema = z.object({
  id: z.string(),
  containerId: z.string(),
  /** Item names or group names (`logs`, `ores`, `food`, `*`). */
  specs: z.array(z.string()),
  /** Higher wins. */
  priority: z.number().int(),
})

export type StorageRule = z.infer<typeof ruleSchema>

const rulesDocument = defineDocument({
  key: 'storage-rules',
  version: 1,
  schema: z.object({ rules: z.array(ruleSchema), nextId: z.number().int() }),
  initial: () => ({ rules: [] as StorageRule[], nextId: 1 }),
})

export const MAX_RULES = 100
const NOT_ACTIVE =
  'No world is active, so storage rules cannot be saved or read. Connect to a world (and name it if asked) first.'

/** "These kinds of items go into that chest", saved per world. */
export class StorageRules implements ProfileScoped {
  private store: StateStore | undefined
  private rules: StorageRule[] = []
  private nextId = 1

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(rulesDocument)
    this.store = store
    this.rules = [...loaded.value.rules]
    this.nextId = loaded.value.nextId
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.rules = []
  }

  add(containerId: string, specs: readonly string[], priority = 0): Result<StorageRule> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    if (this.rules.length >= MAX_RULES)
      return err(`There are already ${String(MAX_RULES)} rules. Remove some first.`)
    const clean = [...new Set(specs.map((spec) => spec.trim()).filter((spec) => spec !== ''))]
    if (clean.length === 0) return err('Name at least one item or group.')
    const rule: StorageRule = {
      id: `rule-${String(this.nextId)}`,
      containerId,
      specs: clean,
      priority,
    }
    this.nextId += 1
    this.rules.push(rule)
    this.persist()
    return ok(rule)
  }

  remove(id: string): Result<StorageRule> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    const rule = this.rules.find((candidate) => candidate.id === id)
    if (rule === undefined) return err(`There is no storage rule ${id}.`)
    this.rules = this.rules.filter((candidate) => candidate.id !== id)
    this.persist()
    return ok(rule)
  }

  /** Drops the rules of a container that no longer exists. */
  removeForContainer(containerId: string): void {
    const kept = this.rules.filter((rule) => rule.containerId !== containerId)
    if (kept.length === this.rules.length) return
    this.rules = kept
    this.persist()
  }

  list(): Result<readonly StorageRule[]> {
    return this.store === undefined ? err(NOT_ACTIVE) : ok([...this.rules])
  }

  /** Highest priority first; the older rule wins a tie. */
  ordered(): readonly StorageRule[] {
    return [...this.rules].sort((a, b) => b.priority - a.priority)
  }

  private persist(): void {
    this.store?.save(rulesDocument, { rules: this.rules, nextId: this.nextId })
  }
}
