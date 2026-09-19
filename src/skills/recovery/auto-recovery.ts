import type { Result } from '../../core/result.js'
import type { Scheduler } from '../../core/scheduler.port.js'
import type { SkillFailure } from '../../core/skill.types.js'
import type { TaskEvent, TaskSnapshot, TaskSpec } from '../../tasks/task.types.js'
import type { DropRecords } from '../../state/drop-records.js'
import { describeBrief } from './item-counts.js'
import type { ItemRecoverer, RecoverOutput } from './recover-drops-skill.js'

/** The part of the task manager that starting and watching a recovery needs. */
export interface RecoveryTasks {
  start(spec: TaskSpec): Result<TaskSnapshot>
  onEvent(listener: (event: TaskEvent) => void): () => void
}

export interface AutoRecoveryDeps {
  readonly tasks: RecoveryTasks
  readonly recoverer: ItemRecoverer
  readonly records: DropRecords
  /** Names a survival reflex that is acting right now, which keeps tasks from starting. */
  readonly activeReflex: () => string | undefined
  /** Puts an event into the agent's inbox. */
  emit(type: string, message: string): void
  /** Says something in the game chat. */
  say(text: string): void
  readonly scheduler: Scheduler
  readonly maxAttempts: number
  /** How long to wait before trying to start again when the bot is busy. */
  readonly retryDelayMs: number
  readonly maxTries: number
}

const CHAT_LIMIT = 240

/**
 * Starts a recovery on its own (after a death, or for unclaimed items) and tells the player how it went. Waits for
 * the bot to be free when a task or a reflex is busy, for a while, and gives up quietly when the record is no
 * longer waiting to be recovered (the player said to skip it).
 */
export class AutoRecovery {
  constructor(private readonly deps: AutoRecoveryDeps) {}

  async start(recordId: string): Promise<void> {
    const { deps } = this
    for (let attempt = 0; attempt < deps.maxTries; attempt += 1) {
      if (deps.records.get(recordId)?.status !== 'pending') return
      const busy = deps.activeReflex()
      if (busy === undefined) {
        const started = deps.tasks.start({
          name: 'recover_drops',
          description: `Recover dropped items (${recordId})`,
          resume: { tool: 'recover_drops', arguments: { record: recordId } },
          run: (context) =>
            deps.recoverer.run({ record: recordId, maxAttempts: deps.maxAttempts }, context),
        })
        if (started.ok) {
          this.report(started.value.id)
          return
        }
      }
      await new Promise<void>((resolve) => {
        deps.scheduler.after(deps.retryDelayMs, resolve)
      })
    }
    deps.emit(
      'drop_recovery',
      `The bot stayed busy, so it never started recovering ${recordId}. Ask the player whether to try now (recover_drops).`,
    )
  }

  private report(taskId: string): void {
    const off = this.deps.tasks.onEvent((event) => {
      if (event.type !== 'finished' || event.snapshot.id !== taskId) return
      off()
      const line = this.describe(event.snapshot)
      this.deps.emit('drop_recovery', line)
      this.deps.say(line.slice(0, CHAT_LIMIT))
    })
  }

  private describe(task: TaskSnapshot): string {
    switch (task.status) {
      case 'succeeded': {
        const result = task.result as RecoverOutput
        const rest =
          result.missing.length > 0 ? ` Still missing: ${describeBrief(result.missing)}.` : ''
        return result.status === 'gone'
          ? 'The items I dropped are no longer there (somebody took them, or they despawned).'
          : `Recovered ${describeBrief(result.recovered)} (${result.status}).${rest}`
      }
      case 'failed':
        return `Recovery did not work out: ${(task.failure as SkillFailure).message}`
      default:
        return 'Recovery was cancelled.'
    }
  }
}
