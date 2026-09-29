import { z } from 'zod'
import type { FillBucketSkill } from '../../skills/buckets/fill-bucket-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)

const fillBucketSchema = z.object({
  liquid: z.enum(['water', 'lava']).describe('What to fill the bucket with.'),
  count: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(1)
    .describe('How many buckets to fill (default 1). Limited by the empty buckets carried.'),
  at: z
    .object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })
    .optional()
    .describe(
      'A source block to take it from. Without it the nearest source within max_distance is used. Naming the block is also how the player allows lava from beside something they built.',
    ),
  max_distance: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(24)
    .describe('How far to look for a source, in blocks (default 24). Ignored when at is given.'),
  ...taskOptionsShape,
})

export class FillBucketTool implements ToolDefinition<typeof fillBucketSchema> {
  readonly name = 'fill_bucket'
  readonly description =
    'Fills empty buckets from water or lava: walks to a safe spot beside a source block and takes it. Only a source ' +
    'block fills a bucket (flowing water gives nothing). Taking one source from a pool leaves it as it was when two ' +
    'sources touch (the reply says poolRefills), otherwise that block is drained. Needs an empty bucket in the ' +
    'inventory: fails no_bucket and says what to craft (3 iron ingots); it never crafts on its own. Lava only when ' +
    'the player asked for it: it is refused in a protected area (protected_area), beside anything a player built ' +
    '(structure_nearby: ask which lava block to take and pass it as at), or when no spot has lava-free ground ' +
    '(no_safe_spot). Other failures: no_source, not_a_source, inventory_full, unreachable. A water bucket already ' +
    'carried is never used up. To put a liquid back use place_block with the bucket. Runs in the background: poll ' +
    'get_task_status when the reply has status "running".'
  readonly inputSchema = fillBucketSchema

  constructor(
    private readonly skill: FillBucketSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof fillBucketSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Fill ${String(input.count)} bucket(s) with ${input.liquid}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              liquid: input.liquid,
              count: input.count,
              at: input.at,
              maxDistance: input.max_distance,
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
