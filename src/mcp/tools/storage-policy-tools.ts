import { z } from 'zod'
import { INVENTORY_FULL_KINDS, type StoragePolicy } from '../../state/storage-policy.js'
import type { StandingInstructions } from '../../state/standing-instructions.js'
import type { Clock } from '../../core/clock.port.js'
import type { TaskManager } from '../../tasks/task-manager.js'
import { taskView } from '../task-view.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const policySchema = z.object({
  policy: z
    .enum(INVENTORY_FULL_KINDS)
    .describe(
      '"ask": the task pauses and you ask the player (the default). "offload_and_return": the bot takes things to the chests by the storage rules and comes back, without asking. "stop": end the task with what it has.',
    ),
  max_trips: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('At most this many offload trips per task (default 20).'),
  max_distance: z
    .number()
    .min(1)
    .max(256)
    .optional()
    .describe(
      'Containers without a matching rule are only used within this many blocks (default 64).',
    ),
})

const STANDING_TEXT: Record<'offload_and_return' | 'stop', string> = {
  offload_and_return:
    'When the inventory is full during a task, the bot takes things to the chests by the storage rules and returns to the task, without asking.',
  stop: 'When the inventory is full during a task, the bot ends the task with what it has.',
}

export class SetStoragePolicyTool implements ToolDefinition<typeof policySchema> {
  readonly name = 'set_storage_policy'
  readonly description =
    'Saves what tasks do when the inventory is full, as a standing rule for this world: "ask" (default), ' +
    '"offload_and_return" (deposit into containers by the storage rules and come back, no questions), or "stop". Set it ' +
    'when the player says something like "bring resources to the home chest whenever there is no space". A single call ' +
    'can also choose with its own on_inventory_full. Shown in the session briefing. Fails when no world is active.'
  readonly inputSchema = policySchema

  constructor(
    private readonly policy: StoragePolicy,
    private readonly standing: StandingInstructions,
  ) {}

  execute(input: z.output<typeof policySchema>) {
    const saved = this.policy.set({
      kind: input.policy,
      ...(input.max_trips === undefined ? {} : { maxTrips: input.max_trips }),
      ...(input.max_distance === undefined ? {} : { maxDistance: input.max_distance }),
    })
    if (!saved.ok) return toolFail(saved.error)
    // Mirrored as a standing instruction so the session briefing shows it.
    if (input.policy === 'ask') this.standing.remove('inventory_full')
    else this.standing.set('inventory_full', STANDING_TEXT[input.policy])
    return toolOk({ policy: saved.value })
  }
}

const resumeSchema = z.object({
  decision: z
    .string()
    .min(1)
    .describe(
      'The player\'s answer: one of the options the waiting task offered (see waitingFor in get_task_status), for a full inventory "offload", "continue", or "stop".',
    ),
  task_id: z.string().min(1).optional().describe('The waiting task. Defaults to the current one.'),
})

export class ResumeTaskTool implements ToolDefinition<typeof resumeSchema> {
  readonly name = 'resume_task'
  readonly description =
    'Gives a task that is waiting for a decision (status "waiting_for_input"; a needs_decision event told you) the ' +
    "player's answer, and lets it carry on. Ask the player in chat first. Fails when no task is waiting or the answer is " +
    'not one of the offered options.'
  readonly inputSchema = resumeSchema

  constructor(
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
  ) {}

  execute(input: z.output<typeof resumeSchema>) {
    const answered = this.tasks.answer(input.decision, input.task_id)
    return answered.ok
      ? toolOk({ task: taskView(answered.value, this.clock) })
      : toolFail(answered.error)
  }
}
