import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/**
 * What the bot does when a walk meets an iron door. `ask`: report the switches found and wait for the
 * player's say-so before trying them. `auto`: press the switches itself. `never`: never try, always report
 * the door as needing a switch.
 */
export type SwitchOpenPolicy = 'ask' | 'auto' | 'never'

export const SWITCH_OPEN_POLICIES = ['ask', 'auto', 'never'] as const

const switchPolicyDocument = defineDocument({
  key: 'switch-policy',
  version: 1,
  schema: z.object({ policy: z.enum(SWITCH_OPEN_POLICIES) }),
  initial: (): { policy: SwitchOpenPolicy } => ({ policy: 'ask' }),
})

const NOT_ACTIVE =
  'No world is active, so the switch policy cannot be saved. Connect to a world first.'

/** The player's standing rule for iron doors met while walking, saved per world. The default is to ask. */
export class SwitchPolicy implements ProfileScoped {
  private store: StateStore | undefined
  private policy: SwitchOpenPolicy = 'ask'

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(switchPolicyDocument)
    this.store = store
    this.policy = loaded.value.policy
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.policy = 'ask'
  }

  get(): SwitchOpenPolicy {
    return this.policy
  }

  set(policy: SwitchOpenPolicy): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.policy = policy
    this.store.save(switchPolicyDocument, { policy })
    return ok(undefined)
  }
}
