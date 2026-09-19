import type { Result } from './result.js'

/** A question a task cannot answer itself: it waits (`waiting_for_input`) until the agent relays the player's answer. */
export interface DecisionPrompt {
  /** What happened and what is being asked, written for the agent to relay. */
  readonly message: string
  /** The answers `resume_task` accepts. */
  readonly options: readonly string[]
}

export interface SkillContext {
  /** Aborted when the task is cancelled. Skills must check it between steps and inside loops. */
  readonly signal: AbortSignal
  /** Short human-readable progress, shown by get_task_status. */
  progress(message: string): void
  /**
   * Pauses the task until the player decides. Resolves with one of `prompt.options`, or undefined when the task is
   * cancelled meanwhile. Absent where nobody can answer (tests, direct calls), so callers must cope with that.
   */
  ask?(prompt: DecisionPrompt): Promise<string | undefined>
}

export interface SkillFailure {
  /** A stable, machine-friendly reason, for example `unreachable` or `block_not_found`. */
  readonly reason: string
  readonly message: string
  /** Machine-readable facts for whoever continues the work, for example how much is left to collect. */
  readonly detail?: Readonly<Record<string, unknown>>
}

export type SkillResult<T> = Result<T, SkillFailure>

/** A unit of bot behavior. Expected failures are returned, never thrown. */
export interface Skill<In, Out> {
  readonly name: string
  run(input: In, context: SkillContext): Promise<SkillResult<Out>>
}
