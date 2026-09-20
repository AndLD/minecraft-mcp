import type { EntityScanner } from '../../core/entity-scanner.port.js'
import type { Navigator } from '../../core/navigator.port.js'
import { distanceBetween, roundPosition } from '../../core/position.js'
import type { Position } from '../../core/position.types.js'
import { err, ok } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { ServerCommands } from '../../core/server-commands.port.js'
import type { Skill, SkillContext, SkillResult } from '../../core/skill.types.js'
import { sleep } from '../../core/sleep.js'
import type { VitalsReader } from '../../core/vitals.port.js'

export type TeleportTarget =
  | { readonly kind: 'player'; readonly name: string }
  | { readonly kind: 'position'; readonly position: Position }

export interface TeleportInput {
  readonly target: TeleportTarget
}

export interface TeleportOutput {
  readonly from: Position
  /** Where the bot stands afterwards (for a player target, a safe spot next to them). */
  readonly arrivedAt: Position
  readonly dimension: string
  /** What the server said, when it said anything. */
  readonly reply: string | undefined
}

/** Finds a safe place to stand near a position. Satisfied by the reflexes' `SafeSpotFinder`. */
export interface StandingSpotFinder {
  find(from: Position, avoid: readonly ('lava' | 'water')[]): Position | undefined
}

export interface TeleportDeps {
  readonly commands: ServerCommands
  readonly vitals: VitalsReader
  readonly navigator: Navigator
  readonly entities: EntityScanner
  readonly spots: StandingSpotFinder
  readonly scheduler: Scheduler
  /** The bot's own in-game name, for the instructions. */
  readonly botName: () => string | undefined
}

/** Waiting for the server's teleport to show in the bot's position. */
const MOVE_POLL_MS = 100
const MOVE_POLLS = 30
/** A teleport that moves the bot less than this counts as "did not move". */
const MOVED_BLOCKS = 1
/** After arriving next to a player, chunks may still be loading: look for a standing spot this many times. */
const SPOT_TRIES = 4
const SPOT_WAIT_MS = 750

/**
 * Teleports the bot with the server's `/tp`, which needs cheats on and the bot to be an operator. It never happens on
 * its own: only a tool call (the player's request) starts it. A player target lands the bot on the player's own block,
 * so it then steps to a safe spot next to them.
 */
export class TeleportSkill implements Skill<TeleportInput, TeleportOutput> {
  readonly name = 'teleport'

  constructor(private readonly deps: TeleportDeps) {}

  async run(input: TeleportInput, context: SkillContext): Promise<SkillResult<TeleportOutput>> {
    const { deps } = this
    const start = deps.vitals.read()
    if (start === undefined)
      return err({ reason: 'not_connected', message: 'Not connected to a Minecraft world.' })
    if (deps.commands.available('tp') === false) return err(this.noPermission())

    const target = input.target
    if (target.kind === 'player') {
      const found = deps.entities.player(target.name)
      if (found === undefined || !found.online)
        return err({ reason: 'player_not_online', message: `${target.name} is not online.` })
    }
    const command =
      target.kind === 'player'
        ? `tp @s ${target.name}`
        : `tp @s ${String(target.position.x)} ${String(target.position.y)} ${String(target.position.z)}`

    context.progress('Asking the server to teleport')
    const sent = await deps.commands.run(command, { signal: context.signal })
    if (!sent.ok) return err(sent.error)
    const outcome = sent.value
    switch (outcome.kind) {
      case 'no_permission':
        return err({ ...this.noPermission(), detail: { reply: outcome.reply } })
      case 'unknown_command':
        return err({
          reason: 'unknown_command',
          message: `The server does not know the teleport command: "${outcome.reply}".`,
          detail: { reply: outcome.reply },
        })
      case 'error':
        return err({
          reason: 'teleport_failed',
          message: `The server refused the teleport: "${outcome.reply}".`,
          detail: { reply: outcome.reply },
        })
      default:
    }

    const reply = outcome.kind === 'ok' ? outcome.reply : undefined
    const moved = await this.untilMoved(start.position, start.dimension, context.signal)
    if (context.signal.aborted) return err({ reason: 'aborted', message: 'Cancelled.' })
    if (!moved && outcome.kind === 'sent')
      return err({
        reason: 'teleport_failed',
        message:
          'The server did not answer and the bot did not move, so the teleport did not happen. Commands may be off for the bot: see get_status.',
      })

    const landed = deps.vitals.read()
    if (landed === undefined)
      return err({ reason: 'not_connected', message: 'Lost the connection after teleporting.' })
    const arrivedAt =
      target.kind === 'player' ? await this.stepAside(landed.position, context) : landed.position
    return ok({
      from: roundPosition(start.position),
      arrivedAt: roundPosition(arrivedAt),
      dimension: deps.vitals.read()?.dimension ?? landed.dimension,
      reply,
    })
  }

  private noPermission() {
    const bot = this.deps.botName() ?? 'the bot'
    return {
      reason: 'no_permission',
      message:
        `The server does not let ${bot} teleport. On a LAN world the host must open it to LAN with "Allow cheats: ON" ` +
        `and then type "/op ${bot}" in their chat (cheats alone only make the host an operator; the bot cannot do this ` +
        'itself). Until then, use goto to walk.',
    }
  }

  /** True when the bot's position or dimension changed noticeably. */
  private async untilMoved(
    from: Position,
    dimension: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    for (let poll = 0; poll < MOVE_POLLS; poll += 1) {
      const now = this.deps.vitals.read()
      if (
        now !== undefined &&
        (now.dimension !== dimension || distanceBetween(now.position, from) >= MOVED_BLOCKS)
      )
        return true
      if (signal.aborted) return false
      await sleep(this.deps.scheduler, MOVE_POLL_MS, signal)
    }
    return false
  }

  /** `/tp` puts the bot on the player's own block; it steps next to them, on ground that is safe to stand on. */
  private async stepAside(landed: Position, context: SkillContext): Promise<Position> {
    const { deps } = this
    for (let attempt = 0; attempt < SPOT_TRIES; attempt += 1) {
      const spot = deps.spots.find(landed, ['lava', 'water'])
      if (spot !== undefined) {
        const walked = await deps.navigator.goToPosition(spot, 0.5, { signal: context.signal })
        if (walked.ok) return walked.value
        break
      }
      if (context.signal.aborted) break
      await sleep(deps.scheduler, SPOT_WAIT_MS, context.signal) // the chunks around the player may still be arriving
    }
    return deps.vitals.read()?.position ?? landed
  }
}
