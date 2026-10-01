import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { Sleeper, SleepFailureReason } from '../../core/sleeper.port.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { BedRegistry } from '../../state/bed-registry.js'
import type { BedFinder } from './bed-finder.js'
import { bedsExplode, colourOfBed, isBedName, isNight, MONSTER_RANGE } from './bed-table.js'

/** How long to stay in bed waiting for the server to skip the night. */
export const DEFAULT_STAY_SECONDS = 40
export const MAX_STAY_SECONDS = 600
const POLL_MS = 1_000
const REACH = 2
const TIME_LOOKS = 8
const TIME_LOOK_MS = 250

export interface SleepInput {
  /** The bed to use; the nearest known or visible one when left out. */
  readonly bed: Position | undefined
  readonly staySeconds: number | undefined
}

export interface SleepOutput {
  readonly bed: Position
  readonly colour: string
  readonly nightSkipped: boolean
  /** Something woke the bot before morning (a threat, damage) or before the wait ran out. */
  readonly wokeEarly: boolean
  readonly sleptSeconds: number
  readonly message: string
}

export interface SleepDeps {
  readonly vitals: VitalsReader
  readonly blocks: BlockScanner
  readonly entities: EntityScanner
  readonly navigator: Navigator
  readonly sleeper: Sleeper
  readonly finder: BedFinder
  readonly registry: BedRegistry
  readonly clock: Clock
  readonly scheduler: Scheduler
}

const REFUSAL: Record<SleepFailureReason, string> = {
  not_connected: 'Not connected to a Minecraft world.',
  not_a_bed: 'That is not a bed.',
  not_night:
    'The game only lets a player sleep at night (from about 12,540 to 23,460 ticks) or in a thunderstorm. set_respawn_point still sets the respawn point by day.',
  monsters_nearby:
    'The game refuses sleep while hostile mobs are within about 8 blocks. Clear them or light the area, then try again.',
  too_far: 'The bed is too far away.',
  occupied: 'The bed is occupied.',
  obstructed: 'The bed is obstructed (a block above it), so it cannot be used.',
  failed: 'The game refused to let the bot sleep.',
}

/**
 * Puts the bot to bed for the night: checks the dimension and nearby monsters, walks to the nearest usable bed, lies
 * down, and stays until the server skips the night, something wakes the bot, or the wait runs out. In multiplayer the
 * night is skipped only when enough players sleep, so the result says whether it really was.
 */
export class SleepSkill implements Skill<SleepInput, SleepOutput> {
  readonly name = 'sleep'

  constructor(private readonly deps: SleepDeps) {}

  async run(input: SleepInput, context: SkillContext): Promise<SkillResult<SleepOutput>> {
    const { deps } = this
    const vitals = deps.vitals.read()
    if (vitals === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    if (bedsExplode(vitals.dimension))
      return err({
        reason: 'wrong_dimension',
        message: `A bed explodes in the Nether and the End, so the bot never sleeps there (it is in ${vitals.dimension}).`,
      })
    if (deps.sleeper.isSleeping())
      return err({ reason: 'already_sleeping', message: 'The bot is already in bed.' })

    const bed = this.choose(input.bed, vitals.position)
    if (!bed.ok) return bed
    const { position, colour } = bed.value

    const monsters = this.monstersNear(position)
    if (monsters.length > 0)
      return err({
        reason: 'monsters_nearby',
        message: `Hostile mobs are near the bed (${monsters.join(', ')}); the game refuses sleep within about ${String(MONSTER_RANGE.horizontal)} blocks. Clear them or light the area first.`,
        detail: { monsters },
      })

    context.progress('Walking to the bed')
    const walked = await deps.navigator.goToPosition(position, REACH, { signal: context.signal })
    if (!walked.ok) {
      if (walked.error.reason === 'aborted')
        return err({ reason: 'aborted', message: 'Cancelled.' })
      return err({
        reason: 'unreachable',
        message: `Could not walk to the bed: ${walked.error.message}`,
      })
    }

    const lying = await deps.sleeper.sleep(position)
    if (!lying.ok)
      return err({
        reason: lying.error.reason,
        message: `${REFUSAL[lying.error.reason]} (${lying.error.message})`,
      })
    deps.registry.setRespawn(position, colour)
    context.progress('In bed')

    const startedAt = deps.clock.now()
    const stayMs = (input.staySeconds ?? DEFAULT_STAY_SECONDS) * 1000
    try {
      while (
        !context.signal.aborted &&
        deps.sleeper.isSleeping() &&
        deps.clock.now() - startedAt < stayMs
      )
        await sleep(deps.scheduler, POLL_MS, context.signal)
    } finally {
      // Always get up, also when cancelled: a sleeping bot cannot walk or fight.
      await deps.sleeper.wake()
    }
    if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })

    const sleptSeconds = Math.round((deps.clock.now() - startedAt) / 1000)
    const stayedFull = deps.clock.now() - startedAt >= stayMs
    // The server sends the new time about once a second, so right after waking it can still read as night.
    let time = deps.vitals.read()?.timeOfDay
    for (
      let look = 0;
      look < TIME_LOOKS && !stayedFull && time !== undefined && isNight(time);
      look += 1
    ) {
      await sleep(deps.scheduler, TIME_LOOK_MS, context.signal)
      time = deps.vitals.read()?.timeOfDay
    }
    const nightSkipped = time !== undefined && !isNight(time)
    return ok({
      bed: position,
      colour,
      nightSkipped,
      wokeEarly: !nightSkipped && !stayedFull,
      sleptSeconds,
      message: nightSkipped
        ? 'Slept through the night: it is morning and the bed is now the respawn point.'
        : stayedFull
          ? `The bot slept ${String(sleptSeconds)} s but the night was not skipped. In multiplayer the server skips it only when enough players sleep (sleepingPercentage, default 100%), so a player who is awake keeps it going. The bed is the respawn point.`
          : 'The bot was woken before morning (a threat or damage). The bed is the respawn point; ask the player whether to try again.',
    })
  }

  private choose(
    wanted: Position | undefined,
    from: Position,
  ): SkillResult<{ position: Position; colour: string }> {
    const { blocks, finder } = this.deps
    if (wanted !== undefined) {
      const name = blocks.blockAt(wanted)
      if (!isBedName(name))
        return err({ reason: 'not_a_bed', message: 'There is no bed at that position.' })
      return ok({ position: wanted, colour: colourOfBed(name ?? '') })
    }
    const nearest = finder.candidates(from)[0]
    if (nearest === undefined)
      return err({
        reason: 'no_bed',
        message:
          'No bed is known or visible within 32 blocks. Craft one (three wool and three planks) and use place_bed.',
      })
    return ok(nearest)
  }

  private monstersNear(bed: Position): string[] {
    return this.deps.entities
      .nearby(32)
      .filter(
        (entity) =>
          entity.category === 'hostile' &&
          Math.abs(entity.position.y - bed.y) <= MONSTER_RANGE.vertical &&
          Math.hypot(entity.position.x - bed.x, entity.position.z - bed.z) <=
            MONSTER_RANGE.horizontal,
      )
      .map((entity) => entity.name)
  }
}
