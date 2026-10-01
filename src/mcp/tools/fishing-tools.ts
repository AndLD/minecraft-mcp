import { z } from 'zod'
import type { FishSkill } from '../../skills/fishing/fish-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)

const fishSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(10)
    .describe(
      'How many fish to catch (or of `item`, when given). Treasure and junk that come up are kept.',
    ),
  item: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Count only this catch, for example "salmon". Other catches are kept but do not count.',
    ),
  max_minutes: z.number().min(1).max(60).default(10).describe('Stop after this many minutes.'),
  cook: z
    .boolean()
    .default(false)
    .describe('Bake the raw fish in a furnace when done (the same as smelt).'),
  at: z
    .object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })
    .optional()
    .describe('Fish at water near here instead of the nearest water.'),
  ...taskOptionsShape,
})

export class FishTool implements ToolDefinition<typeof fishSchema> {
  readonly name = 'fish'
  readonly description =
    'Fishes from the shore with a fishing rod that the bot carries: walks to open water (at least 3 blocks wide, ' +
    'firm ground beside it, outside protected areas), casts, waits for the bite, and reels in until `count` fish ' +
    '(or of `item`) are caught or `max_minutes` pass. It never enters the water. Reports the catch (fish, treasure, ' +
    'junk), the casts, and why it stopped (`count`, `time`, `rod_broke`, `inventory_full`, `cast_failed`); `cook: ' +
    'true` bakes the raw fish afterwards. Fails `no_rod` (a rod is 3 sticks and 2 string; it never crafts one) and ' +
    '`no_water` (try `at` or explore for a lake). Bites are random, so it can take minutes. Runs in the background: ' +
    'poll get_task_status when the reply has status "running".'
  readonly inputSchema = fishSchema

  constructor(
    private readonly skill: FishSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof fishSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Fish for ${String(input.count)} ${input.item ?? 'fish'}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              count: input.count,
              item: input.item,
              maxMinutes: input.max_minutes,
              cook: input.cook,
              at: input.at,
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
