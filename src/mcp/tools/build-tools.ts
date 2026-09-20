import { z } from 'zod'
import type { BlueprintRegistry } from '../../skills/building/blueprint-registry.js'
import type { BuildInput, BuildSkill } from '../../skills/building/build-skill.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const originSchema = z
  .object({
    x: coordinate('x'),
    y: coordinate('y (the height of the lowest layer)'),
    z: coordinate('z'),
  })
  .optional()
  .describe(
    "The blueprint's lowest corner (smallest x, y, and z); the shape grows towards +x, +y, +z from it. Omit to build two blocks east of the bot, on its level; preview_build shows where that is.",
  )

const buildShape = {
  blueprint: z
    .string()
    .min(1)
    .describe('A blueprint name from list_blueprints, for example "box".'),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      "The blueprint's parameters (width, depth, height, block, ...), as list_blueprints describes them.",
    ),
  origin: originSchema,
  clear_obstacles: z
    .boolean()
    .default(false)
    .describe(
      'Break natural blocks (dirt, stone, grass) that stand where the building goes. Without it the tool refuses and names the blocked cells. Protected areas are never touched.',
    ),
}

const toInput = (input: {
  blueprint: string
  params: Record<string, unknown>
  origin?: { x: number; y: number; z: number } | undefined
  clear_obstacles: boolean
  fetch_from_storage?: boolean
  on_inventory_full?: BuildInput['onInventoryFull']
}): BuildInput => ({
  blueprint: input.blueprint,
  params: input.params,
  origin: input.origin,
  clearObstacles: input.clear_obstacles,
  fetchFromStorage: input.fetch_from_storage ?? false,
  onInventoryFull: input.on_inventory_full,
})

const buildSchema = z.object({
  ...buildShape,
  fetch_from_storage: z
    .boolean()
    .default(true)
    .describe(
      'Fetch missing materials from the containers the bot may use (never protected ones).',
    ),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe(
      'What to do when the inventory fills up while breaking blocks (only with clear_obstacles): "offload_and_return", "ask", or "stop". Defaults to the standing set_storage_policy.',
    ),
  ...taskOptionsShape,
})

export class BuildTool implements ToolDefinition<typeof buildSchema> {
  readonly name = 'build'
  readonly description =
    'Builds a blueprint (a floor, walls, a closed box, a solid block, ...; see list_blueprints) with blocks from the inventory: ' +
    'it walks around the site, places every block against something that supports it (so walls grow from the ground up), ' +
    'skips what is already there, and checks the result at the end. Call preview_build first for anything big: it lists ' +
    'the materials and what stands in the way, and nothing is changed until this call. Refuses, changing nothing, with ' +
    'missing_materials (it fetches from chests first when it may; offer to gather or craft the rest), blocked_cells, ' +
    'protected_area, unsafe_site (lava), or invalid_params. It can also stop half way with incomplete, ' +
    'no_suitable_tool, inventory_full, or unsupported_steps: run it again and it continues where it stopped. Runs in ' +
    'the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = buildSchema

  constructor(
    private readonly skill: BuildSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof buildSchema>, context: ToolContext) {
    const request = toInput(input)
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Build ${input.blueprint}`,
        resume: {
          tool: this.name,
          arguments: {
            blueprint: input.blueprint,
            params: input.params,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            clear_obstacles: input.clear_obstacles,
            fetch_from_storage: input.fetch_from_storage,
          },
        },
        run: (ctx) => this.skill.run(request, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const previewSchema = z.object(buildShape)

export class PreviewBuildTool implements ToolDefinition<typeof previewSchema> {
  readonly name = 'preview_build'
  readonly description =
    'Shows what build would do, without changing anything: where the building would stand (origin and the corners of its ' +
    'volume; defaultOrigin says it was worked out from the bot position), how many blocks to place and break, what is ' +
    'already built, the materials needed and what is missing, cells that are blocked, a protected area it would touch, ' +
    'and hazards such as lava. Use it to tell the player the cost and to choose a spot.'
  readonly inputSchema = previewSchema

  constructor(private readonly skill: BuildSkill) {}

  execute(input: z.output<typeof previewSchema>) {
    const preview = this.skill.preview(toInput(input))
    return preview.ok
      ? toolOk(preview.value)
      : toolFail(`${preview.error.message} (reason: ${preview.error.reason})`)
  }
}

const listSchema = z.object({})

export class ListBlueprintsTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_blueprints'
  readonly description =
    'Lists the shapes build can make, each with what it builds and a JSON schema of its parameters (sizes are in blocks, ' +
    'width along x and depth along z). Read-only.'
  readonly inputSchema = listSchema

  constructor(private readonly registry: BlueprintRegistry) {}

  execute() {
    return toolOk({ blueprints: this.registry.list() })
  }
}

const placeSchema = z.object({
  block: z
    .string()
    .min(1)
    .describe('Item name of the block, for example "cobblestone" or "torch".'),
  x: coordinate('x'),
  y: coordinate('y'),
  z: coordinate('z'),
  clear_obstacles: buildShape.clear_obstacles,
  ...taskOptionsShape,
})

export class PlaceBlockTool implements ToolDefinition<typeof placeSchema> {
  readonly name = 'place_block'
  readonly description =
    'Places one block from the inventory at exact coordinates (the cell must be empty or hold grass, and something solid ' +
    'must touch it to be placed against). It walks within reach first. Same refusals as build: missing_materials, ' +
    'blocked_cells, protected_area, unsupported_steps (nothing to place against).'
  readonly inputSchema = placeSchema

  constructor(
    private readonly skill: BuildSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof placeSchema>, context: ToolContext) {
    const request: BuildInput = {
      blueprint: 'block',
      params: { block: input.block },
      origin: { x: input.x, y: input.y, z: input.z },
      clearObstacles: input.clear_obstacles,
      fetchFromStorage: false,
    }
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Place ${input.block} at ${String(input.x)}, ${String(input.y)}, ${String(input.z)}`,
        run: (ctx) => this.skill.run(request, ctx),
      },
      { replace: input.replace, waitSeconds: input.wait_seconds ?? 20, signal: context.signal },
    )
  }
}
