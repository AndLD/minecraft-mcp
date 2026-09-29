import { z } from 'zod'
import { STRUCTURE_KINDS } from '../../core/structure-kinds.js'
import type { VitalsReader } from '../../core/vitals.port.js'
import type { WorldKnowledgeStore } from '../../knowledge/world-knowledge-store.js'
import type { ExploreForStructureSkill } from '../../skills/discovery/explore-for-structure-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 55

const exploreSchema = z.object({
  kind: z.enum(STRUCTURE_KINDS).describe('Which structure to look for.'),
  max_distance: z
    .number()
    .int()
    .min(50)
    .max(3000)
    .default(500)
    .describe('How far from where the search starts it may go, in blocks (50-3000, default 500).'),
  max_minutes: z
    .number()
    .min(1)
    .max(60)
    .default(10)
    .describe('How long it may search before giving up, in minutes (1-60, default 10).'),
  strategy: z
    .enum(['frontier', 'spiral'])
    .default('frontier')
    .describe(
      'frontier (default): always head for the nearest ground not yet visited. spiral: circle outward from the start, ring by ring.',
    ),
  use_locate: z
    .boolean()
    .default(true)
    .describe(
      'Ask the server where the nearest one is first (the /locate command). It only helps when the bot is allowed to use it; otherwise the bot searches on foot.',
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

export class ExploreForStructureTool implements ToolDefinition<typeof exploreSchema> {
  readonly name = 'explore_for_structure'
  readonly description =
    'Searches the Overworld on foot for a structure (village, desert_temple, jungle_temple, pillager_outpost, mineshaft, ' +
    'ruined_portal, dungeon, stronghold): walks to a spot about 40 blocks away, looks at the loaded blocks and mobs, and ' +
    'repeats until it sees one, then answers with its coordinates and records it (list_known_structures shows it, also ' +
    'after a restart). Other structures seen on the way are recorded too and listed under discovered. A known one within ' +
    'max_distance is answered immediately (only_new: true looks for another). When the server lets the bot use /locate ' +
    'the server names the place first and the bot walks there. It stays within max_distance of where it started and ' +
    'within max_minutes, goes round water and lava, and survival reflexes stay active. found.source is "scan" (seen by ' +
    'the bot) or "locate" (named by the server; reached false when it was beyond max_distance or unreachable). ' +
    'Fails with not_found (the detail says why it stopped and what was seen), stuck (five trips in a row failed), ' +
    'unknown_landmark, wrong_dimension (Overworld only), no_world_profile, or aborted. Long searches continue in the ' +
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
        description: `Explore for a ${input.kind}`,
        resume: { tool: this.name, arguments: resume },
        run: (ctx) =>
          this.skill.run(
            {
              kind: input.kind,
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
    return toolOk({ count: structures.length, structures })
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
