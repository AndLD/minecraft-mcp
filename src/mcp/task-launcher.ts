import type { Clock } from '../core/clock.port.js'
import type { TaskManager } from '../tasks/task-manager.js'
import type { TaskSpec } from '../tasks/task.types.js'
import { taskView } from './task-view.js'
import { toolFail, toolOk } from './tool-result.js'
import type { ToolResult } from './tool.types.js'

export interface LaunchOptions {
  /** Cancel the running task first instead of refusing to start. */
  readonly replace: boolean
  /** How long to wait for the task to finish before answering with `status: running`. */
  readonly waitSeconds: number
  readonly signal: AbortSignal
}

/**
 * Shared by every tool that starts a long task: starts it, waits a bounded time,
 * and answers with either the outcome or "still running, poll get_task_status".
 */
/** Tells whether a survival reflex is acting; tasks must not fight it for control of the bot. */
export interface ReflexGate {
  activeReflex(): string | undefined
}

export class TaskLauncher {
  constructor(
    private readonly tasks: TaskManager,
    private readonly clock: Clock,
    private readonly gate?: ReflexGate,
  ) {}

  async launch(spec: TaskSpec, options: LaunchOptions): Promise<ToolResult> {
    const reflex = this.gate?.activeReflex()
    if (reflex !== undefined) {
      return toolFail(
        `A survival reflex (${reflex}) is acting right now, so the bot cannot start a task. Try again in a few seconds; get_status shows when it is done.`,
      )
    }
    if (options.replace) await this.tasks.cancel(undefined, 'replaced')
    const started = this.tasks.start(spec)
    if (!started.ok) return toolFail(started.error)

    const snapshot =
      (await this.tasks.waitFor(started.value.id, options.waitSeconds * 1000, options.signal)) ??
      started.value
    const view = taskView(snapshot, this.clock)

    switch (snapshot.status) {
      case 'failed':
        return toolFail(
          `${snapshot.failure?.message ?? 'The task failed.'} (reason: ${snapshot.failure?.reason ?? 'unknown'})`,
        )
      case 'cancelled':
        return toolFail('The task was cancelled before it finished.')
      case 'running':
      case 'waiting_for_input':
      case 'succeeded':
        return toolOk(view)
    }
  }
}
