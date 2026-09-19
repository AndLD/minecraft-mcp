import { z } from 'zod'
import type { EntityScanner } from '../../core/entity-scanner.port.js'
import { roundPosition } from '../../core/position.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

export const MAX_LISTED_ENTITIES = 30

const schema = z.object({
  radius: z.number().min(1).max(64).default(16).describe('How far to look, in blocks (1-64).'),
  category: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Only this kind: player, hostile, animal, passive, object (dropped items), or other.',
    ),
})

export class GetNearbyEntitiesTool implements ToolDefinition<typeof schema> {
  readonly name = 'get_nearby_entities'
  readonly description =
    `Lists players, mobs, and dropped items around the bot, nearest first (at most ${String(MAX_LISTED_ENTITIES)}), with ` +
    'id, kind, name, position, and distance in blocks. The reply also gives the total count. Only entities within the ' +
    'server view distance are visible. Fails when not connected.'
  readonly inputSchema = schema

  constructor(
    private readonly entities: EntityScanner,
    private readonly vitals: VitalsReader,
  ) {}

  execute(input: z.output<typeof schema>) {
    if (this.vitals.read() === undefined) return toolFail('Not connected to a Minecraft world.')
    const all = this.entities
      .nearby(input.radius)
      .filter((entity) => input.category === undefined || entity.category === input.category)
    return toolOk({
      total: all.length,
      entities: all.slice(0, MAX_LISTED_ENTITIES).map((entity) => ({
        id: entity.id,
        category: entity.category,
        name: entity.name,
        position: roundPosition(entity.position),
        distance: Math.round(entity.distance * 10) / 10,
      })),
    })
  }
}
