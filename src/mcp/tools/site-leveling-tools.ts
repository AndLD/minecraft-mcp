import { z } from 'zod'
import type {
  FlattenAreaInput,
  FlattenAreaSkill,
} from '../../skills/site-leveling/flatten-area-skill.js'
import { DIRECTIONS } from '../../skills/excavation/providers/geometry.js'
import { DEFAULT_MARKER_BLOCKS } from '../../skills/site-leveling/marker-finder.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const shape = {
  for_player: z
    .string()
    .min(1)
    .optional()
    .describe('Whose position, facing, and markers to use. Defaults to the configured owner.'),
  width: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe(
      'Across the plot, to the right as the player faces (1-64). With length, the plot starts at the block the ' +
        'player stands on and runs the way they face; without it, two corner markers are looked for instead.',
    ),
  length: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe('Straight ahead as the player faces (1-64). See width.'),
  origin: z
    .object({
      x: z.number().int().describe('x block coordinate of the corner the rectangle starts from.'),
      z: z.number().int().describe('z block coordinate of the corner the rectangle starts from.'),
    })
    .optional()
    .describe(
      'Overrides where width/length starts (still needs width and length). Defaults to the player.',
    ),
  direction: z
    .enum(DIRECTIONS)
    .optional()
    .describe(
      "Overrides which way width/length runs. Defaults to the player's own facing, snapped to it.",
    ),
  marker_block: z
    .enum(['dirt', 'cobblestone'])
    .optional()
    .describe(
      `Only this block counts as a corner marker (a two-block-high stack). Both ${DEFAULT_MARKER_BLOCKS.join(' and ')} count by default.`,
    ),
  level: z
    .enum(['here', 'y', 'markers', 'auto'])
    .default('here')
    .describe(
      '"here" (default): the level of the block the player stands on. "y": the exact height given. "markers": the ' +
        'lower of the two corner-marker bases. "auto": preview_flatten only suggests the level that moves the fewest ' +
        'blocks (the median ground height); flatten_area refuses it (ambiguous_level) — preview first, then call with ' +
        'an explicit y.',
    ),
  y: z.number().int().optional().describe('Required, and only used, with level: "y".'),
  clear_height: z
    .number()
    .int()
    .min(1)
    .max(24)
    .default(6)
    .describe('How far above the level is cleared, in blocks (default 6, so a house fits).'),
  fill_block: z
    .string()
    .optional()
    .describe(
      'What fills a hole. Defaults to whatever cutting the plot itself turns up the most of (dirt, cobblestone, sand, ' +
        'gravel, ...), or dirt when nothing was cut.',
    ),
  surface_block: z
    .string()
    .optional()
    .describe(
      'Placed as the very top layer of a filled column, instead of fill_block (for example stone, to match the rest ' +
        'of a stone floor). Grass cannot be placed by hand, so a cut column keeps whatever was naturally there.',
    ),
  margin: z
    .number()
    .int()
    .min(0)
    .max(16)
    .default(0)
    .describe('Extra cleared blocks around the plot on every side (default 0).'),
  clear_trees: z
    .boolean()
    .default(true)
    .describe('Cut logs and leaves above the level too (default true). Off leaves trees standing.'),
  max_fill_depth: z
    .number()
    .int()
    .min(1)
    .max(64)
    .default(6)
    .describe(
      'A hole deeper than this, below the level, is left alone (default 6): an open cave is never buried by accident.',
    ),
  clear_structures: z
    .boolean()
    .default(false)
    .describe(
      'Remove player-placed blocks (planks, fences, doors, chests, ...) above the level too, instead of reporting ' +
        'them as blocked_cells and leaving them. Off by default: a flatten never grieves a build without being told to.',
    ),
  spoil_policy: z
    .enum(['storage', 'discard_junk'])
    .default('storage')
    .describe(
      'What happens to spoil when the inventory is full while cutting. "storage" (default): the standing storage ' +
        'policy decides (on_inventory_full below). "discard_junk": surplus cobblestone, dirt, gravel and the like ' +
        'beyond a stock of 64 each are thrown away and the cut carries on.',
    ),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe(
      'What to do when the inventory fills up: "offload_and_return", "ask" (pause and wait for resume_task), or ' +
        '"stop". Defaults to the standing set_storage_policy, which defaults to ask.',
    ),
}

const toInput = (input: z.output<typeof previewSchema>, player: string): FlattenAreaInput => ({
  player,
  width: input.width,
  length: input.length,
  origin: input.origin,
  direction: input.direction,
  markerBlocks: input.marker_block === undefined ? undefined : [input.marker_block],
  level: input.level,
  y: input.y,
  clearHeight: input.clear_height,
  fillBlock: input.fill_block,
  surfaceBlock: input.surface_block,
  margin: input.margin,
  clearTrees: input.clear_trees,
  maxFillDepth: input.max_fill_depth,
  clearStructures: input.clear_structures,
  spoilPolicy: input.spoil_policy,
  onInventoryFull: input.on_inventory_full,
  fetchFromStorage: true,
})

const previewSchema = z.object(shape)

export class PreviewFlattenTool implements ToolDefinition<typeof previewSchema> {
  readonly name = 'preview_flatten'
  readonly description =
    'Shows what flatten_area would do, without changing anything: the bounds and level understood, how many blocks would ' +
    'be cut, cleared, and filled, player-made cells it would leave alone (blocked_cells), and holes too deep to fill ' +
    '(too_deep). With level: "auto" it also reports the suggested level and, for comparison, the cost at the player\'s ' +
    'own level, so the player can be asked which to use.'
  readonly inputSchema = previewSchema

  constructor(
    private readonly skill: FlattenAreaSkill,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof previewSchema>) {
    const player = input.for_player ?? this.defaultPlayer
    if (player === undefined) return toolFail('Say which player: no owner is configured.')
    const preview = this.skill.preview(toInput(input, player))
    return preview.ok
      ? toolOk(preview.value)
      : toolFail(`${preview.error.message} (reason: ${preview.error.reason})`)
  }
}

const flattenSchema = z.object({ ...shape, ...taskOptionsShape })

export class FlattenAreaTool implements ToolDefinition<typeof flattenSchema> {
  readonly name = 'flatten_area'
  readonly description =
    'Levels a rectangle of ground to one height: cuts what is above it, fills what is below, and clears what grows there ' +
    '(grass, flowers, snow, and — with clear_trees — logs and leaves). The area is width x length starting where the ' +
    'player stands and running the way they face, or, without a size, two corner markers the player placed (two ' +
    'vertical, two-block-high stacks of dirt or cobblestone at opposite corners). Cutting is done first, and what it ' +
    'turns up (dirt, cobblestone, sand, gravel) is reused as fill, so little or nothing needs fetching. Player-made ' +
    'blocks above the level (a wall, a fence, a door, a chest) are left alone and reported as blocked_cells unless ' +
    'clear_structures is true. Refuses (unsafe_site) with lava in or next to the plot, and (protected_area) over a ' +
    'protected area. Call preview_flatten first for anything big. Runs in the background: poll get_task_status when ' +
    'the reply has status "running".'
  readonly inputSchema = flattenSchema

  constructor(
    private readonly skill: FlattenAreaSkill,
    private readonly launcher: TaskLauncher,
    private readonly defaultPlayer: string | undefined,
  ) {}

  execute(input: z.output<typeof flattenSchema>, context: ToolContext) {
    const player = input.for_player ?? this.defaultPlayer
    if (player === undefined) return toolFail('Say which player: no owner is configured.')
    const flattenInput = toInput(input, player)

    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Flatten the plot for ${player}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run(flattenInput, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}
