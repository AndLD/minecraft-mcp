import { z } from 'zod'
import type { Clock } from '../../core/clock.port.js'
import type { RecoverDropsSkill } from '../../skills/recovery/recover-drops-skill.js'
import { DROP_DESPAWN_MS, type DropRecord, type DropRecords } from '../../state/drop-records.js'
import type { DropRecoveryPolicy } from '../../state/drop-recovery-policy.js'
import { DROP_RECOVERY_KINDS } from '../../state/drop-recovery-policy.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
import type { TaskManager } from '../../tasks/task-manager.js'
import type { TaskLauncher } from '../task-launcher.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolContext, ToolDefinition } from '../tool.types.js'
import { taskOptionsShape } from './task-schema.js'

const view = (record: DropRecord, now: number) => ({
  id: record.id,
  kind: record.kind,
  status: record.status,
  position: record.position,
  dimension: record.dimension,
  cause: record.cause,
  lost: record.lost,
  recovered: record.recovered,
  attempts: record.attempts,
  note: record.note,
  agoSeconds: Math.round((now - record.at) / 1000),
  /** How long the items still lie there before they vanish. */
  secondsLeft: Math.max(0, Math.round((record.at + DROP_DESPAWN_MS - now) / 1000)),
})

const policySchema = z.object({
  policy: z
    .enum(DROP_RECOVERY_KINDS)
    .describe(
      '"auto": the bot fetches the items back by itself (the default). "skip": it leaves them and only keeps the coordinates.',
    ),
  situation: z
    .enum(['death', 'unclaimed', 'both'])
    .default('both')
    .describe(
      '"death": the bot\'s own items after it died. "unclaimed": items thrown for a player that nobody picked up. "both" (default).',
    ),
})

export class SetDropRecoveryPolicyTool implements ToolDefinition<typeof policySchema> {
  readonly name = 'set_drop_recovery_policy'
  readonly description =
    'Saves whether the bot goes back for its dropped items, as a standing rule for this world: after a death and/or for ' +
    'items it threw for a player that nobody picked up. "auto" is the default; "skip" leaves them where they are (the ' +
    'coordinates stay on record, see list_death_records, and recover_drops fetches them on request). Set "skip" when ' +
    'the player says something like "never go back for your stuff". Even on "auto" the bot asks first when the spot ' +
    'looks dangerous. Survives restarts and shows in the session briefing. Fails when no world is active.'
  readonly inputSchema = policySchema

  constructor(
    private readonly policy: DropRecoveryPolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof policySchema>) {
    const update =
      input.situation === 'both'
        ? { death: input.policy, unclaimed: input.policy }
        : { [input.situation]: input.policy }
    const saved = this.policy.set(update)
    if (!saved.ok) return toolFail(saved.error)
    const skipped = (['death', 'unclaimed'] as const).filter((kind) => saved.value[kind] === 'skip')
    if (skipped.length === 0) this.standing.remove('drop_recovery_policy')
    else
      this.standing.set(
        'drop_recovery_policy',
        `The bot does not go back for dropped items (${skipped.join(' and ')}); it only keeps the coordinates.`,
      )
    return toolOk(saved.value)
  }
}

const skipSchema = z.object({
  record: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A record id from list_death_records. Omit to skip everything that is waiting or running.',
    ),
})

export class SkipDropRecoveryTool implements ToolDefinition<typeof skipSchema> {
  readonly name = 'skip_drop_recovery'
  readonly description =
    'Stops going for dropped items, this time: cancels a running recovery and marks the records as abandoned, keeping ' +
    'their coordinates (returned here, tell the player). Use it when the player says "forget it, do not go for it". ' +
    'Abandoned drops can still be fetched later with recover_drops while they last (5 minutes after the drop). To stop ' +
    'the bot from ever going back, use set_drop_recovery_policy with "skip".'
  readonly inputSchema = skipSchema

  constructor(
    private readonly records: DropRecords,
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
  ) {}

  async execute(input: z.output<typeof skipSchema>) {
    const now = this.clock.now()
    const waiting = new Set(['pending', 'recovering', 'partial'])
    const targets =
      input.record === undefined
        ? this.records.all().filter((record) => waiting.has(record.status))
        : [this.records.get(input.record)].filter((record) => record !== undefined)
    if (targets.length === 0)
      return toolFail(
        input.record === undefined
          ? 'There is no drop recovery waiting or running.'
          : `There is no drop record "${input.record}".`,
      )

    // The task first, so it records what it picked up before the record is marked.
    if (this.tasks.current()?.name === 'recover_drops')
      await this.tasks.cancel(undefined, 'requested')
    const skipped = targets.flatMap((record) => {
      const updated = this.records.update(record.id, {
        status: 'abandoned',
        note: 'Skipped on request.',
      })
      return updated === undefined ? [] : [view(updated, now)]
    })
    return toolOk({ skipped })
  }
}

const recoverSchema = z.object({
  record: z
    .string()
    .min(1)
    .optional()
    .describe(
      'A record id from list_death_records. Defaults to the newest one that can still be fetched.',
    ),
  max_attempts: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2)
    .describe(
      'A record that was tried this many times is not tried again without a higher value here (so a deadly spot cannot cause one death after another). Default 2.',
    ),
  ...taskOptionsShape,
})

export class RecoverDropsTool implements ToolDefinition<typeof recoverSchema> {
  readonly name = 'recover_drops'
  readonly description =
    "Fetches dropped items back: the bot's own inventory where it died, or items it threw for a player that nobody took " +
    '(they vanish 5 minutes after the drop). Normally this happens by itself after a death; use this tool when recovery ' +
    'was skipped or the player asks for it. The bot refuses when it cannot get there in time, looks at the spot for ' +
    'lava, fire, cacti, deep water, the void, and hostile mobs, and then pauses with a needs_decision event (answer ' +
    'with resume_task: "try_carefully" or "abandon"). It never walks into lava or the void. It picks up everything that ' +
    'scattered and puts armor, weapon, and shield on. Result: what was recovered and what is still missing. Fails with ' +
    'no_record, expired, too_far, wrong_dimension, max_attempts, unreachable, nothing_found, inventory_full, or ' +
    'abandoned (the message has the coordinates). Runs in the background: poll get_task_status.'
  readonly inputSchema = recoverSchema

  constructor(
    private readonly skill: RecoverDropsSkill,
    private readonly launcher: TaskLauncher,
    private readonly records: DropRecords,
  ) {}

  execute(input: z.output<typeof recoverSchema>, context: ToolContext) {
    const record =
      input.record === undefined ? this.records.recoverable()[0] : this.records.get(input.record)
    const id = record?.id ?? input.record
    return this.launcher.launch(
      {
        name: this.skill.name,
        description: `Recover dropped items${id === undefined ? '' : ` (${id})`}`,
        ...(id === undefined ? {} : { resume: { tool: this.name, arguments: { record: id } } }),
        run: (ctx) => this.skill.run({ record: id, maxAttempts: input.max_attempts }, ctx),
      },
      { replace: input.replace, waitSeconds: input.wait_seconds ?? 40, signal: context.signal },
    )
  }
}

const listSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10).describe('How many records, newest first.'),
})

export class ListDeathRecordsTool implements ToolDefinition<typeof listSchema> {
  readonly name = 'list_death_records'
  readonly description =
    'Lists where the bot died and where items it dropped for a player lie unclaimed, newest first: coordinates, dimension, ' +
    'cause, what was lost and recovered, status (pending, recovering, recovered, partial, abandoned, expired, gone), ' +
    'attempts, and how many seconds the items still last. Read-only. Use it to tell the player where their things are, ' +
    'or to pick a record for recover_drops.'
  readonly inputSchema = listSchema

  constructor(
    private readonly records: DropRecords,
    private readonly clock: Clock,
  ) {}

  execute(input: z.output<typeof listSchema>) {
    this.records.expireStale()
    const now = this.clock.now()
    const newest = [...this.records.all()].reverse().slice(0, input.limit)
    return toolOk({ records: newest.map((record) => view(record, now)) })
  }
}
