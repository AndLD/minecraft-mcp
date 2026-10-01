import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

export const EGG_RELEASE_KINDS = ['hatch', 'store'] as const
export type EggRelease = (typeof EGG_RELEASE_KINDS)[number]

export interface EggPolicyValue {
  /** Share of collected eggs stored instead of released, 0 to 1. Rounded up, so any eggs at all keep at least one. */
  readonly storeFraction: number
  /** "hatch" (default): release the rest into the pen for a chance at chicks. "store": keep everything. */
  readonly release: EggRelease
}

export const DEFAULT_EGG_POLICY: EggPolicyValue = { storeFraction: 0.1, release: 'hatch' }

const eggPolicyDocument = defineDocument({
  key: 'egg-policy',
  version: 1,
  schema: z.object({
    storeFraction: z.number().min(0).max(1),
    release: z.enum(EGG_RELEASE_KINDS),
  }),
  initial: (): EggPolicyValue => DEFAULT_EGG_POLICY,
})

const NOT_ACTIVE =
  'No world is active, so the egg policy cannot be saved. Connect to a world first.'

/** The standing answer for how `collect_eggs` splits what it picks up, saved per world. Modeled on `FoodPolicy`. */
export class EggPolicy implements ProfileScoped {
  private store: StateStore | undefined
  private value: EggPolicyValue = DEFAULT_EGG_POLICY

  async attach(store: StateStore): Promise<readonly string[]> {
    const loaded = await store.load(eggPolicyDocument)
    this.store = store
    this.value = loaded.value
    return loaded.warning === undefined ? [] : [loaded.warning]
  }

  detach(): void {
    this.store = undefined
    this.value = DEFAULT_EGG_POLICY
  }

  get(): EggPolicyValue {
    return this.value
  }

  set(value: EggPolicyValue): Result<void> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.value = value
    this.store.save(eggPolicyDocument, value)
    return ok(undefined)
  }
}
