import { z } from 'zod'
import type { BlockFinder } from '../../perception/block-finder.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const schema = z.object({
  names: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe(
      'Exact block names, for example ["oak_log", "birch_log"] or ["iron_ore", "deepslate_iron_ore"].',
    ),
  max_distance: z
    .number()
    .min(1)
    .max(64)
    .default(32)
    .describe('How far to search, in blocks (1-64).'),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of blocks to return (1-50).'),
})

export class FindBlocksTool implements ToolDefinition<typeof schema> {
  readonly name = 'find_blocks'
  readonly description =
    'Finds the nearest blocks of the given types within the loaded area, nearest first, with their coordinates and ' +
    'distance. Names must be exact Minecraft block names (a wrong name returns suggestions). An empty list means none ' +
    'were found nearby, not that none exist. Fails when not connected.'
  readonly inputSchema = schema

  constructor(private readonly finder: BlockFinder) {}

  execute(input: z.output<typeof schema>) {
    const result = this.finder.find({
      names: input.names,
      maxDistance: input.max_distance,
      count: input.count,
    })
    if (!result.ok) return toolFail(result.error)
    return toolOk({
      count: result.value.length,
      blocks: result.value.map((block) => ({
        name: block.name,
        position: block.position,
        distance: Math.round(block.distance * 10) / 10,
      })),
    })
  }
}
