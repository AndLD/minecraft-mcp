import type { StateStore } from '../core/state-store.port.js'

/** State that belongs to one world profile: loaded when the profile becomes active, released when it closes. */
export interface ProfileScoped {
  /** Loads the profile's data. Returns warnings (for example a recovered corrupt file). */
  attach(store: StateStore): Promise<readonly string[]>
  /** Stops using the store. Pending writes are flushed by the manager. */
  detach(): void
}
