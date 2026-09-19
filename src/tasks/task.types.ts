import type { SkillContext, SkillFailure } from '../core/skill.types.js'
import type { Result } from '../core/result.js'

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskSpec {
  /** Short machine-friendly name, for example `goto`. */
  readonly name: string
  /** One line for humans, for example `Go to 10, 64, -5`. */
  readonly description: string
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
  /** Epoch milliseconds. */
  readonly startedAt: number
  readonly finishedAt: number | undefined
}
