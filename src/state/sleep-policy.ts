import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/** What the bot does at nightfall: ask the player, go to bed when it has nothing to do, or leave it alone. */
export type SleepPolicyKind = 'ask' | 'when_idle' | 'never'

export const SLEEP_POLICIES = ['ask', 'when_idle', 'never'] as const

const sleepPolicyDocument = defineDocument({
  key: 'sleep-policy',
  version: 1,
  schema: z.object({ policy: z.enum(SLEEP_POLICIES) }),
  initial: (): { policy: SleepPolicyKind } => ({ policy: 'ask' }),
})

const NOT_ACTIVE =
  'No world is active, so the sleep policy cannot be saved. Connect to a world first.'

/** The player's standing rule for going to bed at night, saved per world. The default is to ask. */
export class SleepPolicy implements ProfileScoped {
  private store: StateStore | undefined
  private policy: SleepPolicyKind = 'ask'

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(sleepPolicyDocument)
    this.store = store
    this.policy = loaded.value.policy
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.policy = 'ask'
  }

  get(): SleepPolicyKind {
    return this.policy
  }

  set(policy: SleepPolicyKind): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.policy = policy
    this.store.save(sleepPolicyDocument, { policy })
    return ok(undefined)
  }
}
