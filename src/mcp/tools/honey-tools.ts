import { z } from 'zod'
import type { HarvestHoneySkill } from '../../skills/farming/harvest-honey-skill.js'
import type { InspectHivesSkill } from '../../skills/farming/inspect-hives-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 50

const coordinate = (what: string) => z.number().int().describe(`${what} block coordinate.`)
const positionSchema = z.object({ x: coordinate('x'), y: coordinate('y'), z: coordinate('z') })

const inspectHivesSchema = z.object({
  farm: z
    .string()
    .min(1)
    .optional()
    .describe(
      'An apiary (a farm id or label, see list_farms). Without it: every hive near the bot.',
    ),
  radius: z
    .number()
    .min(1)
    .max(64)
    .default(32)
    .describe('Without a farm: how far from the bot to look, in blocks.'),
})

export class InspectHivesTool implements ToolDefinition<typeof inspectHivesSchema> {
  readonly name = 'inspect_hives'
  readonly description =
    'Read-only: lists the beehives and bee nests near the bot (or in an apiary) with their honey level (0 to 5; 5 is ' +
    'ready), whether a lit campfire stands below (smoke keeps the bees calm when harvesting), the protected area each ' +
    'lies in, and how many bees fly near it. Wild nests in forests count. It does not say how many bees are inside.'
  readonly inputSchema = inspectHivesSchema

  constructor(private readonly skill: InspectHivesSkill) {}

  async execute(input: z.output<typeof inspectHivesSchema>, context: ToolContext) {
    const result = await this.skill.run(
      { farm: input.farm, radius: input.radius },
      { signal: context.signal, progress: () => undefined },
    )
    return result.ok ? toolOk(result.value) : toolFail(result.error.message)
  }
}

const harvestHoneySchema = z.object({
  what: z
    .enum(['honey', 'honeycomb'])
    .default('honey')
    .describe(
      '"honey": a glass bottle per hive gives a honey bottle. "honeycomb": shears give 3 honeycomb per hive. One of them per hive per round: either resets the honey level to 0.',
    ),
  farm: z.string().min(1).optional().describe('An apiary (a farm id or label).'),
  at: positionSchema.optional().describe('One hive, by its position.'),
  radius: z
    .number()
    .min(1)
    .max(64)
    .default(24)
    .describe('Without a farm or a position: how far from the bot to look.'),
  count: z.number().int().min(1).optional().describe('Harvest at most this many hives.'),
  smoke: z
    .enum(['auto', 'never'])
    .default('auto')
    .describe(
      '"auto" (default): a lit campfire below the hive is used, or one from the bag is placed under it; a hive with no smoke is left and the call fails no_smoke. "never": go without smoke, which ANGERS the bees: only when the player said to.',
    ),
  craft_bottles: z
    .boolean()
    .default(false)
    .describe('Craft glass bottles from glass when the bag has none (3 glass make 3 bottles).'),
  ...taskOptionsShape,
})

export class HarvestHoneyTool implements ToolDefinition<typeof harvestHoneySchema> {
  readonly name = 'harvest_honey'
  readonly description =
    'Takes honey bottles (glass bottle) or honeycomb (shears) from the ripe beehives and bee nests (honey level 5) near the ' +
    'bot, in an apiary, or at one position. It smokes each hive first: a lit campfire below the hive keeps the bees calm, ' +
    'so it uses one that stands there or places one from the bag (never crafted); with no smoke the hive is left and the ' +
    "call fails no_smoke, naming what to do. smoke: never harvests anyway and angers the bees: only on the player's own " +
    "words. Stops with bees_angry at the first angry bee. Skips hives in protected areas that are not the apiary's own. " +
    'Result: honeyBottles, honeycomb, hives, skipped by reason, campfiresPlaced. Fails no_bottles, no_shears, no_smoke, ' +
    'no_hive, or bees_angry. Runs in the background: poll get_task_status when the reply has status "running".'
  readonly inputSchema = harvestHoneySchema

  constructor(
    private readonly skill: HarvestHoneySkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof harvestHoneySchema>, context: ToolContext) {
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: input.what === 'honey' ? 'Harvest honey' : 'Harvest honeycomb',
        run: (ctx) =>
          this.skill.run(
            {
              what: input.what,
              farm: input.farm,
              at: input.at,
              radius: input.radius,
              count: input.count,
              smoke: input.smoke,
              craftBottles: input.craft_bottles,
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
