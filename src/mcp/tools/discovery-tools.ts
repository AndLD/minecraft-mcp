import { z } from 'zod'
import { STRUCTURE_KINDS } from '../../core/structure-kinds.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { WorldKnowledgeStore } from '../../knowledge/world-knowledge-store.js'
import type { ExploreCavesSkill } from '../../skills/discovery/caves/explore-caves-skill.js'
import type { ExploreForStructureSkill } from '../../skills/discovery/explore-for-structure-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 55

const exploreSchema = z
  .object({
    kind: z.enum(STRUCTURE_KINDS).optional().describe('A structure to look for.'),
    biome: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'A biome to look for, as the player said it: "desert", "cherry grove", "badlands". A general word such as "jungle" or "forest" with no biome of exactly that name covers every biome containing it.',
      ),
    mob: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'A mob type to look for: "fox", "wolf", "polar bear", "villager". Mobs move, so the position is where one stood when seen.',
      ),
    max_distance: z
      .number()
      .int()
      .min(50)
      .max(3000)
      .default(500)
      .describe(
        'How far from where the search starts it may go, in blocks (50-3000, default 500).',
      ),
    max_minutes: z
      .number()
      .min(1)
      .max(60)
      .default(10)
      .describe('How long it may search before giving up, in minutes (1-60, default 10).'),
    strategy: z
      .enum(['guided', 'frontier', 'spiral'])
      .default('guided')
      .describe(
        'guided (default): for a structure whose biomes are known (village, desert_temple, jungle_temple, pillager_outpost) head for the biomes it generates in and away from ones it cannot be in; every other search is frontier. frontier: always head for the nearest ground not yet visited. spiral: circle outward from the start, ring by ring.',
      ),
    use_locate: z
      .boolean()
      .default(false)
      .describe(
        'Ask the server where the nearest one is first (the /locate command). Off by default: the bot explores like a regular player. Turn it on only when the player asks for the server to be used, and it only helps when the bot is allowed to use commands.',
      ),
    only_new: z
      .boolean()
      .default(false)
      .describe(
        'Look for one that is not known yet. By default a known structure of that kind within max_distance is answered at once, without exploring.',
      ),
    return_to: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Name of a landmark (list_landmarks) to walk back to when the search ends, found or not.',
      ),
    ...taskOptionsShape,
  })
  .refine(
    (input) => [input.kind, input.biome, input.mob].filter((v) => v !== undefined).length === 1,
    {
      message: 'Give exactly one of kind (a structure), biome, or mob.',
    },
  )

export class ExploreForStructureTool implements ToolDefinition<typeof exploreSchema> {
  readonly name = 'explore_for_structure'
  readonly description =
    'Searches the Overworld on foot for a structure, a biome, or a mob. Give exactly one of kind, biome, or mob. ' +
    'Biome: "find a desert" walks until the ground it looks at is in that biome, stands in it, and records the place ' +
    '(list_known_structures lists biomes too); found.name is the biome. Mob: "find a fox" walks until one is in view and ' +
    'walks up to it; mobs move and are not saved, and found.detail says how many were in view. Unknown names fail with ' +
    'unknown_biome or unknown_mob and suggestions. Structure (village, desert_temple, jungle_temple, pillager_outpost, mineshaft, ' +
    'ruined_portal, dungeon, stronghold): walks to a spot about 40 blocks away, looks at the loaded blocks and mobs, and ' +
    'repeats until it sees one, then answers with its coordinates and records it (list_known_structures shows it, also ' +
    'after a restart). Other structures seen on the way are recorded too and listed under discovered. A known one within ' +
    'max_distance is answered immediately (only_new: true looks for another). By default it searches on foot like a regular player; ' +
    'with use_locate: true and a server that lets the bot use /locate, the server names the place first and the bot walks there. It stays within max_distance of where it started and ' +
    'within max_minutes, goes round water and lava, and survival reflexes stay active. found.source is "scan" (seen by ' +
    'the bot) or "locate" (named by the server; reached false when it was beyond max_distance or unreachable). ' +
    'Fails with not_found (the detail says why it stopped and what was seen), stuck (five trips in a row failed), ' +
    'unknown_landmark, bad_target, wrong_dimension (Overworld only), no_world_profile, or aborted. Long searches continue in the ' +
    'background: poll get_task_status. Only one task runs at a time; pass replace=true to interrupt the current one.'
  readonly inputSchema = exploreSchema

  constructor(
    private readonly skill: ExploreForStructureSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof exploreSchema>, context: ToolContext) {
    const { wait_seconds: _wait, replace: _replace, ...resume } = input
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Explore for a ${input.kind ?? input.biome ?? input.mob ?? 'target'}`,
        resume: { tool: this.name, arguments: resume },
        run: (ctx) =>
          this.skill.run(
            {
              kind: input.kind,
              biome: input.biome,
              mob: input.mob,
              maxDistance: input.max_distance,
              maxMinutes: input.max_minutes,
              strategy: input.strategy,
              useLocate: input.use_locate,
              onlyNew: input.only_new,
              returnTo: input.return_to,
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

const listStructuresSchema = z.object({
  kind: z.enum(STRUCTURE_KINDS).optional().describe('Only this kind. Omit for all.'),
})

export class ListKnownStructuresTool implements ToolDefinition<typeof listStructuresSchema> {
  readonly name = 'list_known_structures'
  readonly description =
    'Lists the structures found in this world (village, temple, mineshaft, ...) with coordinates, nearest first to the ' +
    'bot when it is in the world. source "scan" means the bot saw it; "locate" means the server named the place and the ' +
    'bot has not seen it. Saved per world, so it survives a restart. Use explore_for_structure to find more.'
  readonly inputSchema = listStructuresSchema

  constructor(
    private readonly knowledge: WorldKnowledgeStore,
    private readonly vitals: VitalsReader,
  ) {}

  execute(input: z.output<typeof listStructuresSchema>) {
    const here = this.vitals.read()?.position
    const structures = this.knowledge
      .structures(input.kind)
      .map((entry) => ({
        ...entry,
        distance:
          here === undefined
            ? undefined
            : Math.round(Math.hypot(entry.x - here.x, entry.z - here.z)),
      }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    const biomes = input.kind === undefined ? this.knowledge.biomes() : []
    return toolOk({
      count: structures.length,
      structures,
      biomes,
      finds: input.kind === undefined ? this.knowledge.finds() : [],
    })
  }
}

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)

const setLandmarkSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .describe(
        'The name, for example "home" or "base". A second landmark with the same name replaces the first.',
      ),
    x: coordinate('X').optional(),
    y: coordinate('Y').optional(),
    z: coordinate('Z').optional(),
    note: z.string().max(200).optional().describe('Anything worth remembering about the place.'),
  })
  .refine((input) => [input.x, input.y, input.z].filter((v) => v !== undefined).length % 3 === 0, {
    message: 'Give x, y, and z together, or none of them to name where the bot stands.',
  })

export class SetLandmarkTool implements ToolDefinition<typeof setLandmarkSchema> {
  readonly name = 'set_landmark'
  readonly description =
    'Names a place in this world so the bot and the player can go back to it ("home", "the iron mine"). Give x, y, z, ' +
    'or leave them out to name the spot where the bot stands. Saved per world. explore_for_structure can walk back to a ' +
    'landmark when it ends (return_to), and goto works with its coordinates.'
  readonly inputSchema = setLandmarkSchema

  constructor(
    private readonly knowledge: WorldKnowledgeStore,
    private readonly vitals: VitalsReader,
  ) {}

  execute(input: z.output<typeof setLandmarkSchema>) {
    const here = this.vitals.read()?.position
    const place =
      input.x !== undefined && input.y !== undefined && input.z !== undefined
        ? { x: input.x, y: input.y, z: input.z }
        : here
    if (place === undefined)
      return toolFail('The bot is not in a world: give x, y, and z to name a place.')
    const set = this.knowledge.setLandmark(input.name, place, input.note)
    return set.ok ? toolOk({ landmark: set.value }) : toolFail(set.error)
  }
}

export class ListLandmarksTool implements ToolDefinition<z.ZodObject<Record<string, never>>> {
  readonly name = 'list_landmarks'
  readonly description =
    'Lists the named places (landmarks) of this world with their coordinates and notes.'
  readonly inputSchema = z.object({})

  constructor(private readonly knowledge: WorldKnowledgeStore) {}

  execute() {
    const landmarks = this.knowledge.landmarks()
    return toolOk({ count: landmarks.length, landmarks })
  }
}

const removeLandmarkSchema = z.object({
  name: z.string().trim().min(1).describe('The landmark to forget (see list_landmarks).'),
})

export class RemoveLandmarkTool implements ToolDefinition<typeof removeLandmarkSchema> {
  readonly name = 'remove_landmark'
  readonly description =
    'Forgets a landmark by name. Only when the player asks; it changes nothing in the world.'
  readonly inputSchema = removeLandmarkSchema

  constructor(private readonly knowledge: WorldKnowledgeStore) {}

  execute(input: z.output<typeof removeLandmarkSchema>) {
    return this.knowledge.removeLandmark(input.name)
      ? toolOk({ removed: input.name })
      : toolFail(`There is no landmark called "${input.name}".`)
  }
}

const cavesSchema = z.object({
  find: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe(
      'What to look for: exact block names ("diamond_ore", "iron_ore"; the deepslate kind is included), "ores" for every ore, or leave out for the valuable ones (diamond, gold, redstone, lapis, emerald, ancient debris). Spawners, geodes, and structures (mineshaft, dungeon, stronghold, ancient city) are always reported.',
    ),
  mine: z
    .boolean()
    .default(false)
    .describe(
      'Dig out the wanted ore veins it passes, under the same lava, water, and falling-block rules as excavate. Default false: only report them. Set it only when the player asked for the ore.',
    ),
  max_distance: z
    .number()
    .int()
    .min(10)
    .max(300)
    .default(80)
    .describe('How far from the cave mouth it may go, in blocks (10-300, default 80).'),
  max_minutes: z
    .number()
    .min(1)
    .max(60)
    .default(10)
    .describe('How long it may explore, in minutes (1-60, default 10).'),
  min_light: z
    .number()
    .int()
    .min(1)
    .max(14)
    .default(5)
    .describe(
      'A torch goes where the block light is below this (1-14, default 5), with at least 6 blocks between torches.',
    ),
  restock: z
    .boolean()
    .default(true)
    .describe(
      'Fetch torches from storage (registered, unprotected containers) before going in when fewer than 8 are carried, and again after walking out when they run out; coal or charcoal and sticks from storage are crafted into torches when there are no torches. false: use only what is carried.',
    ),
  ...taskOptionsShape,
})

export class ExploreCavesTool implements ToolDefinition<typeof cavesSchema> {
  readonly name = 'explore_caves'
  readonly description =
    "Explores a cave or ravine on foot: from the bot's spot (or the nearest cave mouth within 40 blocks) it goes to the " +
    'nearest part it has not seen, lights dark spots with torches (right-hand side going in, so the way out is lit; ' +
    'torches are taken from storage when the bot carries fewer than 8, and crafted from coal or charcoal and sticks), reports ores, spawners, geodes, and structures as it sees ' +
    'them (only ones with an open face: it does not see through rock), saves them (list_known_structures shows finds), and ' +
    'walks back out. It stays away from lava and water, never plans a drop over 3 blocks, and keeps away from an ancient ' +
    'city (reported, never entered). Reflexes stay active. It ends with stopped: explored (nothing new within ' +
    'max_distance), time, low_health, hungry, no_torches (none left, none craftable, and none in storage: tell the player and say what storage was used), warden, or ' +
    'stuck. The result lists finds, structures, mined (with mine: true), skipped veins (hazard, protected, no_tool: ' +
    'name the pickaxe to craft), torchesPlaced, restocked (torches fetched from storage, and in how many trips), and returned. Fails with no_cave, bad_find, wrong_dimension (Overworld ' +
    'only), or aborted. Long trips continue in the background: poll get_task_status. Only one task runs at a time; pass ' +
    'replace=true to interrupt the current one.'
  readonly inputSchema = cavesSchema

  constructor(
    private readonly skill: ExploreCavesSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof cavesSchema>, context: ToolContext) {
    const { wait_seconds: _wait, replace: _replace, ...resume } = input
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: 'Explore a cave',
        resume: { tool: this.name, arguments: resume },
        run: (ctx) =>
          this.skill.run(
            {
              find: input.find,
              mine: input.mine,
              maxDistance: input.max_distance,
              maxMinutes: input.max_minutes,
              minLight: input.min_light,
              restock: input.restock,
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
