import { z } from 'zod'
import { err, ok, type Result } from '../core/result.js'
import type { StateStore } from '../core/state-store.port.js'
import { defineDocument } from './define-document.js'
import type { ProfileScoped } from './profile-scoped.types.js'

/** What a task does when the inventory is full. */
export type InventoryFullKind = 'ask' | 'offload_and_return' | 'stop'

export const INVENTORY_FULL_KINDS = ['ask', 'offload_and_return', 'stop'] as const

export interface StoragePolicyValue {
  readonly kind: InventoryFullKind
  /** How many offload trips one task may make. */
  readonly maxTrips: number
  /** Containers farther than this from where the task stands are not used for offloading. */
  readonly maxDistance: number
}

const DEFAULTS: StoragePolicyValue = { kind: 'ask', maxTrips: 20, maxDistance: 64 }

const policyDocument = defineDocument({
  key: 'storage-policy',
  version: 1,
  schema: z.object({
    kind: z.enum(INVENTORY_FULL_KINDS),
    maxTrips: z.number().int().min(1),
    maxDistance: z.number().min(1),
  }),
  initial: (): StoragePolicyValue => DEFAULTS,
})

const NOT_ACTIVE =
  'No world is active, so the storage policy cannot be saved. Connect to a world first.'

/** The player's standing rule for a full inventory, saved per world. The default is to ask. */
export class StoragePolicy implements ProfileScoped {
  private store: StateStore | undefined
  private value: StoragePolicyValue = DEFAULTS

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

  get(): StoragePolicyValue {
    return this.value
  }

  set(update: Partial<StoragePolicyValue>): Result<StoragePolicyValue> {
    if (this.store === undefined) return err(NOT_ACTIVE)
    this.value = { ...this.value, ...update }
    this.store.save(policyDocument, this.value)
    return ok(this.value)
  }
}
