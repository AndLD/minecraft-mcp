import type { BiomeReader } from '../../core/biome.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Random } from '../../core/random.port.js'
import { err, ok } from '../../core/result.js'
import type { ServerCommands } from '../../core/server-commands.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { STRUCTURE_LOCATE_IDS, type StructureKind } from '../../core/structure-kinds.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type {
  BiomeRecord,
  StructureRecord,
  WorldKnowledgeStore,
} from '../../knowledge/world-knowledge-store.js'
import type { ExplorationStrategy } from './exploration-strategy.types.js'
import { FrontierExplorer, SpiralExplorer, TowardExplorer } from './exploration-strategies.js'
import { parseLocateReply } from './locate-reply.js'
import { matchName } from './name-match.js'
import type { StructureScanner } from './structure-scanner.js'
import { findSurface } from './surface-finder.js'

export type ExplorationStyle = 'spiral' | 'frontier'

/** Exactly one of `kind`, `biome`, and `mob` says what to look for. */
export interface ExploreForStructureInput {
  readonly kind?: StructureKind | undefined
  /** A biome name as the player said it (`desert`, `cherry grove`); a word like `jungle` covers every jungle biome. */
  readonly biome?: string | undefined
  /** A mob type as the player said it (`fox`, `polar bear`). */
  readonly mob?: string | undefined
  /** How far from where the search started it may go, in blocks. */
  readonly maxDistance: number
  readonly maxMinutes: number
  readonly strategy: ExplorationStyle
  /** Ask the server where the nearest one is first (only works when the bot may use `/locate`). */
  readonly useLocate: boolean
  /** Look for one not yet known instead of answering with a known one. */
  readonly onlyNew: boolean
  /** Walk back to this landmark when done, found or not. */
  readonly returnTo: string | undefined
}

/** What was found: a structure, a place in a biome, or a mob (seen just now, so its position is where it stood). */
export interface Found {
  /** A structure kind, or `biome`, or `mob`. */
  readonly kind: string
  /** The biome or mob type. */
  readonly name?: string | undefined
  readonly x: number
  readonly y: number
  readonly z: number
  readonly source: 'scan' | 'locate'
  readonly id?: string | undefined
  readonly detail?: string | undefined
}

export interface ExploreOutput {
  readonly found: Found
  /** It was already in the knowledge store: nothing was explored. */
  readonly alreadyKnown: boolean
  /** The bot stood near it (false when the server named it but it is out of reach or range). */
  readonly reached: boolean
  readonly distanceFromStart: number
  /** Other structures seen on the way, and now recorded. */
  readonly discovered: readonly StructureRecord[]
  readonly hops: number
  readonly returned?: boolean
}

export interface ExploreForStructureDeps {
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly biomes: BiomeReader
  readonly entities: EntityScanner
  readonly scanner: StructureScanner
  readonly knowledge: WorldKnowledgeStore
  readonly clock: Clock
  readonly random: Random
  /** Absent where the server cannot be asked. */
  readonly commands?: ServerCommands
}

type Stop = 'found' | 'arrived' | 'exhausted' | 'time' | 'stuck' | 'aborted'

/** Consecutive trips that failed before the bot gives up: it is boxed in, or the terrain is not walkable. */
const MAX_FAILURES = 5
const ARRIVE_WITHIN = 3
const LOCATE_TIMEOUT_MS = 5_000
const MINUTE_MS = 60_000

type Seek =
  | { readonly type: 'structure'; readonly kind: StructureKind; readonly label: string }
  | { readonly type: 'biome'; readonly names: readonly string[]; readonly label: string }
  | { readonly type: 'mob'; readonly names: readonly string[]; readonly label: string }

/** How far around the bot a biome is sampled and a mob is looked for. */
const LOOK_RADIUS = 48
const BIOME_RINGS = [16, 32, 48]
const APPROACH_WITHIN = 4

const biomeFound = (entry: BiomeRecord): Found => ({
  kind: 'biome',
  name: entry.name,
  x: entry.x,
  y: entry.y,
  z: entry.z,
  source: entry.source,
  id: entry.id,
})

const flat = (a: Position, b: Position): number => Math.hypot(a.x - b.x, a.z - b.z)

/** Walks the world in short hops, looking at each stop for the kind of structure it was asked to find. */
export class ExploreForStructureSkill implements Skill<ExploreForStructureInput, ExploreOutput> {
  readonly name = 'explore_for_structure'

  constructor(private readonly deps: ExploreForStructureDeps) {}

  async run(
    input: ExploreForStructureInput,
    context: SkillContext,
  ): Promise<SkillResult<ExploreOutput>> {
    const { vitals, knowledge } = this.deps
    const start = vitals.read()
    if (start === undefined)
      return err({ reason: 'not_connected', message: 'The bot is not in a world.' })
    if (/nether|end/i.test(start.dimension))
      return err({
        reason: 'wrong_dimension',
        message: `Exploring for structures is only built for the Overworld (the bot is in ${start.dimension}).`,
      })
    if (!knowledge.active)
      return err({
        reason: 'no_world_profile',
        message: 'No world is active, so finds cannot be saved. Connect to a world first.',
      })
    const seek = this.resolveSeek(input)
    if (!seek.ok) return err(seek.error)
    const home = input.returnTo === undefined ? undefined : knowledge.landmark(input.returnTo)
    if (input.returnTo !== undefined && home === undefined)
      return err({
        reason: 'unknown_landmark',
        message: `There is no landmark called "${input.returnTo}". list_landmarks shows the ones set.`,
      })

    const origin = start.position
    const search = new Search(this.deps, input, seek.value, context, origin)
    const result = await search.run()
    if (home !== undefined) {
      const back = await this.deps.navigator.goToPosition(
        { x: home.x, y: home.y, z: home.z },
        ARRIVE_WITHIN,
        {
          signal: context.signal,
        },
      )
      return this.withReturn(result, back.ok)
    }
    return result
  }

  private resolveSeek(
    input: ExploreForStructureInput,
  ): { ok: true; value: Seek } | { ok: false; error: { reason: string; message: string } } {
    const given = [input.kind, input.biome, input.mob].filter((value) => value !== undefined)
    if (given.length !== 1)
      return {
        ok: false,
        error: {
          reason: 'bad_target',
          message: 'Say what to look for: exactly one of kind (a structure), biome, or mob.',
        },
      }
    if (input.kind !== undefined)
      return { ok: true, value: { type: 'structure', kind: input.kind, label: input.kind } }
    if (input.biome !== undefined) {
      const matched = matchName(input.biome, this.deps.biomes.knownBiomeNames())
      return matched.ok
        ? {
            ok: true,
            value: { type: 'biome', names: matched.names, label: `${input.biome} biome` },
          }
        : unknownName('unknown_biome', 'biome', input.biome, matched.suggestions)
    }
    const wanted = input.mob ?? ''
    const matched = matchName(wanted, this.deps.entities.knownEntityNames())
    return matched.ok
      ? { ok: true, value: { type: 'mob', names: matched.names, label: wanted } }
      : unknownName('unknown_mob', 'mob', wanted, matched.suggestions)
  }

  private withReturn(
    result: SkillResult<ExploreOutput>,
    returned: boolean,
  ): SkillResult<ExploreOutput> {
    if (result.ok) return ok({ ...result.value, returned })
    return err({ ...result.error, detail: { ...result.error.detail, returned } })
  }
}

function unknownName(
  reason: string,
  what: string,
  given: string,
  suggestions: readonly string[],
): { ok: false; error: { reason: string; message: string } } {
  const hint = suggestions.length === 0 ? '' : ` Did you mean: ${suggestions.join(', ')}?`
  return {
    ok: false,
    error: { reason, message: `The game has no ${what} called "${given}".${hint}` },
  }
}

/** One run: the bookkeeping of where the bot has been and what it has seen. */
class Search {
  private current: Position
  private readonly visited: Position[]
  private readonly discovered: StructureRecord[] = []
  private readonly startedAt: number
  private hops = 0
  private failures = 0
  private foundHere: Found | undefined

  constructor(
    private readonly deps: ExploreForStructureDeps,
    private readonly input: ExploreForStructureInput,
    private readonly seek: Seek,
    private readonly context: SkillContext,
    private readonly origin: Position,
  ) {
    this.current = origin
    this.visited = [origin]
    this.startedAt = deps.clock.now()
  }

  async run(): Promise<SkillResult<ExploreOutput>> {
    const { input } = this

    const known = input.onlyNew ? undefined : this.known()
    if (known !== undefined && flat(known, this.origin) <= input.maxDistance)
      return ok(this.output(known, { alreadyKnown: true, reached: true }))

    this.look()
    const seenNow = this.seen()
    if (seenNow !== undefined) return this.finish(seenNow)

    const located = await this.locate()
    if (located !== undefined) return located

    const strategy: ExplorationStrategy =
      input.strategy === 'spiral' ? new SpiralExplorer() : new FrontierExplorer(this.deps.random)
    const stopped = await this.travel(strategy)
    const seenAfter = this.seen()
    if (seenAfter !== undefined) return this.finish(seenAfter)
    return this.failure(stopped)
  }

  /** What the knowledge store already holds of the wanted thing (a mob is never known: it moves). */
  private known(): Found | undefined {
    const { knowledge } = this.deps
    if (this.seek.type === 'structure') return knowledge.nearest(this.seek.kind, this.origin)
    if (this.seek.type === 'biome') {
      const entry = knowledge.nearestBiome(this.seek.names, this.origin)
      return entry === undefined ? undefined : biomeFound(entry)
    }
    return undefined
  }

  /** The bot has seen it: a biome or a mob is walked up to, a structure is where it is. */
  private async finish(found: Found): Promise<SkillResult<ExploreOutput>> {
    const { navigator, entities, blocks } = this.deps
    if (this.seek.type === 'structure' || flat(found, this.current) <= APPROACH_WITHIN)
      return ok(this.output(found, { alreadyKnown: false, reached: true }))

    const ground = findSurface(blocks, found.x, found.z, this.current.y)
    const target = this.seek.type === 'biome' && ground.kind === 'ground' ? ground.position : found
    const trip = await navigator.goToPosition(
      { x: target.x, y: target.y, z: target.z },
      APPROACH_WITHIN,
      { signal: this.context.signal },
    )
    if (!trip.ok && trip.error.reason === 'aborted') return this.failure('aborted')
    if (trip.ok) this.current = trip.value
    const names = this.seek.names
    const nearest = entities
      .nearby(LOOK_RADIUS)
      .find((entity) => this.seek.type === 'mob' && names.includes(entity.name))
    const moved =
      nearest === undefined
        ? found
        : {
            ...found,
            x: Math.round(nearest.position.x),
            y: Math.round(nearest.position.y),
            z: Math.round(nearest.position.z),
          }
    return ok(this.output(moved, { alreadyKnown: false, reached: trip.ok }))
  }

  /** What to ask the server, and how to file the answer; none where the server cannot say. */
  private locateRequest():
    | { command: string; record: (at: Position) => SkillResult<{ found: Found; isNew: boolean }> }
    | undefined {
    const { knowledge } = this.deps
    if (this.seek.type === 'structure') {
      const id = STRUCTURE_LOCATE_IDS[this.seek.kind]
      const kind = this.seek.kind
      if (id === undefined) return undefined
      return {
        command: `locate structure ${id}`,
        record: (at) => {
          const recorded = knowledge.record(kind, at, { source: 'locate' })
          if (!recorded.ok) return err({ reason: 'no_world_profile', message: recorded.error })
          if (recorded.value.isNew) this.discovered.push(recorded.value.entry)
          return ok({ found: recorded.value.entry, isNew: recorded.value.isNew })
        },
      }
    }
    const only =
      this.seek.type === 'biome' && this.seek.names.length === 1 ? this.seek.names[0] : undefined
    if (only === undefined) return undefined
    return {
      command: `locate biome minecraft:${only}`,
      record: (at) => {
        const recorded = knowledge.recordBiome(only, at, { source: 'locate' })
        if (!recorded.ok) return err({ reason: 'no_world_profile', message: recorded.error })
        return ok({ found: biomeFound(recorded.value.entry), isNew: recorded.value.isNew })
      },
    }
  }

  /** Asks the server for the nearest one; then either walks there or, when it is out of range, only records it. */
  private async locate(): Promise<SkillResult<ExploreOutput> | undefined> {
    const { commands } = this.deps
    const request = this.locateRequest()
    if (!this.input.useLocate || this.input.onlyNew || request === undefined) return undefined
    if (commands?.available('locate') !== true) return undefined

    const reply = await commands.run(request.command, {
      signal: this.context.signal,
      timeoutMs: LOCATE_TIMEOUT_MS,
    })
    if (!reply.ok || reply.value.kind !== 'ok') return undefined
    const place = parseLocateReply(reply.value.reply)
    if (place === undefined) return undefined
    const target = { x: place.x, y: this.origin.y, z: place.z }
    const recorded = request.record(target)
    if (!recorded.ok) return recorded
    this.context.progress(
      `The server puts the nearest ${this.seek.label} at ${String(place.x)}, ${String(place.z)}`,
    )

    if (flat(target, this.origin) > this.input.maxDistance)
      return ok(this.output(recorded.value.found, { alreadyKnown: false, reached: false }))

    const stopped = await this.travel(new TowardExplorer(target), 'arrived')
    if (stopped === 'aborted') return this.failure('aborted')
    const seen = this.seen()
    if (seen !== undefined) return this.finish(seen)
    return ok(
      this.output(recorded.value.found, {
        alreadyKnown: false,
        reached: stopped === 'arrived',
      }),
    )
  }

  /** Hops from waypoint to waypoint until the strategy runs out, the wanted structure is seen, or a limit is hit. */
  private async travel(
    strategy: ExplorationStrategy,
    whenDone: 'exhausted' | 'arrived' = 'exhausted',
  ): Promise<Stop> {
    const { navigator, clock, blocks } = this.deps
    for (;;) {
      if (this.context.signal.aborted) return 'aborted'
      if (clock.now() - this.startedAt > this.input.maxMinutes * MINUTE_MS) return 'time'
      const waypoint = strategy.nextWaypoint({
        origin: this.origin,
        current: this.current,
        visited: this.visited,
        maxDistance: this.input.maxDistance,
      })
      if (waypoint === null) return this.seen() === undefined ? whenDone : 'found'
      this.visited.push(waypoint)

      const ground = findSurface(blocks, waypoint.x, waypoint.z, this.current.y)
      if (ground.kind !== 'ground') continue

      const trip = await navigator.goToPosition(ground.position, ARRIVE_WITHIN, {
        signal: this.context.signal,
      })
      if (!trip.ok) {
        if (trip.error.reason === 'aborted') return 'aborted'
        this.failures += 1
        if (this.failures >= MAX_FAILURES) return 'stuck'
        continue
      }
      this.failures = 0
      this.hops += 1
      this.current = trip.value
      this.visited.push(trip.value)
      this.context.progress(
        `Hop ${String(this.hops)}: ${String(Math.round(flat(this.current, this.origin)))} blocks from the start, ${String(this.discovered.length)} structures found`,
      )
      this.look()
      if (this.seen() !== undefined) return 'found'
    }
  }

  /** The wanted structure, once one has been seen (read through a method: `look` sets it out of the compiler's sight). */
  private seen(): Found | undefined {
    return this.foundHere
  }

  /** Records every structure in view; remembers the one that was asked for, or checks for the biome or mob. */
  private look(): void {
    const { scanner, knowledge } = this.deps
    for (const hit of scanner.scan()) {
      const recorded = knowledge.record(hit.kind, hit.position, {
        source: 'scan',
        detail: hit.detail,
      })
      if (!recorded.ok) continue
      if (recorded.value.isNew) {
        this.discovered.push(recorded.value.entry)
        this.context.progress(
          `Found a ${hit.kind} at ${String(hit.position.x)}, ${String(hit.position.y)}, ${String(hit.position.z)}`,
        )
      }
      if (
        this.seek.type === 'structure' &&
        hit.kind === this.seek.kind &&
        (recorded.value.isNew || !this.input.onlyNew)
      )
        this.foundHere ??= recorded.value.entry
    }
    if (this.seek.type === 'biome') this.lookBiome(this.seek.names)
    if (this.seek.type === 'mob') this.lookMob(this.seek.names)
  }

  /** Samples the biome under the bot and on rings around it, nearest first. */
  private lookBiome(names: readonly string[]): void {
    const { biomes, knowledge } = this.deps
    const y = Math.round(this.current.y)
    const spots = [{ dx: 0, dz: 0 }]
    for (const ring of BIOME_RINGS)
      for (let k = 0; k < 8; k += 1) {
        const angle = (k * Math.PI) / 4
        spots.push({
          dx: Math.round(ring * Math.cos(angle)),
          dz: Math.round(ring * Math.sin(angle)),
        })
      }
    for (const { dx, dz } of spots) {
      const at = { x: Math.round(this.current.x) + dx, y, z: Math.round(this.current.z) + dz }
      const name = biomes.biomeAt(at)
      if (name === undefined || !names.includes(name)) continue
      const recorded = knowledge.recordBiome(name, at, { source: 'scan' })
      if (!recorded.ok) continue
      if (recorded.value.isNew)
        this.context.progress(`Found ${name} at ${String(at.x)}, ${String(at.z)}`)
      if (recorded.value.isNew || !this.input.onlyNew) {
        this.foundHere ??= biomeFound(recorded.value.entry)
        return
      }
    }
  }

  private lookMob(names: readonly string[]): void {
    const { entities } = this.deps
    const seen = entities
      .nearby(LOOK_RADIUS)
      .filter((entity) => entity.category !== 'player' && names.includes(entity.name))
    const nearest = seen[0]
    if (nearest === undefined) return
    this.foundHere ??= {
      kind: 'mob',
      name: nearest.name,
      x: Math.round(nearest.position.x),
      y: Math.round(nearest.position.y),
      z: Math.round(nearest.position.z),
      source: 'scan',
      detail: `${String(seen.length)} in view`,
    }
    this.context.progress(`Saw a ${nearest.name}`)
  }

  private output(found: Found, flags: { alreadyKnown: boolean; reached: boolean }): ExploreOutput {
    return {
      found,
      alreadyKnown: flags.alreadyKnown,
      reached: flags.reached,
      distanceFromStart: Math.round(flat(found, this.origin)),
      discovered: this.discovered.filter((entry) => entry.id !== found.id),
      hops: this.hops,
    }
  }

  private failure(stopped: Stop): SkillResult<ExploreOutput> {
    const { maxDistance, maxMinutes } = this.input
    const kind = this.seek.label
    const covered = Math.round(
      this.visited.reduce((far, place) => Math.max(far, flat(place, this.origin)), 0),
    )
    const detail = {
      stopped,
      hops: this.hops,
      farthest: covered,
      distanceFromStart: Math.round(distanceBetween(this.current, this.origin)),
      discovered: this.discovered,
    }
    switch (stopped) {
      case 'aborted':
        return err({ reason: 'aborted', message: 'The search was cancelled.', detail })
      case 'time':
        return err({
          reason: 'not_found',
          message: `No ${kind} within ${String(maxMinutes)} minutes (${String(this.hops)} hops, up to ${String(covered)} blocks from the start). Try again with more time, or from another place.`,
          detail,
        })
      case 'stuck':
        return err({
          reason: 'stuck',
          message: `The bot could not get anywhere: ${String(MAX_FAILURES)} trips in a row failed (water, cliffs, or a closed-in spot). Move it and try again.`,
          detail,
        })
      default:
        return err({
          reason: 'not_found',
          message: `No ${kind} within ${String(maxDistance)} blocks of the start (${String(this.hops)} hops). Try from another place, or with a larger max_distance.`,
          detail,
        })
    }
  }
}
