import { z } from 'zod'
import type { CraftItemSkill } from '../../skills/crafting/craft-item-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 20

const schema = z.object({
  item: z
    .string()
    .min(1)
    .describe('The item to make, for example "wooden_pickaxe" or "crafting_table".'),
  count: z
    .number()
    .int()
    .min(1)
    .max(256)
    .default(1)
    .describe(
      'How many more to make. A recipe can make several at once, so a few extra are possible.',
    ),
  ...taskOptionsShape,
})

export class CraftTool implements ToolDefinition<typeof schema> {
  readonly name = 'craft'
  readonly description =
    'Crafts an item from the inventory, making the intermediate items on the way (logs to planks to sticks to a pickaxe). ' +
    'Recipes that need a 3x3 grid use a crafting table: a nearby one, or one from the inventory placed next to the bot (it is ' +
    'crafted first when there is none). Any wood type works for wooden recipes. Fails with unknown_item, no_recipe (smelt it or ' +
    'gather it instead), or missing_materials (the message lists exactly what is missing, so gather that and retry). ' +
    'Use list_recipes to see recipes first.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: CraftItemSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Craft ${String(input.count)} ${input.item}`,
        run: (ctx) => this.skill.run({ item: input.item, count: input.count }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
