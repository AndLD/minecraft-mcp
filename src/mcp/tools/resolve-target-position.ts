import { z } from 'zod'
import type { LookTarget } from '../../core/container.port.js'
import type { Position } from '../../core/position.types.js'
import { err, ok, type Result } from '../../core/result.js'

export const positionSchema = z.object({
  x: z.number().describe('X block coordinate.'),
  y: z.number().describe('Y block coordinate (height).'),
  z: z.number().describe('Z block coordinate.'),
})

/** Resolves `at`, or the block the given (or default) player is looking at, to a position. */
export function resolveLookedAtPosition(
  at: Position | undefined,
  forPlayer: string | undefined,
  defaultPlayer: string | undefined,
  look: LookTarget,
): Result<Position> {
  if (at !== undefined) return ok(at)
  const player = forPlayer ?? defaultPlayer
  if (player === undefined)
    return err('Say which player: no owner is configured, and none was given as for_player.')
  const hit = look.blockLookedAt(player)
  if (hit === undefined)
    return err(
      `${player} is not looking at any block within reach, or is out of the bot's view. Give at, or ask them to look at it.`,
    )
  return ok(hit.position)
}
