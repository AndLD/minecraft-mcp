import { z } from 'zod'
import { PENNABLE_SPECIES } from '../../skills/farming/animal-table.js'
import type { BreedAnimalsSkill } from '../../skills/farming/breed-animals-skill.js'
import type { BuildFarmInput, BuildFarmSkill } from '../../skills/farming/build-farm-skill.js'
import type { CollectEggsSkill } from '../../skills/farming/collect-eggs-skill.js'
import type { HarvestCropsSkill } from '../../skills/farming/harvest-crops-skill.js'
import type { InspectFarmSkill } from '../../skills/farming/inspect-farm-skill.js'
import type { LureAnimalsSkill } from '../../skills/farming/lure-animals-skill.js'
import type { PlantCropsSkill } from '../../skills/farming/plant-crops-skill.js'
import type { TendFarmSkill } from '../../skills/farming/tend-farm-skill.js'
import { EGG_RELEASE_KINDS, type EggPolicy } from '../../state/egg-policy.js'
import type { FarmEntry, FarmRegistry } from '../../state/farm-registry.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
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
  species: entry.species,
  herdTarget: entry.herdTarget,
  bounds: entry.bounds,
  label: entry.label,
  group: entry.group,
  builtByBot: entry.builtByBot,
})

const buildFarmSchema = z.object({
  kind: z.string().min(1).describe('A farm layout kind: "field" or "pen".'),
  params: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      'The kind\'s own parameters (for "field": width, length, crop, fence, torches; for "pen": width, length, ' +
        "species, water, torches). Work them out from the player's words; when unclear, ask.",
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
  herd_target: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('For a pen: the herd size tend_farm breeds up to and culls down to.'),
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
    'Lays out a farm component: a tilled, watered, fenced field planted with a crop (kind: "field"), or a fenced ' +
    'pen for one animal species (kind: "pen"). Needs a hoe, seeds (or carrots/potatoes/beetroot), water buckets, ' +
    'and fence; fetch_from_storage brings what is missing from known containers. On success the component is ' +
    'remembered (list_farms) and its footprint is protected from other tasks. Runs in the background: poll ' +
    'get_task_status when the reply has status "running".'
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
      herdTarget: input.herd_target,
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

const lureAnimalsSchema = z.object({
  species: z.enum(PENNABLE_SPECIES).describe(`Which wild animal to lead in: ${PENNABLE_SPECIES.join(', ')}.`),
  count: z.number().int().min(1).describe('How many to lead in.'),
  farm: z.string().min(1).optional().describe('The pen to lead them into (see list_farms). Give this or destination.'),
  destination: positionSchema.optional().describe('A position to lead them to, when not using a registered pen.'),
  max_distance: z.number().int().min(1).max(64).default(32).describe('How far away to look for wild animals.'),
  ...taskOptionsShape,
})

export class LureAnimalsTool implements ToolDefinition<typeof lureAnimalsSchema> {
  readonly name = 'lure_animals'
  readonly description =
    'Finds nearby wild animals of a species and leads them, one at a time, into a pen or to a position, holding ' +
    'the food that species follows. Never tamed, named, saddled, or ridden animals. One that falls behind or ' +
    'loses interest is abandoned (recorded, not chased) and the next nearest is tried. Fails no_animals_nearby ' +
    'when nothing is found, or no_food when the bot runs out; reports penFull (a shortfall, not a failure) when ' +
    'the destination pen is already at capacity. Runs in the background: poll get_task_status when the reply has ' +
    'status "running".'
  readonly inputSchema = lureAnimalsSchema

  constructor(
    private readonly skill: LureAnimalsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof lureAnimalsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Lead ${String(input.count)} ${input.species} in`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              species: input.species,
              count: input.count,
              farm: input.farm,
              destination: input.destination,
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

const breedAnimalsSchema = z.object({
  species: z.enum(PENNABLE_SPECIES).describe(`Which species to breed: ${PENNABLE_SPECIES.join(', ')}.`),
  target_count: z.number().int().min(1).describe('Stop once the herd (adults and babies together) reaches this size.'),
  ...farmOrAreaShape,
  ...taskOptionsShape,
})

export class BreedAnimalsTool implements ToolDefinition<typeof breedAnimalsSchema> {
  readonly name = 'breed_animals'
  readonly description =
    'Feeds pairs of eligible adults of a species (never tamed, named, saddled, or ridden) their breeding food and ' +
    'waits to see whether a baby appears, until the herd reaches target_count or there are no more eligible pairs. ' +
    'Fails no_food when the bot runs out. Runs in the background: poll get_task_status when the reply has status ' +
    '"running".'
  readonly inputSchema = breedAnimalsSchema

  constructor(
    private readonly skill: BreedAnimalsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof breedAnimalsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Breed ${input.species} up to ${String(input.target_count)}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            { species: input.species, farm: input.farm, area: input.area, targetCount: input.target_count },
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

const collectEggsSchema = z.object({
  ...farmOrAreaShape,
  store_fraction: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Share of what is picked up to store instead of releasing for chicks (0-1). Defaults to set_egg_policy (0.1).'),
  release: z
    .enum(EGG_RELEASE_KINDS)
    .optional()
    .describe(
      '"hatch" (default): throw the rest into the pen, one at a time, for a chance at chicks. "store": keep everything.',
    ),
  max_chickens: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Stop releasing once the pen holds this many chickens (adults and babies together). Defaults to the pen's " +
        'herd_target, or a rough figure from its size.',
    ),
  ...taskOptionsShape,
})

export class CollectEggsTool implements ToolDefinition<typeof collectEggsSchema> {
  readonly name = 'collect_eggs'
  readonly description =
    'Picks up the egg items lying in a registered pen or an area (never by hitting or harming a chicken: this only ' +
    'ever touches ground items), skipping a protected area unless it is the pen\'s own. Stores a share (through the ' +
    'ordinary storage rules) and throws the rest into the pen one at a time for a chance at chicks, unless the pen ' +
    'already holds its target chicken count (reported as penFull, a shortfall, not a failure). Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = collectEggsSchema

  constructor(
    private readonly skill: CollectEggsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof collectEggsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Collect eggs',
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              farm: input.farm,
              area: input.area,
              storeFraction: input.store_fraction,
              release: input.release,
              maxChickens: input.max_chickens,
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

const setEggPolicySchema = z.object({
  store_fraction: z
    .number()
    .min(0)
    .max(1)
    .default(0.1)
    .describe('Share of collected eggs to store instead of releasing for chicks.'),
  release: z
    .enum(EGG_RELEASE_KINDS)
    .default('hatch')
    .describe('"hatch": throw the rest into the pen for a chance at chicks. "store": keep everything.'),
})

export class SetEggPolicyTool implements ToolDefinition<typeof setEggPolicySchema> {
  readonly name = 'set_egg_policy'
  readonly description =
    'Saves how collect_eggs splits what it picks up, as a standing rule for this world: how much to store ' +
    '(store_fraction, default 0.1) and whether to release the rest for chicks or store everything (release). ' +
    'Set it when the player says something like "keep half the eggs" or "store them all". Survives restarts and ' +
    'appears in the session briefing when it differs from the default. Fails when no world is active.'
  readonly inputSchema = setEggPolicySchema

  constructor(
    private readonly policy: EggPolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof setEggPolicySchema>) {
    const saved = this.policy.set({ storeFraction: input.store_fraction, release: input.release })
    if (!saved.ok) return toolFail(saved.error)
    const isDefault = input.store_fraction === 0.1 && input.release === 'hatch'
    if (isDefault) this.standing.remove('egg_policy')
    else
      this.standing.set(
        'egg_policy',
        `Eggs: store ${String(Math.round(input.store_fraction * 100))}%, ${
          input.release === 'hatch' ? 'release the rest for chicks' : 'store everything'
        }.`,
      )
    return toolOk({ storeFraction: input.store_fraction, release: input.release })
  }
}

const tendFarmSchema = z.object({
  farm: z.string().min(1).describe('A farm id, label, or group name (see list_farms).'),
  ...taskOptionsShape,
})

export class TendFarmTool implements ToolDefinition<typeof tendFarmSchema> {
  readonly name = 'tend_farm'
  readonly description =
    'One pass over a registered farm, or every component of a group: for a field, harvests what is ripe, ' +
    'replants, and fills empty plots; for a pen with a species and herd_target set, breeds it up or culls the ' +
    'surplus with hunt_animals. A component that fails is reported and skipped; the others carry on. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
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
  species: z.string().min(1).optional().describe('The animal species it keeps, for a pen.'),
  herd_target: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('For a pen: the herd size tend_farm breeds up to and culls down to.'),
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
      species: input.species,
      herdTarget: input.herd_target,
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
  readonly description =
    'Lists the farm components the bot remembers: id, kind, crop or species, bounds, label, and group.'
  readonly inputSchema = listFarmsSchema

  constructor(private readonly farms: FarmRegistry) {}

  execute() {
    const list = this.farms.list()
    if (!list.ok) return toolFail(list.error)
    return toolOk({ count: list.value.length, farms: list.value.map(farmView) })
  }
}
