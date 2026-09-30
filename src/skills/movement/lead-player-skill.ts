import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { ChatPort } from '../../core/chat.port.js'
import type { Clock } from '../../core/clock.port.js'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Gaze } from '../../core/gaze.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween, roundPosition } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import { sleep } from '../../core/sleep.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { findSurface } from '../discovery/surface-finder.js'

export interface LeadPlayerInput {
  readonly player: string
  /** Where to go, and what to call it in chat ("the village"). */
  readonly destination: { readonly label: string; readonly position: Position }
  /** The bot never gets farther from the player than this. */
  readonly leadDistance: number
  /** Stop this close to the destination. */
  readonly arriveWithin: number
}

export interface LeadPlayerOutput {
  readonly destination: string
  readonly arrivedAt: Position
  /** How far the player was when the bot arrived. */
  readonly playerDistance: number
  /** Times the bot called the player to follow. */
  readonly calls: number
  /** Times it had to wait for the player or go back to them. */
  readonly waits: number
}

export interface LeadPlayerDeps {
  readonly navigator: Navigator
  readonly entities: EntityScanner
  readonly vitals: VitalsReader
  readonly gaze: Gaze
  readonly chat: ChatPort
  readonly scheduler: Scheduler
  readonly clock: Clock
  /** Finds the ground of a column for each leg; without it the leg's height is worked out from the two ends. */
  readonly blocks?: BlockScanner
}

/** How often the bot looks at where the player is. */
export const TICK_MS = 500
/** The bot calls the player to follow at most this often. */
export const CALL_MS = 10_000
/** The player out of view for this long ends the task (`player_lost`). */
export const LOST_MS = 60_000
/** Waiting for a player who does not come for this long ends the task (`player_not_following`). */
export const NOT_FOLLOWING_MS = 600_000
/** The bot advances in legs of this many blocks, so it can stop at any moment. */
const LEG = 6
const MAX_LEG_FAILURES = 3
/** Waiting resumes when the player is within this share of the lead distance. */
const RESUME_SHARE = 0.6

export const resumeDistance = (leadDistance: number): number =>
  Math.max(3, Math.round(leadDistance * RESUME_SHARE))

/**
 * Walks to a place with a player behind it. The bot never gets farther from the player than `leadDistance`, and only
 * moves on when the player is close (within 60% of it): otherwise it stops, turns to face them, and calls them. A player
 * who walks off is followed, so nobody is left behind.
 */
export class LeadPlayerSkill implements Skill<LeadPlayerInput, LeadPlayerOutput> {
  readonly name = 'lead_player'

  constructor(private readonly deps: LeadPlayerDeps) {}

  async run(input: LeadPlayerInput, context: SkillContext): Promise<SkillResult<LeadPlayerOutput>> {
    const { deps } = this
    const { destination, leadDistance } = input
    const resume = resumeDistance(leadDistance)
    const { signal } = context

    let joined = false
    let waiting = false
    let waitingSince = 0
    let lastCall = Number.NEGATIVE_INFINITY
    let lastDistance: number | undefined
    let lostSince: number | undefined
    let legFailures = 0
    let calls = 0
    let waits = 0

    const say = (text: string): void => {
      deps.chat.say(text)
    }

    for (;;) {
      if (signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
      const me = deps.vitals.read()
      if (me === undefined)
        return err({ reason: 'not_connected', message: 'The bot is not in a world.' })
      const player = deps.entities.player(input.player)
      if (player === undefined)
        return err({ reason: 'player_offline', message: `${input.player} is not online.` })
      const now = deps.clock.now()

      if (player.position === undefined) {
        lostSince ??= now
        if (now - lostSince >= LOST_MS) {
          say(`${input.player}, where did you go?`)
          return err({
            reason: 'player_lost',
            message: `${input.player} has been out of view for a minute, so the bot stopped. Ask where they went.`,
          })
        }
        context.progress(`Waiting for ${input.player} to come into view`)
        await sleep(deps.scheduler, TICK_MS, signal)
        continue
      }
      lostSince = undefined
      const where = player.position
      const distance = distanceBetween(me.position, where)

      // Join: "come to me and lead me" is one request.
      if (!joined) {
        joined = true
        if (distance > resume) {
          context.progress(`Coming to ${input.player} first`)
          const came = await deps.navigator.goToPlayer(input.player, resume, { signal })
          if (!came.ok && came.error.reason === 'aborted')
            return err({ reason: 'aborted', message: 'Cancelled.' })
          continue
        }
      }

      const toGoal = distanceBetween(me.position, destination.position)
      if (toGoal <= input.arriveWithin) {
        const here = roundPosition(me.position)
        say(
          `We are at ${destination.label}: ${String(Math.round(here.x))}, ${String(Math.round(here.y))}, ${String(Math.round(here.z))}`,
        )
        return ok({
          destination: destination.label,
          arrivedAt: here,
          playerDistance: Math.round(distance * 10) / 10,
          calls,
          waits,
        })
      }

      if (!waiting && distance > leadDistance) {
        waiting = true
        waitingSince = now
        lastDistance = undefined
        waits += 1
        await deps.gaze.lookAt(where)
      }

      if (waiting) {
        if (distance <= resume) {
          waiting = false
          context.progress(`${input.player} caught up: leading on to ${destination.label}`)
          continue
        }
        if (now - waitingSince >= NOT_FOLLOWING_MS)
          return err({
            reason: 'player_not_following',
            message: `${input.player} has not followed for ${String(Math.round(NOT_FOLLOWING_MS / 60_000))} minutes, so the bot stopped.`,
          })
        if (now - lastCall >= CALL_MS) {
          lastCall = now
          calls += 1
          say(`Follow me to ${destination.label}`)
          await deps.gaze.lookAt(where)
        }
        context.progress(`Waiting for ${input.player}: ${String(Math.round(distance))} blocks away`)
        // A player walking off, or far away, is not coming: go to them rather than wait alone.
        const movingAway = lastDistance !== undefined && distance > lastDistance + 1
        if (movingAway || distance > leadDistance * 2) {
          lastDistance = undefined
          const back = await deps.navigator.goToPlayer(input.player, resume, { signal })
          if (!back.ok && back.error.reason === 'aborted')
            return err({ reason: 'aborted', message: 'Cancelled.' })
          continue
        }
        lastDistance = distance
        await sleep(deps.scheduler, TICK_MS, signal)
        continue
      }

      const leg = this.legTarget(me.position, destination.position, toGoal)
      context.progress(
        `Leading to ${destination.label}: ${String(Math.round(toGoal))} blocks to go, ${input.player} ${String(Math.round(distance))} behind`,
      )
      const walked = await deps.navigator.goToPosition(
        leg,
        toGoal <= LEG ? Math.max(1, Math.floor(input.arriveWithin / 2)) : 2,
        { signal },
      )
      if (!walked.ok) {
        if (walked.error.reason === 'aborted')
          return err({ reason: 'aborted', message: 'Cancelled.' })
        legFailures += 1
        if (legFailures >= MAX_LEG_FAILURES)
          return err({
            reason: 'unreachable',
            message: `The bot cannot find a way to ${destination.label} (${walked.error.message}).`,
          })
      } else legFailures = 0
      await sleep(deps.scheduler, TICK_MS, signal)
    }
  }

  /** A few blocks along the straight line to the goal, on the ground there when it is loaded. */
  private legTarget(from: Position, to: Position, toGoal: number): Position {
    if (toGoal <= LEG) return to
    const share = LEG / toGoal
    const x = Math.round(from.x + (to.x - from.x) * share)
    const z = Math.round(from.z + (to.z - from.z) * share)
    const ground =
      this.deps.blocks === undefined ? undefined : findSurface(this.deps.blocks, x, z, from.y)
    return ground?.kind === 'ground'
      ? ground.position
      : { x, y: Math.round(from.y + (to.y - from.y) * share), z }
  }
}
