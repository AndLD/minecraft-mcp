import type { Logger } from '../core/logger.js'
import type { StateStore } from '../core/state-store.port.js'
import type { WorldFingerprint } from '../core/world-identifier.port.js'
import type { ProfileScoped } from './profile-scoped.types.js'
import type { WorldRegistry, WorldResolution } from './world-registry.js'

export interface WorldOpenResult {
  readonly resolution: WorldResolution
  /** The active profile, or undefined when the world could not be identified yet. */
  readonly profile: string | undefined
  readonly previousSessionAt: string | null
  readonly warnings: readonly string[]
}

export interface WorldStateManagerOptions {
  readonly registry: WorldRegistry
  /** Creates the store for one profile's directory. */
  readonly storeForProfile: (profile: string) => StateStore
  readonly components: readonly ProfileScoped[]
  readonly logger: Logger
}

/** Activates the state of the world the bot joined, and releases it (flushing writes) when it leaves. */
export class WorldStateManager {
  private readonly registry: WorldRegistry
  private readonly storeForProfile: (profile: string) => StateStore
  private readonly components: readonly ProfileScoped[]
  private readonly logger: Logger
  private active: { readonly profile: string; readonly store: StateStore } | undefined
  private opened: WorldOpenResult | undefined
  private closing: Promise<void> | undefined

  constructor(options: WorldStateManagerOptions) {
    this.registry = options.registry
    this.storeForProfile = options.storeForProfile
    this.components = options.components
    this.logger = options.logger
  }

  get activeProfile(): string | undefined {
    return this.active?.profile
  }

  /** What became of the most recent world the bot joined (kept after closing, for the briefing). */
  get lastOpen(): WorldOpenResult | undefined {
    return this.opened
  }

  listWorlds(): ReturnType<WorldRegistry['list']> {
    return this.registry.list()
  }

  /** Recognizes the world (or uses the name given) and activates its state. */
  async open(fingerprint: WorldFingerprint, explicitProfile?: string): Promise<WorldOpenResult> {
    await this.close()
    return this.activate(await this.registry.resolve(fingerprint, explicitProfile))
  }

  /** Binds the connected world to a profile name and activates it (used when identification needs help). */
  async bind(name: string, fingerprint: WorldFingerprint): Promise<WorldOpenResult> {
    await this.close()
    return this.activate(await this.registry.bind(name, fingerprint))
  }

  /**
   * Releases the active profile and writes everything pending. Safe to call several times at once:
   * every caller resolves only after the write has finished, so a shutdown never outruns a disconnect's flush.
   */
  close(): Promise<void> {
    this.closing ??= this.closeActive().finally(() => {
      this.closing = undefined
    })
    return this.closing
  }

  private async closeActive(): Promise<void> {
    if (this.active === undefined) return
    const { store, profile } = this.active
    this.active = undefined
    for (const component of this.components) component.detach()
    await store.flush()
    this.logger.info('Closed world state', { profile })
  }

  private async activate(
    resolved: Awaited<ReturnType<WorldRegistry['resolve']>>,
  ): Promise<WorldOpenResult> {
    const { resolution } = resolved
    const profile =
      resolution.kind === 'matched' || resolution.kind === 'created' || resolution.kind === 'named'
        ? resolution.profile
        : undefined
    const warnings = [...resolved.warnings]
    if (profile !== undefined) {
      const store = this.storeForProfile(profile)
      for (const component of this.components) warnings.push(...(await component.attach(store)))
      this.active = { profile, store }
      this.logger.info('Opened world state', { profile, kind: resolution.kind })
    }
    this.opened = { resolution, profile, previousSessionAt: resolved.previousSessionAt, warnings }
    return this.opened
  }
}
