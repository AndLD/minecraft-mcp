import { z } from 'zod'
import type { CollectBlocksSkill } from '../../skills/gathering/collect-blocks-skill.js'
import { BLOCK_ALIAS_NAMES } from '../../skills/gathering/block-aliases.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 25

const schema = z.object({
  blocks: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .describe(
      `Block names to break, for example ["oak_log"] or ["iron_ore", "deepslate_iron_ore"]. Group names ${BLOCK_ALIAS_NAMES.map((n) => `"${n}"`).join(', ')} stand for every matching block ("logs" = all log types).`,
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(2304)
    .default(1)
    .describe(
      'How many blocks to break (not how many items result: stone gives cobblestone, ores give raw ore).',
    ),
  max_distance: z
    .number()
    .min(1)
    .max(64)
    .default(32)
    .describe('How far to search from the bot, in blocks (1-64).'),
  ...taskOptionsShape,
})

export class CollectBlockTool implements ToolDefinition<typeof schema> {
  readonly name = 'collect_block'
  readonly description =
    'Breaks blocks of the given types (exact names, or groups such as "logs" and "ores"), nearest first, and picks up the drops. It uses the best tool it carries, never tunnels ' +
    '(only blocks that touch open space are dug), never digs straight down, next to lava, or inside protected areas. ' +
    'Long jobs continue in the background: poll get_task_status when the reply has status "running". Result: blocks mined and ' +
    'what the inventory gained. Fails with a reason such as block_not_found, no_suitable_tool (say what to craft first), ' +
    'inventory_full (free space and call again for the remaining count), protected_area, or unreachable; the message says how ' +
    'many were collected before it stopped.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: CollectBlocksSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const base = { blocks: input.blocks, max_distance: input.max_distance }
    // A resumed task only collects what is still missing.
    const progress = { remaining: input.count }
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Collect ${String(input.count)} ${input.blocks.join(' / ')}`,
        resume: {
          tool: this.name,
          get arguments() {
            return { ...base, count: Math.max(1, progress.remaining) }
          },
        },
        run: (ctx) =>
          this.skill.run(
            {
              names: input.blocks,
              count: input.count,
              maxDistance: input.max_distance,
              onMined: (mined) => {
                progress.remaining = input.count - mined
              },
            },
            ctx,
          ),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
