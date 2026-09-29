import type { Clock } from '../../core/clock.port.js'
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
import type { StructureRecord, WorldKnowledgeStore } from '../../knowledge/world-knowledge-store.js'
import type { ExplorationStrategy } from './exploration-strategy.types.js'
import { FrontierExplorer, SpiralExplorer, TowardExplorer } from './exploration-strategies.js'
import { parseLocateReply } from './locate-reply.js'
import type { StructureScanner } from './structure-scanner.js'
import { findSurface } from './surface-finder.js'

export type ExplorationStyle = 'spiral' | 'frontier'

export interface ExploreForStructureInput {
  readonly kind: StructureKind
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

export interface ExploreOutput {
  readonly found: StructureRecord
  /** The structure was already in the knowledge store: nothing was explored. */
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
    const home = input.returnTo === undefined ? undefined : knowledge.landmark(input.returnTo)
    if (input.returnTo !== undefined && home === undefined)
      return err({
        reason: 'unknown_landmark',
        message: `There is no landmark called "${input.returnTo}". list_landmarks shows the ones set.`,
      })

    const origin = start.position
    const search = new Search(this.deps, input, context, origin)
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

  private withReturn(
    result: SkillResult<ExploreOutput>,
    returned: boolean,
  ): SkillResult<ExploreOutput> {
    if (result.ok) return ok({ ...result.value, returned })
    return err({ ...result.error, detail: { ...result.error.detail, returned } })
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
  private foundHere: StructureRecord | undefined

  constructor(
    private readonly deps: ExploreForStructureDeps,
    private readonly input: ExploreForStructureInput,
    private readonly context: SkillContext,
    private readonly origin: Position,
  ) {
    this.current = origin
    this.visited = [origin]
    this.startedAt = deps.clock.now()
  }

  async run(): Promise<SkillResult<ExploreOutput>> {
    const { knowledge } = this.deps
    const { input } = this

    const known = input.onlyNew ? undefined : knowledge.nearest(input.kind, this.origin)
    if (known !== undefined && flat(known, this.origin) <= input.maxDistance)
      return ok(this.output(known, { alreadyKnown: true, reached: true }))

    this.look()
    const seenNow = this.seen()
    if (seenNow !== undefined)
      return ok(this.output(seenNow, { alreadyKnown: false, reached: true }))

    const located = await this.locate()
    if (located !== undefined) return located

    const strategy: ExplorationStrategy =
      input.strategy === 'spiral' ? new SpiralExplorer() : new FrontierExplorer(this.deps.random)
    const stopped = await this.travel(strategy)
    const seenAfter = this.seen()
    if (seenAfter !== undefined)
      return ok(this.output(seenAfter, { alreadyKnown: false, reached: true }))
    return this.failure(stopped)
  }

  /** Asks the server for the nearest one; then either walks there or, when it is out of range, only records it. */
  private async locate(): Promise<SkillResult<ExploreOutput> | undefined> {
    const { commands, knowledge } = this.deps
    const id = STRUCTURE_LOCATE_IDS[this.input.kind]
    if (!this.input.useLocate || this.input.onlyNew || id === undefined) return undefined
    if (commands?.available('locate') !== true) return undefined

    const reply = await commands.run(`locate structure ${id}`, {
      signal: this.context.signal,
      timeoutMs: LOCATE_TIMEOUT_MS,
    })
    if (!reply.ok || reply.value.kind !== 'ok') return undefined
    const place = parseLocateReply(reply.value.reply)
    if (place === undefined) return undefined
    const target = { x: place.x, y: this.origin.y, z: place.z }
    const recorded = knowledge.record(this.input.kind, target, { source: 'locate' })
    if (!recorded.ok) return err({ reason: 'no_world_profile', message: recorded.error })
    if (recorded.value.isNew) this.discovered.push(recorded.value.entry)
    this.context.progress(
      `The server puts the nearest ${this.input.kind} at ${String(place.x)}, ${String(place.z)}`,
    )

    if (flat(target, this.origin) > this.input.maxDistance)
      return ok(this.output(recorded.value.entry, { alreadyKnown: false, reached: false }))

    const stopped = await this.travel(new TowardExplorer(target), 'arrived')
    if (stopped === 'aborted') return this.failure('aborted')
    const entry = this.seen() ?? knowledge.matching(this.input.kind, target) ?? recorded.value.entry
    return ok(
      this.output(entry, {
        alreadyKnown: false,
        reached: stopped === 'arrived' || stopped === 'found',
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
  private seen(): StructureRecord | undefined {
    return this.foundHere
  }

  /** Records every structure in view; remembers the one that was asked for. */
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
      if (hit.kind === this.input.kind && (recorded.value.isNew || !this.input.onlyNew))
        this.foundHere ??= recorded.value.entry
    }
  }

  private output(
    found: StructureRecord,
    flags: { alreadyKnown: boolean; reached: boolean },
  ): ExploreOutput {
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
    const { kind, maxDistance, maxMinutes } = this.input
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
