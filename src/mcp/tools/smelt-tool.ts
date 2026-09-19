import { z } from 'zod'
import type { SmeltItemsSkill } from '../../skills/smelting/smelt-items-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30

const schema = z.object({
  item: z
    .string()
    .min(1)
    .describe('What to smelt or cook, for example "raw_iron", "sand", "beef", or "cobblestone".'),
  count: z
    .number()
    .int()
    .min(1)
    .max(2304)
    .optional()
    .describe('How many to smelt. Everything carried when omitted.'),
  fuel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Fuel item to burn (for example "coal"). Chosen automatically when omitted: charcoal, coal, sticks, planks, then logs. ' +
        'Coal blocks, blaze rods, and lava buckets are only used when named here.',
    ),
  ...taskOptionsShape,
})

export class SmeltTool implements ToolDefinition<typeof schema> {
  readonly name = 'smelt'
  readonly description =
    'Smelts or cooks items in a furnace: uses a nearby furnace, or one from the inventory placed next to the bot (crafted from ' +
    '8 cobblestone when there is none), loads fuel and items, waits (10 seconds per item), and collects the output. It runs in ' +
    'the background: poll get_task_status when the reply has status "running". If it stops early, whatever is left in the ' +
    'furnace goes back to the inventory. Fails with not_smeltable, missing_items, no_fuel, no_furnace, timeout, or out_of_fuel; ' +
    'the message says how many were done.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: SmeltItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Smelt ${input.count === undefined ? 'all' : String(input.count)} ${input.item}`,
        run: (ctx) =>
          this.skill.run({ item: input.item, count: input.count, fuel: input.fuel }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
