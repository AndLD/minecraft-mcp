import type { BlockScanner } from '../../core/block-scanner.port.js'
import type { LookTarget } from '../../core/container.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'
import type { SkillFailure } from '../../core/skill.types.js'
import { isSignBlock } from './sign-table.js'
import { joinSignText } from './sign-text.js'
import type { SignReader } from './sign-reader.js'

export interface SignTargetInput {
  /** A sign's position. */
  readonly at?: Position | undefined
  /** Words on the sign (either side, ignoring case), searched within `radius` of the bot. */
  readonly matching?: string | undefined
  readonly radius: number
  /** The player whose crosshair names the sign when nothing else does. */
  readonly player: string | undefined
}

/**
 * Names the one sign an edit or removal is about: the position given, the single sign whose text matches, or the sign a
 * player looks at. It never answers with more than one sign: a phrase that fits several is `ambiguous` and lists them,
 * so nothing is ever taken down in bulk.
 */
export class SignTargeter {
  constructor(
    private readonly blocks: BlockScanner,
    private readonly look: LookTarget,
    private readonly reader: SignReader,
  ) {}

  resolve(input: SignTargetInput): Result<Position, SkillFailure> {
    if (input.at !== undefined) return this.checked(input.at)

    const wanted = input.matching?.trim()
    if (wanted !== undefined && wanted !== '') {
      const found = this.reader.read(input.radius, wanted)
      const [only, ...others] = found
      if (only === undefined)
        return err({
          reason: 'not_found',
          message: `No sign within ${String(input.radius)} blocks has "${wanted}" on it. read_signs lists what is around.`,
        })
      if (others.length > 0)
        return err({
          reason: 'ambiguous',
          message: `${String(found.length)} signs match "${wanted}". Say which one by its position (at) or ask the player to look at it.`,
          detail: {
            candidates: found.map((sign) => ({
              position: sign.position,
              text: joinSignText(sign.front),
            })),
          },
        })
      return ok(only.position)
    }

    if (input.player === undefined)
      return err({
        reason: 'no_target',
        message:
          'Name the sign: give at, or matching text, or a player (for_player, or set MC_OWNER) who is looking at it.',
      })
    const hit = this.look.blockLookedAt(input.player)
    if (hit === undefined)
      return err({
        reason: 'not_looking',
        message: `${input.player} is not looking at any block within reach, or is out of the bot's view. Give at, or ask them to look at the sign.`,
      })
    return this.checked(hit.position)
  }

  private checked(position: Position): Result<Position, SkillFailure> {
    const name = this.blocks.blockAt(position)
    if (name === undefined)
      return err({
        reason: 'not_loaded',
        message: 'That block is not loaded, so the bot cannot see it.',
      })
    if (!isSignBlock(name))
      return err({
        reason: 'not_a_sign',
        message: `The block at (${String(position.x)}, ${String(position.y)}, ${String(position.z)}) is ${name}, not a sign.`,
      })
    return ok(position)
  }
}
