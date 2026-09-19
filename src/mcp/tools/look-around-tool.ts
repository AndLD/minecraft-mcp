import { z } from 'zod'
import type { SurroundingsDescriber } from '../../perception/surroundings.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  radius: z
    .number()
    .int()
    .min(1)
    .max(12)
    .default(8)
    .describe('How far to look around the bot, in blocks (1-12).'),
})

export class LookAroundTool implements ToolDefinition<typeof schema> {
  readonly name = 'look_around'
  readonly description =
    'Describes the bot surroundings in one call: position, dimension, time of day, the block it stands on, notable blocks ' +
    'nearby (ores, logs, chests, furnaces, water, lava, ...) with counts and the nearest position, the most common terrain ' +
    'blocks, and nearby mobs, players, and items grouped by kind. Only loaded terrain is seen. Fails when not connected.'
  readonly inputSchema = schema

  constructor(private readonly surroundings: SurroundingsDescriber) {}

  execute(input: z.output<typeof schema>) {
    const report = this.surroundings.describe(input.radius)
    return report.ok ? toolOk(report.value) : toolFail(report.error)
  }
}
