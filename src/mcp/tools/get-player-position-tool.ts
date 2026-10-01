import { z } from 'zod'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import { roundPosition } from '../../core/position.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  player: z
    .string()
    .min(1)
    .optional()
    .describe('Exact in-game name. Defaults to the configured owner.'),
})

export class GetPlayerPositionTool implements ToolDefinition<typeof schema> {
  readonly name = 'get_player_position'
  readonly description =
    'Tells where a player is. Only players within the server view distance have a position; a player who is online but ' +
    'far away is reported with visible=false and no coordinates. Fails when the player is not online or the bot is not connected.'
  readonly inputSchema = schema

  constructor(
    private readonly entities: EntityScanner,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof schema>) {
    const name = input.player ?? this.defaultPlayer
    if (name === undefined) return toolFail('Say which player: no owner is configured.')
    const player = this.entities.player(name)
    if (player === undefined)
      return toolFail(`${name} is not online (or the bot is not connected).`)
    return toolOk({
      player: player.name,
      visible: player.position !== undefined,
      position: player.position === undefined ? null : roundPosition(player.position),
      distance: player.distance === undefined ? null : Math.round(player.distance * 10) / 10,
    })
  }
}
