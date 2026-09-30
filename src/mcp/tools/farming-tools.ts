import { z } from 'zod'
import { PENNABLE_SPECIES } from '../../skills/farming/animal-table.js'
import type { BreedAnimalsSkill } from '../../skills/farming/breed-animals-skill.js'
import type { BuildFarmInput, BuildFarmSkill } from '../../skills/farming/build-farm-skill.js'
import type { CollectEggsSkill } from '../../skills/farming/collect-eggs-skill.js'
import type { DiscoverFarmSkill } from '../../skills/farming/discover-farm-skill.js'
import type { CollectSaplingsSkill } from '../../skills/farming/collect-saplings-skill.js'
import type { HarvestCropsSkill } from '../../skills/farming/harvest-crops-skill.js'
import type { HarvestTreesSkill } from '../../skills/farming/harvest-trees-skill.js'
import type { InspectFarmSkill } from '../../skills/farming/inspect-farm-skill.js'
import type { LureAnimalsSkill } from '../../skills/farming/lure-animals-skill.js'
import type { MilkCowsSkill } from '../../skills/farming/milk-cows-skill.js'
import type { ShearSheepSkill } from '../../skills/farming/shear-sheep-skill.js'
import type { FertilizeCropsSkill } from '../../skills/farming/fertilize-crops-skill.js'
import type { UseComposterSkill } from '../../skills/farming/use-composter-skill.js'
import type { PlantCropsSkill } from '../../skills/farming/plant-crops-skill.js'
import type { PlantTreesSkill } from '../../skills/farming/plant-trees-skill.js'
import { TREE_NAMES } from '../../skills/farming/tree-table.js'
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
  gateSide: entry.gateSide,
  spotCount: entry.spots?.length ?? null,
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
      'The kind\'s own parameters (for "field": width, length, crop, fence, torches, gate_side, water ("trench" by ' +
        'default, "spots" for separate water blocks); for "pen": width, length, species, gate_side, water, torches). ' +
        'gate_side (north, south, east, west; default south) puts the fence gate in the middle of that side, for a field or a pen. ' +
        'Work them out from ' +
        "the player's words; when unclear, ask.",
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
  preview: z
    .boolean()
    .default(false)
    .describe(
      'Only report what the build would do (steps, materials needed and missing, water buckets, warnings such as blocks in a pen it will not clear); change nothing.',
    ),
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
    'remembered (list_farms) and its footprint is protected from other tasks. A field is watered by a trench ' +
    'down the middle or by separate water blocks (params.water); every water block takes one filled water ' +
    'bucket (fill_bucket makes them), so use preview first to see how many are needed. A pen has its interior ' +
    'cleared of natural blocks left at fence level, and the gate is set in line with the fence. The gate goes on the ' +
    'side params.gate_side names (default south); it is remembered with the farm (list_farms, inspect_farm). A ' +
    'pumpkin field (crop: pumpkin) tills every second row for the stems and leaves the rows between free for the ' +
    'pumpkins; pumpkin_seeds come from crafting a pumpkin. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
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
    if (input.preview) {
      const preview = this.skill.preview(toInput)
      return preview.ok
        ? toolOk(preview.value)
        : toolFail(`${preview.error.message} (reason: ${preview.error.reason})`)
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
  crop: z.string().min(1).describe('What to plant: wheat, carrots, potatoes, beetroots, pumpkin, or melon (or the seed item name). Pumpkins and melons grow as stems that stay in place; only the tilled stem rows are planted.'),
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
    'Harvests only fully grown crops on a farm or an area and, by default, replants at once. On a pumpkin or melon field it ' +
    'breaks the fruit blocks and never the stems (nothing to replant; a melon block gives 3 to 7 slices). Runs in the ' +
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
    'loses interest is abandoned (recorded, not chased) and the next nearest is tried. The bot walks up to the ' +
    'animal first (a far flock in legs, trying again from where the animal is now), then leads it in short hops, ' +
    'waiting for it to catch up. Fails no_animals_nearby when nothing is found, or no_food when the bot runs out. ' +
    'Reply: led, requested, shortfall (requested minus led, whatever the reason), room (how many the pen could still ' +
    'take), abandoned (each animal given up on, with unreachable or lost_interest). penFull is true ONLY when the ' +
    'destination pen already held its capacity before anything was tried; led 0 with abandoned entries means ' +
    'nothing could be led, not that the pen is full. The pen\'s gate is shut when the task ends; gateLeftOpen is ' +
    'set only when it could not be, so tell the player. Runs in the background: poll get_task_status when the reply ' +
    'has status "running".'
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

const shearSheepSchema = z.object({
  ...farmOrAreaShape,
  count: z.number().int().min(1).optional().describe('Shear at most this many sheep. Every shearable sheep in reach when omitted.'),
  max_distance: z
    .number()
    .min(1)
    .max(64)
    .default(24)
    .describe('Without a farm or area: how far from the bot to look for sheep, in blocks.'),
  colour: z.string().min(1).optional().describe('Only sheep of this wool colour, for example "white" or "light_blue".'),
  ...taskOptionsShape,
})

export class ShearSheepTool implements ToolDefinition<typeof shearSheepSchema> {
  readonly name = 'shear_sheep'
  readonly description =
    'Takes the wool of adult sheep with shears, in a registered pen or area or within max_distance of the bot: walks up ' +
    'to each sheep, shears it, and picks up the wool. The sheep stay alive (wool grows back). Never touches babies, named, ' +
    'tamed, saddled, or ridden sheep, and skips one that is sheared already. Result: sheared, wool by colour, skipped ' +
    'by reason. Needs shears in the inventory: fails no_shears (they are made of 2 iron ingots; it never crafts them ' +
    'on its own) or no_sheep. Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = shearSheepSchema

  constructor(
    private readonly skill: ShearSheepSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof shearSheepSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Shear sheep',
        run: (ctx) =>
          this.skill.run(
            {
              farm: input.farm,
              area: input.area,
              count: input.count,
              maxDistance: input.max_distance,
              colour: input.colour,
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

const milkCowsSchema = z.object({
  ...farmOrAreaShape,
  count: z.number().int().min(1).max(36).default(1).describe('How many buckets of milk are wanted.'),
  max_distance: z
    .number()
    .min(1)
    .max(64)
    .default(24)
    .describe('Without a farm or area: how far from the bot to look for cows, in blocks.'),
  ...taskOptionsShape,
})

export class MilkCowsTool implements ToolDefinition<typeof milkCowsSchema> {
  readonly name = 'milk_cows'
  readonly description =
    'Fills empty buckets with milk: walks up to an adult cow (a mooshroom counts), in a registered pen or area or within ' +
    'max_distance, and uses a bucket on it. Each cow is milked once per call, so the result can be short of the ' +
    'wanted count (buckets, requested, cows, skipped). Never touches babies, named, tamed, saddled, or ridden cows. ' +
    'Needs an empty bucket per cow: fails no_bucket (3 iron ingots; it never crafts one on its own) or no_cows. ' +
    'Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = milkCowsSchema

  constructor(
    private readonly skill: MilkCowsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof milkCowsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Milk cows for ${String(input.count)} buckets`,
        run: (ctx) =>
          this.skill.run(
            {
              farm: input.farm,
              area: input.area,
              count: input.count,
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

const fertilizeCropsSchema = z.object({
  ...farmOrAreaShape,
  crop: z.string().min(1).optional().describe('Only this crop (wheat, carrots, potatoes, beetroots, pumpkin, melon).'),
  stages: z
    .number()
    .int()
    .min(1)
    .max(7)
    .optional()
    .describe('Grow each plant at most this many stages. Until ripe when omitted.'),
  max_bone_meal: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Use at most this much bone meal, so a big field does not take everything. Everything carried when omitted.'),
  from_storage: z.boolean().default(false).describe('Take bone meal (and bones, with craft) out of registered, unprotected containers first.'),
  craft: z.boolean().default(false).describe('Craft bones into bone meal (1 bone makes 3) when there is not enough.'),
  ...taskOptionsShape,
})

export class FertilizeCropsTool implements ToolDefinition<typeof fertilizeCropsSchema> {
  readonly name = 'fertilize_crops'
  readonly description =
    'Uses bone meal on the unripe crops of a registered field (or group) or an area, nearest first, reading each crop after ' +
    'every use and stopping at ripe (or after stages). Only when the player asked for it. A stem crop (pumpkin, melon) ' +
    'grows its stem only; ripe crops and protected cells that are not the field\'s own are skipped. Result: applied ' +
    '(bone meal used), ripened, skipped by reason, boneMealLeft. Bone meal comes from the bag, then storage ' +
    '(from_storage) and crafting from bones (craft); fails missing_bone_meal and says how much is needed. It never ' +
    'breaks skeleton bones or hunts for them. Runs in the background: poll get_task_status when the reply has ' +
    'status "running".'
  readonly inputSchema = fertilizeCropsSchema

  constructor(
    private readonly skill: FertilizeCropsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof fertilizeCropsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Fertilize crops',
        run: (ctx) =>
          this.skill.run(
            {
              farm: input.farm,
              area: input.area,
              crop: input.crop,
              stages: input.stages,
              maxBoneMeal: input.max_bone_meal,
              sources: { fromStorage: input.from_storage, craft: input.craft },
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

const useComposterSchema = z.object({
  at: positionSchema.optional().describe('The composter block. The nearest within 32 blocks when omitted.'),
  items: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe('What to put in, by item name. Seeds, saplings, leaves, grass, and kelp in the bag when omitted (never food or tools unless named).'),
  collect: z.boolean().default(true).describe('Take the bone meal out when the composter is ready.'),
  ...taskOptionsShape,
})

export class UseComposterTool implements ToolDefinition<typeof useComposterSchema> {
  readonly name = 'use_composter'
  readonly description =
    'Puts scraps into a composter one at a time, reading its level, until it is full; waits for it to turn ready and, ' +
    'with collect, takes the bone meal out and picks it up. Result: composted (items by name), boneMeal, level (8 is ' +
    'ready), composter. Never breaks the composter and never builds one (7 planks or logs; place it with build or ' +
    'place_block). Fails no_composter, not_compostable, nothing_to_compost, or protected_area. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = useComposterSchema

  constructor(
    private readonly skill: UseComposterSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof useComposterSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Use a composter',
        run: (ctx) =>
          this.skill.run({ at: input.at, items: input.items, collect: input.collect }, ctx),
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

const plantTreesSchema = z.object({
  species: z
    .enum(TREE_NAMES)
    .optional()
    .describe(`Which tree: ${TREE_NAMES.join(', ')}. Left out when refilling a grove (its own species is used).`),
  count: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('How many trees to plant. Leave out, with farm set to a grove, to refill its empty spots.'),
  farm: z.string().min(1).optional().describe('A grove to plant into or refill (see list_farms).'),
  area: boundsSchema
    .optional()
    .describe('Two opposite corners of the plot to plant in; y is the ground level (the surface is found near it).'),
  around: z
    .object({
      from: positionSchema.describe('One corner of the thing to plant around, or a single point.'),
      to: positionSchema.optional().describe('The opposite corner, for a building; omit for a point.'),
      distance: z.number().int().min(0).max(32).optional().describe('How far from it the ring starts (default 6).'),
      depth: z.number().int().min(1).max(32).optional().describe('How wide the ring is (default 6).'),
    })
    .optional()
    .describe('Plant in a ring around a house or a point instead of in a rectangle.'),
  spacing: z
    .number()
    .int()
    .min(2)
    .max(16)
    .optional()
    .describe("Least distance between two trees, overriding the species' own (about 4)."),
  big: z
    .boolean()
    .optional()
    .describe('Plant the 2x2 variant, four saplings per tree: spruce and jungle only grow big this way; dark oak always does.'),
  preview: z.boolean().default(false).describe('Only report where the trees would go; place nothing.'),
  label: z.string().min(1).max(40).optional().describe('A name for the new grove, for example "oak wood".'),
  group: z.string().min(1).max(40).optional().describe('Ties the grove together with other farm components.'),
  ...taskOptionsShape,
})

export class PlantTreesTool implements ToolDefinition<typeof plantTreesSchema> {
  readonly name = 'plant_trees'
  readonly description =
    'Plants tree saplings from the inventory at spots that suit the species: dirt-type ground, the free space above ' +
    'it the tree needs, spread out by its spacing, clear of other farms, protected areas, doors, paths, and ' +
    'existing trees. Give an area (rectangle), a farm, or around (a ring around a house or point), and a count. ' +
    'Set preview to see the spots first. The result is remembered as a grove (list_farms; a rectangle is also ' +
    'protected from other tasks). With farm set to a grove and no count it refills the spots where a tree is gone. ' +
    'It never goes looking for saplings: fails no_saplings, or reports saplingsMissing, when the bot lacks them ' +
    '(collect_saplings, or withdraw_items). Runs in the background: poll get_task_status when the reply has ' +
    'status "running".'
  readonly inputSchema = plantTreesSchema

  constructor(
    private readonly skill: PlantTreesSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof plantTreesSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Plant ${input.count === undefined ? '' : `${String(input.count)} `}${input.species ?? 'trees'}`,
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              species: input.species,
              count: input.count,
              farm: input.farm,
              area: input.area,
              around:
                input.around === undefined
                  ? undefined
                  : {
                      from: input.around.from,
                      to: input.around.to,
                      distance: input.around.distance,
                      depth: input.around.depth,
                    },
              spacing: input.spacing,
              big: input.big,
              preview: input.preview,
              label: input.label,
              group: input.group,
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

const collectSaplingsSchema = z.object({
  species: z
    .enum(TREE_NAMES)
    .optional()
    .describe(`Which tree's saplings: ${TREE_NAMES.join(', ')}. Any species when left out.`),
  count: z.number().int().min(1).max(64).describe('How many saplings to get (not counting ones already carried).'),
  max_leaves: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Most leaves to break before giving up. Defaults to 40 per sapling wanted.'),
  max_distance: z.number().min(1).max(64).default(32).describe('How far to look for leaves, in blocks (1-64).'),
  on_inventory_full: z
    .enum(INVENTORY_FULL_KINDS)
    .optional()
    .describe('What to do when the inventory fills up. Defaults to the standing set_storage_policy.'),
  ...taskOptionsShape,
})

export class CollectSaplingsTool implements ToolDefinition<typeof collectSaplingsSchema> {
  readonly name = 'collect_saplings'
  readonly description =
    'Gets tree saplings by breaking leaves by hand (a leaf drops one about 1 time in 20, jungle 1 in 40, so it takes ' +
    'many leaves) and by picking up saplings already lying nearby. Only on request, never on its own. Never uses ' +
    'shears. Needs trees with leaves within max_distance; the same limits as collect_block apply (protected areas, ' +
    'lava, no tunnelling). Stops when it has count saplings, has broken max_leaves leaves (leaf_budget), or finds ' +
    'no more (no_leaves); the message says how many it got. To also get saplings while gathering wood, use ' +
    'collect_block with saplings. Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = collectSaplingsSchema

  constructor(
    private readonly skill: CollectSaplingsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof collectSaplingsSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Collect ${String(input.count)} ${input.species ?? ''} saplings`.replace('  ', ' '),
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              species: input.species,
              count: input.count,
              maxLeaves: input.max_leaves,
              maxDistance: input.max_distance,
              onInventoryFull: input.on_inventory_full,
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

const harvestTreesSchema = z.object({
  ...farmOrAreaShape,
  replant: z.boolean().default(true).describe('Plant a sapling where each tree stood, once the whole tree is down.'),
  max_trees: z.number().int().min(1).optional().describe('Stop after felling this many trees.'),
  reach_tall: z
    .enum(['pillar', 'skip'])
    .default('pillar')
    .describe(
      'What to do with logs too high for the ground: "pillar" (default) climbs a tower of dirt beside the trunk ' +
        '(up to 12 blocks, needs dirt in the inventory) and takes it down again; "skip" leaves the top of the tree.',
    ),
  ...taskOptionsShape,
})

export class HarvestTreesTool implements ToolDefinition<typeof harvestTreesSchema> {
  readonly name = 'harvest_trees'
  readonly description =
    'Fells the grown trees of a grove (or of an area) and, by default, replants each spot with a sapling of the ' +
    'same wood. This is the deliberate way to cut a registered grove: collect_block leaves it alone. It works from ' +
    'the ground and, for a tall tree, climbs a tower of dirt beside the trunk (reach_tall "pillar", the default; up ' +
    'to 12 blocks, it needs dirt and takes the tower down again; it cuts the tree\'s own leaves that stand in the tower\'s column, leavesCut says how many). A tree it cannot finish (no safe spot for the ' +
    'tower, no dirt, too tall) keeps its top: that is reported as left (scaffoldMissing says how much dirt was ' +
    'lacking) and the tree is not replanted. Leaves are left to decay (they drop saplings and apples). Reports what was gained. Runs in the ' +
    'background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = harvestTreesSchema

  constructor(
    private readonly skill: HarvestTreesSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof harvestTreesSchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Harvest trees',
        resume: { tool: this.name, arguments: input },
        run: (ctx) =>
          this.skill.run(
            {
              farm: input.farm,
              area: input.area,
              replant: input.replant,
              maxTrees: input.max_trees,
              reachTall: input.reach_tall,
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

const tendFarmSchema = z.object({
  farm: z.string().min(1).describe('A farm id, label, or group name (see list_farms).'),
  ...taskOptionsShape,
})

export class TendFarmTool implements ToolDefinition<typeof tendFarmSchema> {
  readonly name = 'tend_farm'
  readonly description =
    'One pass over a registered farm, or every component of a group: for a field, harvests what is ripe, ' +
    'replants, and fills empty plots; for a pen with a species and herd_target set, breeds it up or culls the ' +
    'surplus with hunt_animals and collects a chicken pen\'s eggs; for a grove, plants saplings again where a tree ' +
    'is gone (it never fells: that is harvest_trees). A component that fails is reported and skipped; the others ' +
    'carry on. Runs in the ' +
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
    'Read-only: reports a farm or group\'s ripe, growing, and empty plots (for a grove: grown trees, saplings, and ' +
    'empty spots; for a pen: adults and babies; for a pumpkin field: ripe = pumpkins, growing = stems, empty = ' +
    'stem plots with no stem, blocked = free cells with something in the way) and the side of the gate, ' +
    'without touching anything. Call this for ' +
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
  crop: z.string().min(1).optional().describe('The crop it grows, for a field, or the tree species (oak, ...), for a grove.'),
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

const discoverFarmSchema = z.object({
  around: positionSchema
    .optional()
    .describe("The place to look around, for example a player's position. Omit to look around the bot."),
  radius: z
    .number()
    .int()
    .min(4)
    .max(48)
    .default(24)
    .describe('How far to look from that place, in blocks (4-48).'),
  group: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('A group name to put in every proposed registration, for example "home".'),
})

export class DiscoverFarmTool implements ToolDefinition<typeof discoverFarmSchema> {
  readonly name = 'discover_farm'
  readonly description =
    'Read-only: looks around a place for farms the bot was never told about (built by hand) and PROPOSES how to ' +
    'register them; it registers nothing and changes nothing. Fields come from clusters of farmland (the crop from ' +
    'what grows there), pens from fenced areas (the species from the animals inside; an empty fenced area with a gate ' +
    'is a low-confidence proposal). Each proposal carries "register": the exact arguments for register_farm. Tell ' +
    'the player what was found (kind, size, crop or species, notes) and call register_farm only after they agree. ' +
    'Things a registered farm already covers are listed as alreadyRegistered. Groves are not detected. Sees only ' +
    'loaded terrain and animals within view distance.'
  readonly inputSchema = discoverFarmSchema

  constructor(private readonly skill: DiscoverFarmSkill) {}

  async execute(input: z.output<typeof discoverFarmSchema>, context: ToolContext) {
    const result = await this.skill.run(
      { around: input.around, radius: input.radius, group: input.group },
      { signal: context.signal, progress: () => undefined },
    )
    return result.ok ? toolOk(result.value) : toolFail(result.error.message)
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
