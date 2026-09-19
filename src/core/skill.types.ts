import type { Result } from './result.js'

export interface SkillContext {
  /** Aborted when the task is cancelled. Skills must check it between steps and inside loops. */
  readonly signal: AbortSignal
  /** Short human-readable progress, shown by get_task_status. */
  progress(message: string): void
}

export interface SkillFailure {
  /** A stable, machine-friendly reason, for example `unreachable` or `block_not_found`. */
  readonly reason: string
  readonly message: string
}

export type SkillResult<T> = Result<T, SkillFailure>

/** A unit of bot behavior. Expected failures are returned, never thrown. */
export interface Skill<In, Out> {
  readonly name: string
  run(input: In, context: SkillContext): Promise<SkillResult<Out>>
}
