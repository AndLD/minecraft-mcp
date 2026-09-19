import type { EntityInfo } from '../core/entity-scanner.port.js'
import type { Vitals } from '../core/vitals.port.js'

/** What the engine reads once per tick and hands to every reflex. */
export interface ReflexState {
  readonly vitals: Vitals
  /** Entities within the scan radius, nearest first. */
  readonly entities: readonly EntityInfo[]
  /** Epoch milliseconds. */
  readonly now: number
}

export interface ReflexOutcome {
  /** Whether the task that was running before should be resumed now. */
  readonly resumeTask: boolean
}

export interface ReflexContext {
  /** Aborted when a more important reflex takes over, the reflex no longer applies, or the bot leaves the world. */
  readonly signal: AbortSignal
  /** Tells the agent what the bot just did on its own (shown by wait_for_chat). */
  emit(message: string): void
  /** A fresh reading of the bot's state; undefined when it is no longer in a world. */
  state(): ReflexState | undefined
  /** Waits `ms` (or until aborted). Loops that may find nothing to do must await this, never spin. */
  sleep(ms: number): Promise<void>
  /** An abort signal that also fires after `ms`, for one step of a longer routine. Call `dispose` when done. */
  withTimeout(ms: number): { readonly signal: AbortSignal; dispose(): void }
}

/**
 * Survival behavior that runs by itself, with no round trip to the agent. The engine asks `wants` every tick;
 * the most important reflex that wants to act runs until it is done or something more important wants in.
 */
export interface Reflex {
  readonly name: string
  /** Higher wins. */
  readonly priority: number
  /** Whether the running task must stop while this reflex acts (it moves or fights). */
  readonly preemptsTask: boolean
  wants(state: ReflexState): boolean
  /** Runs until done or aborted. Must stop promptly when the signal aborts. */
  run(context: ReflexContext, state: ReflexState): Promise<ReflexOutcome>
}
