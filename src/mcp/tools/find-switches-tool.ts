import { z } from 'zod'
import type { LookTarget } from '../../core/container.port.js'
import { SWITCH_SEARCH_RADIUS, type SwitchFinder } from '../../skills/movement/switch-finder.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'
import { positionSchema, resolveLookedAtPosition } from './resolve-target-position.js'

const schema = z.object({
  at: positionSchema
    .optional()
    .describe("Search around this position (typically a door). Omit to use for_player's look."),
  for_player: z
    .string()
    .min(1)
    .optional()
    .describe('Whose look to use when at is omitted. Defaults to the owner.'),
  radius: z
    .number()
    .min(1)
    .max(16)
    .default(SWITCH_SEARCH_RADIUS)
    .describe('How far to search, in blocks.'),
})

export class FindSwitchesTool implements ToolDefinition<typeof schema> {
  readonly name = 'find_switches'
  readonly description =
    'Lists the buttons, levers, and pressure plates around a position (a door, or wherever the player is looking), ' +
    'nearest first, each with its kind, exact block name, position, and distance. Read-only: nothing is pressed.'
  readonly inputSchema = schema

  constructor(
    private readonly finder: SwitchFinder,
    private readonly look: LookTarget,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof schema>) {
    const resolved = resolveLookedAtPosition(input.at, input.for_player, this.defaultPlayer, this.look)
    if (!resolved.ok) return toolFail(resolved.error)
    return toolOk({ switches: this.finder.near(resolved.value, input.radius) })
  }
}
