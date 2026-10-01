import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { DropKind } from './drop-records.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/** `auto`: fetch the items back by itself. `skip`: leave them and keep the coordinates. */
export type DropRecoveryKind = 'auto' | 'skip'

export const DROP_RECOVERY_KINDS = ['auto', 'skip'] as const

export interface DropRecoveryPolicyValue {
  /** What to do after the bot has died. */
  readonly death: DropRecoveryKind
  /** What to do with items that were dropped for a player and lie unclaimed. */
  readonly unclaimed: DropRecoveryKind
}

const DEFAULTS: DropRecoveryPolicyValue = { death: 'auto', unclaimed: 'auto' }

const policyDocument = defineDocument({
  key: 'drop-recovery-policy',
  version: 1,
  schema: z.object({
    death: z.enum(DROP_RECOVERY_KINDS),
    unclaimed: z.enum(DROP_RECOVERY_KINDS),
  }),
  initial: (): DropRecoveryPolicyValue => DEFAULTS,
})

const NOT_ACTIVE =
  'No world is active, so the drop recovery policy cannot be saved. Connect to a world first.'

/** The player's standing rule for fetching dropped items back, saved per world. The default is to recover. */
export class DropRecoveryPolicy implements ProfileScoped {
  private store: StateStore | undefined
  private value: DropRecoveryPolicyValue = DEFAULTS

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(policyDocument)
    this.store = store
    this.value = loaded.value
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.value = DEFAULTS
  }

  get(): DropRecoveryPolicyValue {
    return this.value
  }

  forKind(kind: DropKind): DropRecoveryKind {
    return this.value[kind]
  }

  set(update: Partial<DropRecoveryPolicyValue>): Result<DropRecoveryPolicyValue> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.value = { ...this.value, ...update }
    this.store.save(policyDocument, this.value)
    return ok(this.value)
  }
}
