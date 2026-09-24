import { z } from 'zod'
import type {
  BuildRailwayOutput,
  BuildRailwaySkill,
  RailwayInput,
} from '../../skills/railway/build-railway-skill.js'
import type { PlaceMinecartSkill } from '../../skills/railway/place-minecart-skill.js'
import { ECONOMY_SPACING_MAX, ECONOMY_SPACING_MIN } from '../../skills/railway/rail-table.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const positionSchema = z.object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })

const routeShape = {
  from: positionSchema
    .optional()
    .describe(
      'The rail cell the line starts at (feet level, the block above the ground). Omit to start at the bot.',
    ),
  to: positionSchema
    .optional()
    .describe(
      'The rail cell the line ends at. A height within 3 blocks of the ground there is moved to the ground. Give this or to_player.',
    ),
  to_player: z
    .string()
    .min(1)
    .optional()
    .describe('End at where this player stands (they must be in view). Give this or to.'),
  layout: z
    .enum(['auto', 'surface', 'underground'])
    .default('auto')
    .describe(
      '"surface" follows the terrain (cuts small rises, bridges dips and water with support blocks). "underground" is a tunnel below the surface in the middle, lit with torches. "auto" (default) takes the surface unless it needs a lot of earthwork.',
    ),
  variant: z
    .enum(['economy', 'rich'])
    .default('economy')
    .describe(
      '"economy" (default): plain rails with a powered rail (and its own redstone torch) every `spacing` rails on level track and every 3 on a slope. "rich": powered rails all the way (corners are plain rails), a torch about every 9.',
    ),
  spacing: z
    .number()
    .int()
    .min(ECONOMY_SPACING_MIN)
    .max(ECONOMY_SPACING_MAX)
    .optional()
    .describe(
      `Economy only: rails between powered rails on level track (${String(ECONOMY_SPACING_MIN)}-${String(ECONOMY_SPACING_MAX)}, default 8).`,
    ),
  depth: z
    .number()
    .int()
    .min(2)
    .max(32)
    .optional()
    .describe(
      'For a tunnel: how far below the surface it runs in the middle (default 6). The ends come up to the surface.',
    ),
  support_block: z
    .string()
    .min(1)
    .default('cobblestone')
    .describe(
      'The block laid under a rail where the ground is missing, and behind the first rail (default cobblestone; dirt works too).',
    ),
  label: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('A name for the line, for example "mine line".'),
}

const toInput = (
  input: {
    from?: { x: number; y: number; z: number } | undefined
    to?: { x: number; y: number; z: number } | undefined
    to_player?: string | undefined
    layout: 'auto' | 'surface' | 'underground'
    variant: 'economy' | 'rich'
    spacing?: number | undefined
    depth?: number | undefined
    support_block: string
    label?: string | undefined
  },
  extra: Pick<RailwayInput, 'fetchFromStorage' | 'verify' | 'onInventoryFull'>,
): RailwayInput => ({
  from: input.from,
  to: input.to,
  toPlayer: input.to_player,
  layout: input.layout,
  variant: input.variant,
  spacing: input.spacing,
  depth: input.depth,
  supportBlock: input.support_block,
  label: input.label,
  ...extra,
})

const planRailwaySchema = z.object({ ...routeShape })

export class PlanRailwayTool implements ToolDefinition<typeof planRailwaySchema> {
  readonly name = 'plan_railway'
  readonly description =
    'Dry run for build_railway: works out where a railway would run and reports it without changing anything: length, ' +
    'layout (surface or underground), where it turns, slopes, blocks to cut and to bridge, powered rails and torches, ' +
    'the materials it takes (rails, powered rails, redstone torches, support blocks) with what is missing and the ' +
    'iron, gold, redstone, and sticks to craft it, and a rough time. Only loaded terrain is planned (about a hundred ' +
    'blocks around the bot); for a longer line plan and build it in stages. Fails with a reason such as unloaded, ' +
    "no_route (the message says where and why: lava, somebody's build, water, too steep), protected_area, or too_long."
  readonly inputSchema = planRailwaySchema

  constructor(private readonly skill: BuildRailwaySkill) {}

  execute(input: z.output<typeof planRailwaySchema>) {
    const result = this.skill.preview(
      toInput(input, { fetchFromStorage: false, verify: false, onInventoryFull: undefined }),
    )
    return result.ok
      ? toolOk(result.value)
      : toolFail(`${result.error.message} (reason: ${result.error.reason})`)
  }
}

const buildRailwaySchema = z.object({
  ...routeShape,
  fetch_from_storage: z
    .boolean()
    .default(true)
    .describe(
      'Fetch missing rails, torches, and support blocks from the containers the bot may use.',
    ),
  verify: z
    .boolean()
    .default(true)
    .describe(
      'When done, check every rail (kind, shape, power) and put right what is wrong, once.',
    ),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe(
      'What to do when the inventory fills up while cutting. Defaults to the standing set_storage_policy.',
    ),
  ...taskOptionsShape,
})

export class BuildRailwayTool implements ToolDefinition<typeof buildRailwaySchema> {
  readonly name = 'build_railway'
  readonly description =
    'Builds a railway from one place to another: plans the route (see plan_railway, which shows it first), cuts what ' +
    'is in the way, bridges dips and water, lays rails, and powers them with redstone torches so a cart keeps its ' +
    'speed. The first rail is powered and has a block behind it, so a minecart placed there (place_minecart) starts by ' +
    "itself. Never digs into lava, other people's builds, or protected areas; a dig that meets lava, water, or a cave " +
    'ends the line there (failure line_incomplete says where). Needs the rails and torches in the inventory (or ' +
    'chests: fetch_from_storage); missing_materials lists them and plan_railway says what to craft. Afterwards every ' +
    'rail is checked and what is wrong is put right once; the result has a verification report. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = buildRailwaySchema

  constructor(
    private readonly skill: BuildRailwaySkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof buildRailwaySchema>, context: ToolContext) {
    const railway = toInput(input, {
      fetchFromStorage: input.fetch_from_storage,
      verify: input.verify,
      onInventoryFull: input.on_inventory_full,
    })
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Build a ${input.variant} railway`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run(railway, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

export type { BuildRailwayOutput }

const placeMinecartSchema = z.object({
  at: positionSchema.optional().describe('The rail to put the minecart on.'),
  line: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A railway (id or label) to put it at the start of. Without at or line: the start of the last railway built, else the nearest rail.',
    ),
  ...taskOptionsShape,
})

export class PlaceMinecartTool implements ToolDefinition<typeof placeMinecartSchema> {
  readonly name = 'place_minecart'
  readonly description =
    'Walks to a rail and puts a minecart from the inventory on it: by default at the start of the last railway ' +
    'built, where a cart starts by itself (the first rail is powered and has a block behind it). Riding it is up to ' +
    'the player. Fails no_minecart (craft one: 5 iron ingots), not_a_rail, no_rail, or unknown_railway.'
  readonly inputSchema = placeMinecartSchema

  constructor(
    private readonly skill: PlaceMinecartSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof placeMinecartSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Place a minecart',
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run({ at: input.at, line: input.line }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
