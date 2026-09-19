import { z } from 'zod'
import type { Clock } from '../core/clock.port.js'
import type { StateStore } from '../core/state-store.port.js'
import type { WorldFingerprint } from '../core/world-identifier.port.js'
import { defineDocument } from './define-document.js'
import { toProfileName } from './profile-name.js'
import { hasUsableSignals, MATCH_THRESHOLD, matchScore } from './world-match.js'

const fingerprintSchema = z.object({
  seed: z.string().nullable(),
  worldName: z.string().nullable(),
  spawn: z.object({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
})

const profileSchema = z.object({
  name: z.string(),
  fingerprint: fingerprintSchema,
  createdAt: z.string(),
  lastConnectedAt: z.string().nullable(),
})

export type WorldProfile = z.infer<typeof profileSchema>

const worldsDocument = defineDocument({
  key: 'worlds',
  version: 1,
  schema: z.object({ profiles: z.array(profileSchema) }),
  initial: () => ({ profiles: [] as WorldProfile[] }),
})

/** What became of the world the bot joined. */
export type WorldResolution =
  /** Recognized automatically from its fingerprint. */
  | { readonly kind: 'matched'; readonly profile: string }
  /** Not seen before: a new profile was created. `named` when the name came from the user. */
  | { readonly kind: 'created'; readonly profile: string; readonly named: boolean }
  /** The user named an existing profile. `rebound` when the world looks different from what that profile remembers. */
  | { readonly kind: 'named'; readonly profile: string; readonly rebound: boolean }
  /** The world has no usable signals and no name was given: ask the user. */
  | { readonly kind: 'needs_name'; readonly reason: string }
  /** Several profiles fit equally well: ask the user which one it is. */
  | { readonly kind: 'ambiguous'; readonly candidates: readonly string[] }
  | { readonly kind: 'invalid_name'; readonly name: string }

export interface ResolvedWorld {
  readonly resolution: WorldResolution
  /** When this profile was last connected, before now. */
  readonly previousSessionAt: string | null
  readonly warnings: readonly string[]
}

export interface WorldRegistryOptions {
  /** The root store (`DATA_DIR`), where the list of worlds lives. */
  readonly store: StateStore
  readonly clock: Clock
}

/** Remembers which worlds the bot has been in and recognizes them again by fingerprint. */
export class WorldRegistry {
  private readonly store: StateStore
  private readonly clock: Clock
  private profiles: WorldProfile[] | undefined
  private warning: string | undefined

  constructor(options: WorldRegistryOptions) {
    this.store = options.store
    this.clock = options.clock
  }

  async list(): Promise<readonly WorldProfile[]> {
    return [...(await this.load())]
  }

  /** Finds or creates the profile for the world, by name when one is given, otherwise by fingerprint. */
  async resolve(fingerprint: WorldFingerprint, explicitName?: string): Promise<ResolvedWorld> {
    if (explicitName !== undefined) return this.bind(explicitName, fingerprint)
    const profiles = await this.load()

    const candidates = profiles
      .map((profile) => ({ profile, score: matchScore(profile.fingerprint, fingerprint) }))
      .filter(
        (c): c is { profile: WorldProfile; score: number } =>
          c.score !== undefined && c.score >= MATCH_THRESHOLD,
      )
      .sort((a, b) => b.score - a.score)
    const best = candidates[0]
    if (best !== undefined) {
      const runnerUp = candidates[1]
      if (runnerUp !== undefined && runnerUp.score === best.score) {
        const tied = candidates.filter((c) => c.score === best.score).map((c) => c.profile.name)
        return this.result({ kind: 'ambiguous', candidates: tied }, null)
      }
      const previous = await this.touch(best.profile, fingerprint)
      return this.result({ kind: 'matched', profile: best.profile.name }, previous)
    }

    if (!hasUsableSignals(fingerprint)) {
      return this.result(
        {
          kind: 'needs_name',
          reason: 'The server gave no world seed or name, so the world cannot be recognized.',
        },
        null,
      )
    }
    const created = await this.create(this.uniqueName(fingerprint), fingerprint)
    return this.result({ kind: 'created', profile: created.name, named: false }, null)
  }

  /** Binds the world to the profile with this name (creating it if needed) and remembers its fingerprint. */
  async bind(name: string, fingerprint: WorldFingerprint): Promise<ResolvedWorld> {
    const profileName = toProfileName(name)
    if (profileName === undefined) return this.result({ kind: 'invalid_name', name }, null)

    const profiles = await this.load()
    const existing = profiles.find((profile) => profile.name === profileName)
    if (existing === undefined) {
      const created = await this.create(profileName, fingerprint)
      return this.result({ kind: 'created', profile: created.name, named: true }, null)
    }
    const rebound = matchScore(existing.fingerprint, fingerprint) === undefined
    const previous = await this.touch(existing, fingerprint, true)
    const warnings = rebound
      ? [
          `This world looks different from what profile "${profileName}" remembered (different seed); it was re-bound to this world.`,
        ]
      : []
    return this.result({ kind: 'named', profile: profileName, rebound }, previous, warnings)
  }

  private async load(): Promise<WorldProfile[]> {
    if (this.profiles === undefined) {
      const loaded = await this.store.load(worldsDocument)
      this.profiles = [...loaded.value.profiles]
      this.warning = loaded.warning
    }
    return this.profiles
  }

  private result(
    resolution: WorldResolution,
    previousSessionAt: string | null,
    warnings: readonly string[] = [],
  ): ResolvedWorld {
    const inherited = this.warning === undefined ? [] : [this.warning]
    this.warning = undefined // report a load problem once
    return { resolution, previousSessionAt, warnings: [...inherited, ...warnings] }
  }

  private uniqueName(fingerprint: WorldFingerprint): string {
    const base =
      toProfileName(fingerprint.worldName ?? '') ??
      `world-${(fingerprint.seed ?? 'unknown').slice(0, 6).toLowerCase()}`
    const taken = new Set((this.profiles ?? []).map((profile) => profile.name))
    let candidate = base
    for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${base}-${String(suffix)}`
    return candidate
  }

  private async create(name: string, fingerprint: WorldFingerprint): Promise<WorldProfile> {
    const now = new Date(this.clock.now()).toISOString()
    const profile: WorldProfile = { name, fingerprint, createdAt: now, lastConnectedAt: now }
    this.profiles = [...(await this.load()), profile]
    await this.persist()
    return profile
  }

  /** Marks the profile as connected now and fills in signals it did not have. Returns the previous connection time. */
  private async touch(
    profile: WorldProfile,
    seen: WorldFingerprint,
    replace = false,
  ): Promise<string | null> {
    const previous = profile.lastConnectedAt
    const merged: WorldFingerprint = replace
      ? {
          seed: seen.seed ?? profile.fingerprint.seed,
          worldName: seen.worldName ?? profile.fingerprint.worldName,
          spawn: seen.spawn ?? profile.fingerprint.spawn,
        }
      : {
          seed: profile.fingerprint.seed ?? seen.seed,
          worldName: seen.worldName ?? profile.fingerprint.worldName,
          spawn: seen.spawn ?? profile.fingerprint.spawn,
        }
    const updated: WorldProfile = {
      ...profile,
      fingerprint: merged,
      lastConnectedAt: new Date(this.clock.now()).toISOString(),
    }
    this.profiles = (await this.load()).map((p) => (p.name === profile.name ? updated : p))
    await this.persist()
    return previous
  }

  private async persist(): Promise<void> {
    this.store.save(worldsDocument, { profiles: this.profiles ?? [] })
    await this.store.flush()
  }
}
