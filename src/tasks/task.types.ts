import type { DecisionPrompt, SkillContext, SkillFailure } from '../core/skill.types.js'
import type { Result } from '../core/result.js'

export type TaskStatus = 'running' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled'

/**
 * Why a task was cancelled. `requested` (the owner or agent asked) and `replaced` are deliberate stops;
 * `preempted` means a survival reflex took over and the task may be resumed afterwards; `died` means the bot died.
 */
export type CancelReason =
  'requested' | 'replaced' | 'preempted' | 'disconnected' | 'shutdown' | 'died'

/** How to start the same task again: the tool and the arguments that launched it. */
export interface ResumeDescriptor {
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
}

export interface TaskSpec {
  /** Short machine-friendly name, for example `goto`. */
  readonly name: string
  /** One line for humans, for example `Go to 10, 64, -5`. */
  readonly description: string
  /** Lets an interrupted task be offered for resuming after a relaunch. */
  readonly resume?: ResumeDescriptor
  run(context: SkillContext): Promise<Result<unknown, SkillFailure>>
}

export interface TaskSnapshot {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly status: TaskStatus
  /** The latest progress message, if any. */
  readonly progress: string | undefined
  readonly result: unknown
  readonly failure: SkillFailure | undefined
  /** Set when the status is `cancelled`. */
  readonly cancelReason: CancelReason | undefined
  readonly resume: ResumeDescriptor | undefined
  /** The question the task is waiting on; set while the status is `waiting_for_input`. */
  readonly pending: DecisionPrompt | undefined
  /** Epoch milliseconds. */
  readonly startedAt: number
  readonly finishedAt: number | undefined
}

export interface TaskEvent {
  readonly type: 'started' | 'progress' | 'waiting' | 'finished'
  readonly snapshot: TaskSnapshot
}
