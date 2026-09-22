import { z } from 'zod'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err } from '../../core/result.js'
import type { SkillContext } from '../../core/skill.types.js'
import type { CollectBlocksSkill } from '../../skills/gathering/collect-blocks-skill.js'
import { BLOCK_ALIAS_NAMES } from '../../skills/gathering/block-aliases.js'
import { isTerrainBlock } from '../../skills/gathering/structured-gather.js'
import {
  isSiteUnsuitable,
  type StructuredGatherSkill,
} from '../../skills/gathering/structured-gather-skill.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 25
const DEFAULT_STRUCTURED_THRESHOLD = 32

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
    .describe('How far to search from the bot, in blocks (1-64). Only used for a scattered dig.'),
  layout: z
    .enum(['auto', 'scattered', 'structured'])
    .default('auto')
    .describe(
      'Only matters for a single, exact bulk terrain block (dirt, stone, cobblestone, sand, gravel, netherrack; not a group, not ore, not wood). "auto" (default) digs one small, contained pit or quarry instead of scattered single-block holes once count reaches structured_threshold, and digs scattered below it. "structured" always digs the contained shape (even for a small count); "scattered" always hunts nearest-first block by block (even for a big count), for when the ground should stay undisturbed. Anything not a single bulk terrain block always digs scattered, whatever this says.',
    ),
  structured_threshold: z
    .number()
    .int()
    .min(1)
    .max(2304)
    .default(DEFAULT_STRUCTURED_THRESHOLD)
    .describe(
      `Only with layout: "auto". The block count at or above which a bulk terrain request switches to a structured dig (default ${String(DEFAULT_STRUCTURED_THRESHOLD)}, about two stacks).`,
    ),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe(
      'What to do when the inventory fills up: "offload_and_return" (take things to the chests by the storage rules, come back, carry on), "ask" (pause and wait for resume_task), or "stop". Defaults to the standing set_storage_policy, which defaults to ask.',
    ),
  ...taskOptionsShape,
})

interface GatherResult {
  readonly layout: 'scattered' | 'structured'
  readonly mined: number
  readonly requested: number
  readonly gained: readonly ItemCount[]
  readonly shape?: string
  readonly origin?: Position
  /** Set when a structured dig was tried and the site was not suitable, so it fell back to a scattered dig. */
  readonly structuredFallbackReason?: string
}

export class CollectBlockTool implements ToolDefinition<typeof schema> {
  readonly name = 'collect_block'
  readonly description =
    'Breaks blocks of the given types (exact names, or groups such as "logs" and "ores"), nearest first, and picks up the drops. It uses the best tool it carries, never tunnels ' +
    '(only blocks that touch open space are dug), never digs straight down, next to lava, or inside protected areas. ' +
    'A single, exact bulk terrain block (dirt, stone, cobblestone, sand, gravel, netherrack) requested in a large enough count digs one small, contained pit or quarry instead ' +
    '(see layout and structured_threshold), so gathering does not leave a scatter of holes; the result then also names the shape and where it is. ' +
    'Long jobs continue in the background: poll get_task_status when the reply has status "running". Result: blocks mined and ' +
    'what the inventory gained. Fails with a reason such as block_not_found, no_suitable_tool (say what to craft first), ' +
    'inventory_full (only when the policy is stop or the player said stop; otherwise a full inventory pauses the task, or offloads to chests), protected_area, or unreachable; the message says how ' +
    'many were collected before it stopped.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: CollectBlocksSkill,
    private readonly structured: StructuredGatherSkill | undefined,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const base = { blocks: input.blocks, max_distance: input.max_distance }
    // A resumed task only collects what is still missing.
    const progress = { remaining: input.count }
    const structuredBlock = this.structuredBlockFor(input)

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
        run: (ctx) => this.gather(structuredBlock, input, progress, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }

  /** The one exact terrain block a structured dig would target, or undefined when scattered is the only option. */
  private structuredBlockFor(input: z.output<typeof schema>): string | undefined {
    if (this.structured === undefined || input.layout === 'scattered') return undefined
    if (input.blocks.length !== 1) return undefined
    const [only] = input.blocks
    if (only === undefined || !isTerrainBlock(only)) return undefined
    if (input.layout === 'structured') return only
    return input.count >= input.structured_threshold ? only : undefined
  }

  private async gather(
    structuredBlock: string | undefined,
    input: z.output<typeof schema>,
    progress: { remaining: number },
    ctx: SkillContext,
  ) {
    if (structuredBlock === undefined) return this.scattered(input, progress, ctx)

    const structured = await this.structured?.run(
      { block: structuredBlock, count: input.count, onInventoryFull: input.on_inventory_full },
      ctx,
    )
    if (structured === undefined) return this.scattered(input, progress, ctx)
    if (structured.ok) {
      const result: GatherResult = { layout: 'structured', ...structured.value }
      return { ok: true as const, value: result }
    }
    if (!isSiteUnsuitable(structured.error)) return err(structured.error)
    // The site was not suitable (a cliff, water, a protected area, ...): fall back to the scattered dig, and say why.
    const fallback = await this.scattered(input, progress, ctx)
    if (!fallback.ok) return fallback
    return {
      ok: true as const,
      value: { ...fallback.value, structuredFallbackReason: structured.error.message },
    }
  }

  private async scattered(
    input: z.output<typeof schema>,
    progress: { remaining: number },
    ctx: SkillContext,
  ) {
    const ran = await this.skill.run(
      {
        names: input.blocks,
        count: input.count,
        maxDistance: input.max_distance,
        onInventoryFull: input.on_inventory_full,
        onMined: (mined) => {
          progress.remaining = input.count - mined
        },
      },
      ctx,
    )
    if (!ran.ok) return ran
    const result: GatherResult = { layout: 'scattered', ...ran.value }
    return { ok: true as const, value: result }
  }
}
