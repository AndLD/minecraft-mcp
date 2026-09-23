import { z } from 'zod'
import type { BuildFarmInput, BuildFarmSkill } from '../../skills/farming/build-farm-skill.js'
import type { HarvestCropsSkill } from '../../skills/farming/harvest-crops-skill.js'
import type { InspectFarmSkill } from '../../skills/farming/inspect-farm-skill.js'
import type { PlantCropsSkill } from '../../skills/farming/plant-crops-skill.js'
import type { TendFarmSkill } from '../../skills/farming/tend-farm-skill.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import { INVENTORY_FULL_KINDS } from '../../state/storage-policy.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const positionSchema = z.object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })
const boundsSchema = z.object({ from: positionSchema, to: positionSchema })

const farmView = (entry: FarmEntry) => ({
  id: entry.id,
  kind: entry.kind,
  crop: entry.crop,
  bounds: entry.bounds,
  label: entry.label,
  group: entry.group,
  builtByBot: entry.builtByBot,
})

const buildFarmSchema = z.object({
  kind: z.string().min(1).describe('A farm layout kind: "field" (the only one built so far).'),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      'The kind\'s own parameters (for "field": width, length, crop, fence, torches). Work them out from the ' +
        "player's words; when unclear, ask.",
    ),
  origin: positionSchema
    .optional()
    .describe('Where the layout starts (the lowest x/z corner). Omit to start two blocks east of the bot.'),
  label: z.string().min(1).max(40).optional().describe('A name for the farm, for example "wheat field".'),
  group: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('Ties this together with other farm components, for example "home".'),
  fetch_from_storage: z
    .boolean()
    .default(true)
    .describe('Fetch missing seeds, water buckets, and fence from the containers the bot may use.'),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe('What to do when the inventory fills up while building. Defaults to the standing set_storage_policy.'),
  ...taskOptionsShape,
})

export class BuildFarmTool implements ToolDefinition<typeof buildFarmSchema> {
  readonly name = 'build_farm'
  readonly description =
    'Lays out a farm component: a tilled, watered, fenced field planted with a crop (kind: "field"). Needs a hoe, ' +
    'seeds (or carrots/potatoes/beetroot), water buckets, and fence; fetch_from_storage brings what is missing from ' +
    'known containers. On success the field is remembered (list_farms) and its footprint is protected from other ' +
    'tasks. Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = buildFarmSchema

  constructor(
    private readonly skill: BuildFarmSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof buildFarmSchema>, context: ToolContext) {
    const toInput: BuildFarmInput = {
      kind: input.kind,
      params: input.params,
      origin: input.origin,
      label: input.label,
      group: input.group,
      fetchFromStorage: input.fetch_from_storage,
      onInventoryFull: input.on_inventory_full,
    }
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Build a ${input.kind} farm`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run(toInput, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const farmOrAreaShape = {
  farm: z
    .string()
    .min(1)
    .optional()
    .describe('A farm id or label (see list_farms). Give this or area, not both.'),
  area: boundsSchema.optional().describe('Two opposite corners of the plot, when not using a registered farm.'),
}

const plantCropsSchema = z.object({
  ...farmOrAreaShape,
  crop: z.string().min(1).describe('What to plant: wheat, carrots, potatoes, or beetroots (or the seed item name).'),
  max_plants: z.number().int().min(1).optional().describe('Stop after planting this many (default: the whole area).'),
  ...taskOptionsShape,
})

export class PlantCropsTool implements ToolDefinition<typeof plantCropsSchema> {
  readonly name = 'plant_crops'
  readonly description =
    'Hoes dirt and grass into farmland and plants the given crop on every free plot of a farm or an area, skipping ' +
    'any plot that already has a crop. Fails no_hoe or no_seeds when the bot runs out of either. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = plantCropsSchema

  constructor(
    private readonly skill: PlantCropsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof plantCropsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Plant ${input.crop}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            { farm: input.farm, area: input.area, crop: input.crop, maxPlants: input.max_plants },
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

const harvestCropsSchema = z.object({
  ...farmOrAreaShape,
  replant: z.boolean().default(true).describe('Replant each harvested plot at once, keeping a seed in reserve.'),
  ...taskOptionsShape,
})

export class HarvestCropsTool implements ToolDefinition<typeof harvestCropsSchema> {
  readonly name = 'harvest_crops'
  readonly description =
    'Harvests only fully grown crops on a farm or an area and, by default, replants at once. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = harvestCropsSchema

  constructor(
    private readonly skill: HarvestCropsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof harvestCropsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Harvest crops',
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run({ farm: input.farm, area: input.area, replant: input.replant }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const tendFarmSchema = z.object({
  farm: z.string().min(1).describe('A farm id, label, or group name (see list_farms).'),
  ...taskOptionsShape,
})

export class TendFarmTool implements ToolDefinition<typeof tendFarmSchema> {
  readonly name = 'tend_farm'
  readonly description =
    'One pass over a registered farm, or every component of a group: harvests what is ripe, replants, and fills ' +
    'empty plots. A component that fails is reported and skipped; the others carry on. Runs in the background: ' +
    'poll get_task_status when the reply has status "running".'
  readonly inputSchema = tendFarmSchema

  constructor(
    private readonly skill: TendFarmSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof tendFarmSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Tend ${input.farm}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) => this.skill.run({ farm: input.farm }, ctx),
      },
      {
        replace: input.replace,
        waitSeconds: input.wait_seconds ?? DEFAULT_WAIT_SECONDS,
        signal: context.signal,
      },
    )
  }
}

const inspectFarmSchema = z.object({
  farm: z.string().min(1).describe('A farm id, label, or group name (see list_farms).'),
})

export class InspectFarmTool implements ToolDefinition<typeof inspectFarmSchema> {
  readonly name = 'inspect_farm'
  readonly description =
    'Read-only: reports a farm or group\'s ripe, growing, and empty plots without touching anything. Call this for ' +
    '"check the farm"; use tend_farm to actually do the work.'
  readonly inputSchema = inspectFarmSchema

  constructor(private readonly skill: InspectFarmSkill) {}

  async execute(input: z.output<typeof inspectFarmSchema>, context: ToolContext) {
    const result = await this.skill.run({ farm: input.farm }, {
      signal: context.signal,
      progress: () => undefined,
    })
    return result.ok ? toolOk(result.value) : toolFail(result.error.message)
  }
}

const registerFarmSchema = z.object({
  kind: z.enum(['field', 'pen', 'grove']).default('field').describe('What kind of farm component this is.'),
  crop: z.string().min(1).optional().describe('The crop it grows, for a field.'),
  from: positionSchema.describe('One corner of the component.'),
  to: positionSchema.describe('The opposite corner.'),
  label: z.string().min(1).max(40).optional().describe('A name for it, for example "wheat field".'),
  group: z.string().min(1).max(40).optional().describe('Ties this together with other components, for example "home".'),
})

export class RegisterFarmTool implements ToolDefinition<typeof registerFarmSchema> {
  readonly name = 'register_farm'
  readonly description =
    'Remembers a farm component the player built by hand (or one the bot built without build_farm), by its two ' +
    'corners. Saved per world; does not touch any blocks.'
  readonly inputSchema = registerFarmSchema

  constructor(private readonly farms: FarmRegistry) {}

  execute(input: z.output<typeof registerFarmSchema>) {
    const registered = this.farms.register({
      kind: input.kind,
      crop: input.crop,
      bounds: { from: input.from, to: input.to },
      label: input.label,
      group: input.group,
      builtByBot: false,
    })
    return registered.ok ? toolOk({ farm: farmView(registered.value) }) : toolFail(registered.error)
  }
}

const listFarmsSchema = z.object({})

export class ListFarmsTool implements ToolDefinition<typeof listFarmsSchema> {
  readonly name = 'list_farms'
  readonly description = 'Lists the farm components the bot remembers: id, kind, crop, bounds, label, and group.'
  readonly inputSchema = listFarmsSchema

  constructor(private readonly farms: FarmRegistry) {}

  execute() {
    const list = this.farms.list()
    if (!list.ok) return toolFail(list.error)
    return toolOk({ count: list.value.length, farms: list.value.map(farmView) })
  }
}
