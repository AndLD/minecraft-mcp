import { z } from 'zod'
import type { PickupItemsSkill } from '../../skills/gathering/pickup-items-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 20

const schema = z.object({
  items: z
    .array(z.string().min(1))
    .max(20)
    .default([])
    .describe(
      'Only pick up these items (for example ["oak_log"]). Empty means everything lying around.',
    ),
  max_distance: z
    .number()
    .min(1)
    .max(32)
    .default(12)
    .describe('How far to look for dropped items, in blocks (1-32).'),
  ...taskOptionsShape,
})

export class PickupItemsTool implements ToolDefinition<typeof schema> {
  readonly name = 'pickup_items'
  readonly description =
    'Walks onto items lying on the ground so the game picks them up (drops from mined blocks, items the player threw, a dead ' +
    "mob's loot). Result: what was picked up and how many stacks are still out there. Fails with no_items_nearby, " +
    'inventory_full, or pickup_failed (unreachable).'
  readonly inputSchema = schema

  constructor(
    private readonly skill: PickupItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const { wait_seconds: _wait, replace: _replace, ...rest } = input
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Pick up ${input.items.length === 0 ? 'dropped items' : input.items.join(' / ')}`,
        resume: { tool: this.name, arguments: rest },
        run: (ctx) => this.skill.run({ names: input.items, maxDistance: input.max_distance }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
