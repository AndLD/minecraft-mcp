import { z } from 'zod'
import type { ExcavationRegistry } from '../../skills/excavation/excavation-registry.js'
import type { ExcavateInput, ExcavateSkill } from '../../skills/excavation/excavate-skill.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)

const shape = {
  shape: z
    .string()
    .min(1)
    .describe(
      'A shape from list_excavations: "pit", "shaft", "quarry", "tunnel", "branch_mine", or "staircase_down".',
    ),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      "The shape's parameters as separate numbers (width, length, depth, height, direction, spacing, ...), as list_excavations describes them. " +
        'Work the numbers out from the player\'s words yourself ("1 wide, 5 high, 50 deep" is width 1, height 5, length 50); when it is unclear which number is which, ask the player. preview_excavation echoes what was understood.',
    ),
  origin: z
    .object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })
    .optional()
    .describe(
      'Where the dig starts (what that cell is depends on the shape: see list_excavations). Omit to start at the bot; preview_excavation shows the result.',
    ),
}

const toInput = (input: {
  shape: string
  params: Record<string, unknown>
  origin?: { x: number; y: number; z: number } | undefined
  fetch_from_storage?: boolean
  spoil_policy?: ExcavateInput['spoilPolicy']
  on_inventory_full?: ExcavateInput['onInventoryFull']
}): ExcavateInput => ({
  shape: input.shape,
  params: input.params,
  origin: input.origin,
  fetchFromStorage: input.fetch_from_storage ?? false,
  spoilPolicy: input.spoil_policy,
  onInventoryFull: input.on_inventory_full,
})

const excavateSchema = z.object({
  ...shape,
  fetch_from_storage: z
    .boolean()
    .default(true)
    .describe(
      'Fetch missing ladders and torches from the containers the bot may use (never protected ones).',
    ),
  spoil_policy: z
    .enum(['storage', 'discard_junk'])
    .default('storage')
    .describe(
      'What happens to the spoil when the inventory is full. "storage" (default): the standing storage policy decides (on_inventory_full below). "discard_junk": the bot throws away cobblestone, dirt, gravel, deepslate and the like beyond a stock of 64 each, where it stands, and carries on; ores, tools, food, torches, and ladders are never thrown. Use it only when the player says the spoil does not matter.',
    ),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe(
      'What to do when the inventory fills up (a quarry moves thousands of blocks): "offload_and_return", "ask" (pause and wait for resume_task), or "stop". Defaults to the standing set_storage_policy, which defaults to ask.',
    ),
  ...taskOptionsShape,
})

export class ExcavateTool implements ToolDefinition<typeof excavateSchema> {
  readonly name = 'excavate'
  readonly description =
    'Digs a pit, shaft, quarry, tunnel, branch mine (a tunnel with side branches), or staircase, with the right tool, ' +
    'picking up what it breaks and mining any ore that touches the dug space. Call preview_excavation first for anything ' +
    'big: it shows the dimensions understood, the blocks, materials (ladders, torches), and a time estimate; nothing is ' +
    'dug until this call. Safety is built in: before a block is broken it and the six blocks touching it are checked, and ' +
    '**lava or water in any of them ends that tunnel or branch one block short** (the others carry on); it also ends at an ' +
    'open cave, sand or gravel overhead, a spawner, chests, rails, and anything not loaded, and never breaks protected ' +
    'areas. The result lists every chain that ended early with the reason (hit_lava, hit_water, cave_breakthrough, ' +
    'falling_blocks, spawner, player_block, unloaded) and the place: tell the player. Stops with no_torches (torches run out), ' +
    'no_suitable_tool, inventory_full, or missing_materials (ladders); run it again and it continues where it stopped. ' +
    'Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = excavateSchema

  constructor(
    private readonly skill: ExcavateSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof excavateSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Excavate ${input.shape}`,
        resume: {
          tool: this.name,
          arguments: {
            shape: input.shape,
            params: input.params,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            fetch_from_storage: input.fetch_from_storage,
            spoil_policy: input.spoil_policy,
          },
        },
        run: (ctx) => this.skill.run(toInput(input), ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const previewSchema = z.object(shape)

export class PreviewExcavationTool implements ToolDefinition<typeof previewSchema> {
  readonly name = 'preview_excavation'
  readonly description =
    'Shows what excavate would do, without changing anything: the parameters as understood (`interpreted`, defaults filled in: ' +
    'check them against what the player said), where the dig starts and its corners, how many blocks (`blocks`), a rough ' +
    'time, the materials needed and what is missing (ladders, torches), and a protected area it would touch.'
  readonly inputSchema = previewSchema

  constructor(private readonly skill: ExcavateSkill) {}

  execute(input: z.output<typeof previewSchema>) {
    const preview = this.skill.preview(toInput(input))
    return preview.ok
      ? toolOk(preview.value)
      : toolFail(`${preview.error.message} (reason: ${preview.error.reason})`)
  }
}

const listSchema = z.object({})

export class ListExcavationsTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_excavations'
  readonly description =
    'Lists the shapes excavate can dig, each with what it digs, what its origin is, and a JSON schema of its parameters ' +
    '(sizes are numbers in blocks). Read-only.'
  readonly inputSchema = listSchema

  constructor(private readonly registry: ExcavationRegistry) {}

  execute() {
    return toolOk({ shapes: this.registry.list() })
  }
}
