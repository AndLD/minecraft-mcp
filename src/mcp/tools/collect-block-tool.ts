import { z } from 'zod'
import type { Position } from '../../core/position.types.js'
import type { ItemCount } from '../../core/recipes.port.js'
import { err } from '../../core/result.js'
import type { SkillContext, SkillResult } from '../../core/skill.types.js'
import type { CollectSaplingsSkill } from '../../skills/farming/collect-saplings-skill.js'
import { isSaplingName, speciesOfBlocks } from '../../skills/farming/tree-table.js'
import type { CollectBlocksSkill } from '../../skills/gathering/collect-blocks-skill.js'
import { BLOCK_ALIAS_NAMES } from '../../skills/gathering/block-aliases.js'
import {
  isVeinName,
  type OpenVeinGatherSkill,
} from '../../skills/gathering/open-vein-gather-skill.js'
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
const DEFAULT_STRUCTURED_THRESHOLD = 5

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
      `Only with layout: "auto". The block count at or above which a bulk terrain request switches to a structured dig (default ${String(DEFAULT_STRUCTURED_THRESHOLD)}).`,
    ),
  search: z
    .enum(['open', 'open_then_tunnel', 'nearest'])
    .default('open')
    .describe(
      'Only for ores (exact ore names or "ores"; anything else ignores it). "open" (default): gather veins the bot can walk up to, the way a player would: veins in view with a walkable way to them are dug first, and when there are none the bot explores caves (lit, away from lava) until one comes into view; it never tunnels. If none can be found it fails no_open_vein and names a buried one. "open_then_tunnel": the same, and when no open vein can be found it digs a route to the nearest buried vein it can see through the rock (x-ray). "nearest": the older behaviour, nearest vein in the loaded area that touches open space, no search.',
    ),
  max_minutes: z
    .number()
    .min(1)
    .max(60)
    .default(10)
    .describe(
      'Only for ores with search "open" or "open_then_tunnel": how long the whole job, including cave exploring, may take, in minutes (1-60, default 10).',
    ),
  saplings: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Only when asked for: also collect this many tree saplings once the blocks are done, by breaking leaves (a leaf drops one about 1 time in 20, so it takes many leaves). From a single kind of log ("oak_log") the same species\' saplings, from a group such as "logs" any species; saplings the block run already gained count. Running short does not fail the request: the result has a "saplings" section saying how many it got and why it stopped.',
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
  readonly layout: 'scattered' | 'structured' | 'open_veins'
  readonly mined: number
  readonly requested: number
  readonly gained: readonly ItemCount[]
  readonly shape?: string
  readonly origin?: Position
  /** Only for open-vein gathering: caves explored for veins, and buried veins tunnelled to. */
  readonly explored?: number
  readonly tunnelled?: number
  /** Set when a structured dig was tried and the site was not suitable, so it fell back to a scattered dig. */
  readonly structuredFallbackReason?: string
  /** Only with `saplings` asked for. */
  readonly saplings?: SaplingsSection
}

interface SaplingsSection {
  readonly requested: number
  readonly gained: number
  /** Leaves broken for them. */
  readonly leaves: number
  /** `enough`, or why it stopped short (`leaf_budget`, `no_leaves`, ...). */
  readonly stoppedBecause: string
}

export class CollectBlockTool implements ToolDefinition<typeof schema> {
  readonly name = 'collect_block'
  readonly description =
    'Breaks blocks of the given types (exact names, or groups such as "logs" and "ores"), nearest first, and picks up the drops. Ores are gathered like a player would: veins with a walkable way to them first, exploring caves for them when none is in view, and tunnelling only with search "open_then_tunnel" (see search). It uses the best tool it carries, never tunnels ' +
    '(only blocks that touch open space are dug), never digs straight down, next to lava, or inside protected areas. ' +
    'A single, exact bulk terrain block (dirt, stone, cobblestone, sand, gravel, netherrack) requested in a large enough count digs one small, contained pit or quarry instead ' +
    '(see layout and structured_threshold), so gathering does not leave a scatter of holes; the result then also names the shape and where it is. ' +
    'Long jobs continue in the background: poll get_task_status when the reply has status "running". Result: blocks mined and ' +
    'what the inventory gained. Fails with a reason such as block_not_found, no_suitable_tool (say what to craft first), ' +
    'no_open_vein (ores: none with a way to them was found; the message names a buried one and the search to use), inventory_full (only when the policy is stop or the player said stop; otherwise a full inventory pauses the task, or offloads to chests), protected_area, or unreachable; the message says how ' +
    'many were collected before it stopped.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: CollectBlocksSkill,
    private readonly structured: StructuredGatherSkill | undefined,
    private readonly launcher: TaskLauncher,
    private readonly saplings?: CollectSaplingsSkill,
    private readonly openVeins?: OpenVeinGatherSkill,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    const base = {
      blocks: input.blocks,
      max_distance: input.max_distance,
      search: input.search,
      max_minutes: input.max_minutes,
    }
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
            return {
              ...base,
              count: Math.max(1, progress.remaining),
              ...(input.saplings === undefined ? {} : { saplings: input.saplings }),
            }
          },
        },
        run: async (ctx) =>
          this.withSaplings(await this.gather(structuredBlock, input, progress, ctx), input, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }

  private usesOpenVeins(input: z.output<typeof schema>): boolean {
    return (
      this.openVeins !== undefined && input.search !== 'nearest' && input.blocks.every(isVeinName)
    )
  }

  private async openVeinRun(
    input: z.output<typeof schema>,
    progress: { remaining: number },
    ctx: SkillContext,
  ): Promise<SkillResult<GatherResult>> {
    const ran = await this.openVeins?.run(
      {
        names: input.blocks,
        count: input.count,
        maxDistance: input.max_distance,
        maxMinutes: input.max_minutes,
        tunnel: input.search === 'open_then_tunnel',
        onInventoryFull: input.on_inventory_full,
        onMined: (mined) => {
          progress.remaining = input.count - mined
        },
      },
      ctx,
    )
    if (ran === undefined) return this.scattered(input, progress, ctx)
    if (!ran.ok) return err(ran.error)
    return { ok: true as const, value: { layout: 'open_veins', ...ran.value } }
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
  ): Promise<SkillResult<GatherResult>> {
    if (this.usesOpenVeins(input)) return this.openVeinRun(input, progress, ctx)
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

  /** With `saplings` asked for, collects the saplings the block run did not already bring, and reports on them. */
  private async withSaplings<T extends { readonly gained: readonly ItemCount[] }>(
    ran: SkillResult<T>,
    input: z.output<typeof schema>,
    ctx: SkillContext,
  ) {
    if (!ran.ok || input.saplings === undefined || this.saplings === undefined) return ran
    const species = speciesOfBlocks(input.blocks)
    const already = ran.value.gained
      .filter(
        (item) =>
          isSaplingName(item.name) && (species === undefined || item.name === species.sapling),
      )
      .reduce((sum, item) => sum + item.count, 0)
    const missing = input.saplings - already
    if (missing <= 0)
      return {
        ok: true as const,
        value: {
          ...ran.value,
          saplings: {
            requested: input.saplings,
            gained: already,
            leaves: 0,
            stoppedBecause: 'enough',
          },
        },
      }

    const collected = await this.saplings.run(
      {
        species: species?.name,
        count: missing,
        maxLeaves: undefined,
        maxDistance: input.max_distance,
        onInventoryFull: input.on_inventory_full,
      },
      ctx,
    )
    if (collected.ok)
      return {
        ok: true as const,
        value: {
          ...ran.value,
          saplings: {
            requested: input.saplings,
            gained: already + collected.value.saplings,
            leaves: collected.value.leaves,
            stoppedBecause: 'enough',
          },
        },
      }
    if (collected.error.reason === 'aborted') return collected
    const detail = collected.error.detail
    return {
      ok: true as const,
      value: {
        ...ran.value,
        saplings: {
          requested: input.saplings,
          gained: already + (typeof detail?.saplings === 'number' ? detail.saplings : 0),
          leaves: typeof detail?.leaves === 'number' ? detail.leaves : 0,
          stoppedBecause: collected.error.reason,
        },
      },
    }
  }

  private async scattered(
    input: z.output<typeof schema>,
    progress: { remaining: number },
    ctx: SkillContext,
  ): Promise<SkillResult<GatherResult>> {
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
