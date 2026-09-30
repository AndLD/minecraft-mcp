import type { Clock } from '../../../core/clock.port.js'
import type { EntityScanner } from '../../../core/entity-scanner.port.js'
import type { Navigator } from '../../../core/navigator.port.js'
import { distanceBetween } from '../../../core/position.js'
import type { Position } from '../../../core/position.types.js'
import { err, ok } from '../../../core/result.js'
import type { Skill, SkillContext, SkillResult } from '../../../core/skill.types.js'
import type { StructureKind } from '../../../core/structure-kinds.js'
import type { VitalsReader } from '../../../core/vitals.port.js'
import type { BlockScanner } from '../../../core/block-scanner.port.js'
import type {
  FindRecord,
  StructureRecord,
  WorldKnowledgeStore,
} from '../../../knowledge/world-knowledge-store.js'
import type { StructureScanner } from '../structure-scanner.js'
import type { CaveMap } from './cave-map.js'
import { resolveFind, type SeenFind } from './find-rules.js'
import type { FindDetector } from './find-rules.js'
import type { LightManager } from './light-manager.js'
import type { VeinMiner } from './vein-miner.js'

export interface ExploreCavesInput {
  /** Block names to look for (`diamond_ore`), `ores`, or nothing for the valuable ores. */
  readonly find?: readonly string[] | undefined
  /** Dig out the wanted ore veins it passes. Off: only report them. */
  readonly mine: boolean
  /** How far from where the cave was entered it may go, in blocks. */
  readonly maxDistance: number
  readonly maxMinutes: number
  /** Torches go where the block light is below this. */
  readonly minLight: number
}

export type CaveStop =
  'explored' | 'time' | 'low_health' | 'hungry' | 'no_torches' | 'warden' | 'stuck'

export interface ExploreCavesOutput {
  readonly region: 'cave' | 'ravine'
  readonly entrance: Position
  readonly stopped: CaveStop
  /** New finds of this trip, also saved (list_known_structures shows them). */
  readonly finds: readonly FindRecord[]
  /** Structures seen on the way (mineshaft, dungeon, stronghold, ancient city). */
  readonly structures: readonly StructureRecord[]
  /** Blocks dug by name (`mine: true`). */
  readonly mined: Readonly<Record<string, number>>
  /** Veins left alone, and why (`hazard`, `protected`, `no_tool`). */
  readonly skipped: readonly { name: string; at: Position; reason: string }[]
  readonly torchesPlaced: number
  readonly hops: number
  readonly farthest: number
  /** The bot walked back to where it started. */
  readonly returned: boolean
}

export interface ExploreCavesDeps {
  readonly navigator: Navigator
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly entities: EntityScanner
  readonly map: CaveMap
  readonly lights: LightManager
  readonly detector: FindDetector
  readonly miner: VeinMiner
  readonly scanner: StructureScanner
  readonly knowledge: WorldKnowledgeStore
  readonly clock: Clock
}

const MIN_HEALTH = 8
const MIN_FOOD = 4
const MAX_FAILURES = 5
const REACH_RADIUS = 24
const LOOK_RADIUS = 24
const COARSE = 4
/** How high a roof may be and still make a cell part of a cave. */
const ROOF_HEIGHT = 16
const AVOID_RADIUS = 40
const MINUTE_MS = 60_000
const MOUTH_SEARCH = 40
/** Structures a cave search reports on the way. */
const CAVE_STRUCTURES: readonly StructureKind[] = [
  'mineshaft',
  'dungeon',
  'stronghold',
  'ancient_city',
]

const cellKey = (p: Position): string =>
  `${String(Math.floor(p.x / COARSE))},${String(Math.floor(p.y / COARSE))},${String(Math.floor(p.z / COARSE))}`
const floor = (p: Position): Position => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y),
  z: Math.floor(p.z),
})

/** Goes into a cave or ravine, lights the way, reports what it finds, and walks back out. */
export class ExploreCavesSkill implements Skill<ExploreCavesInput, ExploreCavesOutput> {
  readonly name = 'explore_caves'

  constructor(private readonly deps: ExploreCavesDeps) {}

  async run(
    input: ExploreCavesInput,
    context: SkillContext,
  ): Promise<SkillResult<ExploreCavesOutput>> {
    const { vitals, knowledge, blocks, map, navigator } = this.deps
    const start = vitals.read()
    if (start === undefined)
      return err({ reason: 'not_connected', message: 'The bot is not in a world.' })
    if (/nether|end/i.test(start.dimension))
      return err({
        reason: 'wrong_dimension',
        message: `Cave exploring is only built for the Overworld (the bot is in ${start.dimension}).`,
      })
    if (!knowledge.active)
      return err({
        reason: 'no_world_profile',
        message: 'No world is active, so finds cannot be saved. Connect to a world first.',
      })
    const wish = resolveFind(input.find, blocks.knownBlockNames())
    if (!wish.ok) return err({ reason: 'bad_find', message: wish.message })

    const origin = floor(start.position)
    let entrance = origin
    if (!map.roofed(origin, 6)) {
      const mouth = map.findMouth(origin, MOUTH_SEARCH)
      if (mouth !== undefined) {
        context.progress(
          `Walking to a cave mouth at ${String(mouth.x)}, ${String(mouth.y)}, ${String(mouth.z)}`,
        )
        const trip = await navigator.goToPosition(mouth, 1, { signal: context.signal })
        if (!trip.ok)
          return err({
            reason: trip.error.reason,
            message: `Could not get to the cave mouth: ${trip.error.message}`,
          })
        entrance = mouth
      } else if (!map.dropsAway(origin, MOUTH_SEARCH)) {
        return err({
          reason: 'no_cave',
          message: `No cave mouth or ravine within ${String(MOUTH_SEARCH)} blocks of the bot. Walk to one (goto) or say where it is.`,
        })
      }
    }
    const region = map.classify(map.reach(entrance, REACH_RADIUS).cells)
    const trip = new CaveTrip(this.deps, input, wish.blocks, context, origin, entrance, region)
    return trip.run()
  }
}

/** One trip underground: where the bot has been, what it has seen and done. */
class CaveTrip {
  private current: Position
  private readonly explored = new Set<string>()
  private readonly breadcrumbs: Position[]
  private readonly avoid: Position[] = []
  private readonly finds: FindRecord[] = []
  private readonly structures: StructureRecord[] = []
  private readonly mined = new Map<string, number>()
  private readonly skipped: { name: string; at: Position; reason: string }[] = []
  private readonly startedAt: number
  private torches = 0
  private hops = 0
  private failures = 0
  private farthest = 0
  private heading = { dx: 0, dz: 0 }

  constructor(
    private readonly deps: ExploreCavesDeps,
    private readonly input: ExploreCavesInput,
    private readonly wanted: readonly string[],
    private readonly context: SkillContext,
    private readonly origin: Position,
    private readonly entrance: Position,
    private readonly region: 'cave' | 'ravine',
  ) {
    this.current = entrance
    this.breadcrumbs = [entrance]
    this.startedAt = deps.clock.now()
  }

  async run(): Promise<SkillResult<ExploreCavesOutput>> {
    this.context.progress(`Entering a ${this.region}`)
    this.markExplored(this.current)
    const first = await this.arrive()
    let stopped: CaveStop | undefined = first
    while (stopped === undefined) {
      if (this.context.signal.aborted) return this.aborted()
      stopped = this.check()
      if (stopped !== undefined) break
      const target = this.pickTarget()
      if (target === undefined) {
        stopped = 'explored'
        break
      }
      const trip = await this.deps.navigator.goToPosition(target, 1, {
        signal: this.context.signal,
      })
      if (!trip.ok) {
        if (trip.error.reason === 'aborted') return this.aborted()
        this.explored.add(cellKey(target))
        this.failures += 1
        if (this.failures >= MAX_FAILURES) stopped = 'stuck'
        continue
      }
      this.failures = 0
      this.hops += 1
      this.setHeading(trip.value)
      this.current = floor(trip.value)
      this.breadcrumbs.push(this.current)
      this.farthest = Math.max(
        this.farthest,
        Math.round(distanceBetween(this.current, this.entrance)),
      )
      this.markExplored(this.current)
      this.context.progress(
        `Hop ${String(this.hops)}: ${String(this.farthest)} blocks from the entrance, ${String(this.torches)} torches placed, ${String(this.finds.length)} finds`,
      )
      stopped = await this.arrive()
    }
    if (this.context.signal.aborted) return this.aborted()
    const returned = await this.walkOut()
    return ok(this.output(stopped, returned))
  }

  /** Time, health, hunger, and the warden. */
  private check(): CaveStop | undefined {
    const { clock, vitals, entities } = this.deps
    if (clock.now() - this.startedAt > this.input.maxMinutes * MINUTE_MS) return 'time'
    const now = vitals.read()
    if (now !== undefined && now.health < MIN_HEALTH) return 'low_health'
    if (now !== undefined && now.food < MIN_FOOD) return 'hungry'
    if (entities.nearby(AVOID_RADIUS).some((entity) => entity.name === 'warden')) return 'warden'
    return undefined
  }

  /** The nearest walkable cell nobody has been near yet, within the distance limit and away from the deep dark. */
  private pickTarget(): Position | undefined {
    const { map } = this.deps
    // In a cave, stay under the rock: the open ground outside is not part of it. A ravine has no roof.
    const admit =
      this.region === 'cave' ? (cell: Position) => map.roofed(cell, ROOF_HEIGHT) : undefined
    for (const { position, steps } of map.reach(this.current, REACH_RADIUS, 4000, admit).cells) {
      if (steps < 3 || this.explored.has(cellKey(position))) continue
      if (distanceBetween(position, this.entrance) > this.input.maxDistance) continue
      if (this.avoid.some((zone) => distanceBetween(position, zone) < AVOID_RADIUS)) continue
      return position
    }
    return undefined
  }

  /** Cells within a few blocks of a spot count as seen. */
  private markExplored(at: Position): void {
    for (let dx = -2; dx <= 2; dx += 2)
      for (let dy = -2; dy <= 2; dy += 2)
        for (let dz = -2; dz <= 2; dz += 2)
          this.explored.add(cellKey({ x: at.x + dx, y: at.y + dy, z: at.z + dz }))
  }

  private setHeading(to: Position): void {
    const dx = to.x - this.current.x
    const dz = to.z - this.current.z
    if (Math.abs(dx) >= Math.abs(dz)) this.heading = { dx: Math.sign(dx), dz: 0 }
    else this.heading = { dx: 0, dz: Math.sign(dz) }
  }

  /** At a new spot: light it, then look around. */
  private async arrive(): Promise<CaveStop | undefined> {
    const lit = await this.deps.lights.ensure(
      this.current,
      this.heading,
      { minLight: this.input.minLight, spacing: 6 },
      this.context,
    )
    if (lit === 'placed') this.torches += 1
    if (lit === 'no_torches') {
      await this.look()
      return 'no_torches'
    }
    await this.look()
    return undefined
  }

  private async look(): Promise<void> {
    const { detector, scanner, knowledge, vitals } = this.deps
    for (const seen of detector.detect(LOOK_RADIUS, this.wanted)) {
      const recorded = knowledge.recordFind(seen.kind, seen.name, seen.position, seen.count)
      if (!recorded.ok || !recorded.value.isNew) continue
      this.finds.push(recorded.value.entry)
      this.context.progress(
        `Found ${String(seen.count)} ${seen.name} at ${String(seen.position.x)}, ${String(seen.position.y)}, ${String(seen.position.z)}`,
      )
      if (this.input.mine && seen.kind === 'ore' && this.wanted.includes(seen.name)) {
        await this.mineVein(seen)
        const now = vitals.read()
        if (now !== undefined) this.current = floor(now.position)
      }
    }
    for (const hit of scanner.scan(32, CAVE_STRUCTURES)) {
      const recorded = knowledge.record(hit.kind, hit.position, {
        source: 'scan',
        detail: hit.detail,
      })
      if (!recorded.ok) continue
      if (hit.kind === 'ancient_city') this.avoid.push(hit.position)
      if (!recorded.value.isNew) continue
      this.structures.push(recorded.value.entry)
      this.context.progress(
        hit.kind === 'ancient_city'
          ? `Found an ancient city at ${String(hit.position.x)}, ${String(hit.position.y)}, ${String(hit.position.z)}: keeping away from the deep dark`
          : `Found a ${hit.kind} at ${String(hit.position.x)}, ${String(hit.position.y)}, ${String(hit.position.z)}`,
      )
    }
  }

  private async mineVein(seen: SeenFind): Promise<void> {
    const outcome = await this.deps.miner.mine(seen, this.current, this.context.signal)
    if (outcome.kind === 'mined') {
      this.mined.set(seen.name, (this.mined.get(seen.name) ?? 0) + outcome.count)
      return
    }
    if (outcome.count > 0)
      this.mined.set(seen.name, (this.mined.get(seen.name) ?? 0) + outcome.count)
    if (outcome.reason !== 'aborted')
      this.skipped.push({ name: seen.name, at: seen.position, reason: outcome.reason })
  }

  /** Back to where the bot started, or, when that fails, back along its own tracks. */
  private async walkOut(): Promise<boolean> {
    const { navigator } = this.deps
    const signal = this.context.signal
    this.context.progress('Walking back out')
    const direct = await navigator.goToPosition(this.origin, 2, { signal })
    if (direct.ok) return true
    for (let index = this.breadcrumbs.length - 1; index >= 0; index -= 3) {
      const crumb = this.breadcrumbs[index]
      if (crumb === undefined) continue
      const trip = await navigator.goToPosition(crumb, 2, { signal })
      if (!trip.ok && trip.error.reason === 'aborted') return false
    }
    const last = await navigator.goToPosition(this.origin, 2, { signal })
    return last.ok
  }

  private output(stopped: CaveStop, returned: boolean): ExploreCavesOutput {
    return {
      region: this.region,
      entrance: this.entrance,
      stopped,
      finds: this.finds,
      structures: this.structures,
      mined: Object.fromEntries(this.mined),
      skipped: this.skipped,
      torchesPlaced: this.torches,
      hops: this.hops,
      farthest: this.farthest,
      returned,
    }
  }

  private aborted(): SkillResult<ExploreCavesOutput> {
    return err({
      reason: 'aborted',
      message: 'The cave search was cancelled.',
      detail: { ...this.output('explored', false), stopped: 'aborted' },
    })
  }
}
