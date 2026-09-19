import { z } from 'zod'
import type { Clock } from '../../core/clock.port.js'
import type { TaskManager } from '../../tasks/task-manager.js'
import { taskView } from '../task-view.js'
import { toolFail, toolOk } from '../tool-result.js'
import type { ToolDefinition } from '../tool.types.js'

const idSchema = z.object({
  task_id: z
    .string()
    .min(1)
    .optional()
    .describe('Task id such as "task-3". Defaults to the current or latest task.'),
})

export class GetTaskStatusTool implements ToolDefinition<typeof idSchema> {
  readonly name = 'get_task_status'
  readonly description =
    'Reports a task: its status (running, succeeded, failed, cancelled), latest progress message, result or failure ' +
    'reason, and elapsed time. Without an id it reports the running task, or the most recent one. Use it to follow up ' +
    'on a tool that answered with status "running".'
  readonly inputSchema = idSchema

  constructor(
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
  ) {}

  execute(input: z.output<typeof idSchema>) {
    const snapshot =
      input.task_id === undefined
        ? (this.tasks.current() ?? this.tasks.latest())
        : this.tasks.get(input.task_id)
    if (snapshot === undefined) {
      return input.task_id === undefined
        ? toolOk({ task: null })
        : toolFail(`Unknown task: ${input.task_id}`)
    }
    return toolOk({ task: taskView(snapshot, this.clock) })
  }
}

export class CancelTaskTool implements ToolDefinition<typeof idSchema> {
  readonly name = 'cancel_task'
  readonly description =
    'Cancels a task (default: the running one) and waits until the bot has stopped. Safe to call when nothing is running.'
  readonly inputSchema = idSchema

  constructor(
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
  ) {}

  async execute(input: z.output<typeof idSchema>) {
    if (input.task_id !== undefined && this.tasks.get(input.task_id) === undefined) {
      return toolFail(`Unknown task: ${input.task_id}`)
    }
    const snapshot = await this.tasks.cancel(input.task_id)
    return toolOk({ task: snapshot === undefined ? null : taskView(snapshot, this.clock) })
  }
}

const emptySchema = z.object({})

export class StopTool implements ToolDefinition<typeof emptySchema> {
  readonly name = 'stop'
  readonly description =
    'Immediately stops whatever the bot is doing (cancels the running task and halts movement). Safe to call at any time.'
  readonly inputSchema = emptySchema

  constructor(
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
  ) {}

  async execute() {
    const snapshot = await this.tasks.cancel()
    return toolOk({
      stopped: snapshot !== undefined,
      task: snapshot === undefined ? null : taskView(snapshot, this.clock),
    })
  }
}
