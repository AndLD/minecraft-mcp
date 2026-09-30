import { z } from 'zod'
import type { SmeltItemsSkill } from '../../skills/smelting/smelt-items-skill.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const DEFAULT_WAIT_SECONDS = 30

const schema = z.object({
  item: z
    .string()
    .min(1)
    .optional()
    .describe(
      'What to smelt or cook, for example "raw_iron", "sand", "beef", or "cobblestone". Required unless `collect` is true.',
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(2304)
    .optional()
    .describe('How many to smelt. Everything carried when omitted.'),
  fuel: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Fuel item to burn (for example "coal"). Chosen automatically when omitted: charcoal, coal, sticks, planks, then logs. ' +
        'Coal blocks, blaze rods, and lava buckets are only used when named here.',
    ),
  wait: z
    .enum(['until_done', 'start_only'])
    .default('until_done')
    .describe(
      '"until_done" (default) waits until everything is smelted and collected. "start_only" loads the furnace and returns at once; ' +
        'the job stays in the furnace and is collected by a later smelt (same item) or smelt with collect.',
    ),
  station: z
    .enum(['auto', 'furnace', 'blast_furnace', 'smoker', 'campfire'])
    .default('auto')
    .describe(
      'Which block smelts it. "auto" (default): a blast furnace (ores and raw metals) or a smoker (food) that stands nearby or is carried when it can smelt the item, a furnace otherwise. A blast furnace or smoker is twice as fast and the same fuel lasts twice as long. A campfire (station: campfire, or auto for food when the bag has no fuel or the batch is 8 or fewer) needs no fuel: it cooks four raw items at a time, 30 seconds each, and the food pops out beside the fire (the bot picks it up); wait and collect do not apply to it. Naming one that is not there fails no_blast_furnace, no_smoker, or no_campfire (it is not crafted); naming one that cannot smelt the item fails wrong_station.',
    ),
  fuel_from_storage: z
    .boolean()
    .default(false)
    .describe(
      'When the fuel in the bag does not cover the job, take charcoal or coal (or the named fuel) out of registered, unprotected containers first. Off by default: only what the bot carries is used.',
    ),
  collect: z
    .boolean()
    .default(false)
    .describe(
      'Take what a waiting job (see smeltJobs in the session briefing) has finished, and go on with it. `item` may be omitted.',
    ),
  ...taskOptionsShape,
})

export class SmeltTool implements ToolDefinition<typeof schema> {
  readonly name = 'smelt'
  readonly description =
    'Smelts or cooks items in a furnace: uses a nearby furnace, or one from the inventory placed next to the bot (crafted from ' +
    '8 cobblestone when there is none), loads fuel and items, waits (10 seconds per item), and collects the output. It runs in ' +
    'the background: poll get_task_status when the reply has status "running". While the items cook the bot does not stand ' +
    'looking into the furnace: it closes the window and looks again after a while, so a chat message or a new task can come ' +
    'in (cancel_task or replace: true). A wait that is cut short leaves the furnace burning and remembers the job: call smelt ' +
    'again with the same item, or with collect: true, to take the result. `wait: start_only` loads and returns at once; a job ' +
    'left in a furnace announces itself with a smelt_ready event (in wait_for_chat) when it should be done, so the bot can do ' +
    'other work meanwhile. Fuel of every kind in the bag is used: more is put in at each look, so a big job is not cut to the ' +
    'first load (fuelUsed says what was burned); with fuel_from_storage: true the fuel the bag lacks is taken out of storage first ' +
    '(fuelFetched says what). A blast furnace or smoker that stands nearby is used for ores and food by itself (station: auto): ' +
    'twice as fast, and the fuel goes twice as far. When a ' +
    'job ends any other way, whatever is left in the furnace goes back to the inventory. Fails with not_smeltable, wrong_station, no_blast_furnace, no_smoker, no_campfire, campfire_out, campfire_full, protected_area, ' +
    'missing_items, no_fuel, no_furnace, no_pending_job, furnace_busy, timeout, or out_of_fuel; the message says how many ' +
    'were done. The result has `pending` (items still in the furnace) and `furnace`.'
  readonly inputSchema = schema

  constructor(
    private readonly skill: SmeltItemsSkill,
    private readonly launcher: TaskLauncher,
  ) {}

  execute(input: z.output<typeof schema>, context: ToolContext) {
    if (!input.collect && input.item === undefined)
      return toolFail('Say what to smelt (item), or set collect: true to take a waiting job.')
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: input.collect
          ? 'Collect a smelting job'
          : `Smelt ${input.count === undefined ? 'all' : String(input.count)} ${input.item ?? ''}`.trim(),
        run: (ctx) =>
          this.skill.run(
            {
              item: input.item ?? '',
              count: input.count,
              fuel: input.fuel,
              wait: input.wait,
              collect: input.collect,
              fuelFromStorage: input.fuel_from_storage,
              station: input.station,
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
