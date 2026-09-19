import type { Clock } from '../core/clock.port.js'
import type { Logger } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { DecisionPrompt, SkillContext, SkillFailure } from '../core/skill.types.js'
import type { StopHandler } from '../core/stop-handler.port.js'
import type {
  CancelReason,
  ResumeDescriptor,
  TaskEvent,
  TaskSnapshot,
  TaskSpec,
} from './task.types.js'

export interface TaskManagerOptions {
  readonly clock: Clock
  readonly scheduler: Scheduler
  readonly logger: Logger
  /** How many finished tasks to remember. */
  readonly historyLimit?: number
  /** How long a cancelled task may take to stop before its slot is freed anyway. */
  readonly cancelGraceMs?: number
}

interface TaskEntry {
  snapshot: TaskSnapshot
  readonly controller: AbortController
  readonly settleListeners: (() => void)[]
  finished: boolean
  cancelReason: CancelReason | undefined
  /** Resolves the question the task is waiting on. */
  answerPending: ((answer: string | undefined) => void) | undefined
}

const DEFAULT_HISTORY_LIMIT = 20
const DEFAULT_CANCEL_GRACE_MS = 3_000

/**
 * Runs one long task at a time. Every task gets an AbortSignal, reports progress,
 * and can be cancelled by id, by the owner's "stop", or by a disconnect.
 */
export class TaskManager implements StopHandler {
  private readonly clock: Clock
  private readonly scheduler: Scheduler
  private readonly logger: Logger
  private readonly historyLimit: number
  private readonly cancelGraceMs: number
  private readonly tasks = new Map<string, TaskEntry>()
  private counter = 0
  private activeId: string | undefined
  private suspendedTask: TaskSnapshot | undefined
  private readonly eventListeners = new Set<(event: TaskEvent) => void>()

  constructor(options: TaskManagerOptions) {
    this.clock = options.clock
    this.scheduler = options.scheduler
    this.logger = options.logger
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
  }

  /** Observes every task starting, reporting progress, and finishing (used by the task journal). */
  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /** The running task, if any. */
  current(): TaskSnapshot | undefined {
    return this.activeId === undefined ? undefined : this.tasks.get(this.activeId)?.snapshot
  }

  /** The most recently started task, running or finished. */
  latest(): TaskSnapshot | undefined {
    return [...this.tasks.values()].at(-1)?.snapshot
  }

  get(id: string): TaskSnapshot | undefined {
    return this.tasks.get(id)?.snapshot
  }

  /** Starts the task, unless another one is still running. */
  start(spec: TaskSpec): Result<TaskSnapshot> {
    const running = this.current()
    if (running !== undefined) {
      return err(
        `Task ${running.id} (${running.description}) is still running. Cancel it first (cancel_task or stop), or pass replace=true.`,
      )
    }

    this.suspendedTask = undefined // a new task replaces whatever was waiting to resume
    this.counter += 1
    const id = `task-${String(this.counter)}`
    const controller = new AbortController()
    const settleListeners: (() => void)[] = []
    const entry: TaskEntry = {
      snapshot: {
        id,
        name: spec.name,
        description: spec.description,
        status: 'running',
        progress: undefined,
        result: undefined,
        failure: undefined,
        cancelReason: undefined,
        resume: spec.resume,
        pending: undefined,
        startedAt: this.clock.now(),
        finishedAt: undefined,
      },
      controller,
      settleListeners,
      finished: false,
      cancelReason: undefined,
      answerPending: undefined,
    }
    this.tasks.set(id, entry)
    this.activeId = id
    this.emit({ type: 'started', snapshot: entry.snapshot })

    const update = (patch: Partial<TaskSnapshot>): void => {
      entry.snapshot = { ...entry.snapshot, ...patch }
    }
    const context: SkillContext = {
      signal: controller.signal,
      progress: (message: string): void => {
        if (entry.finished) return
        update({ progress: message })
        this.emit({ type: 'progress', snapshot: entry.snapshot })
      },
      ask: (prompt: DecisionPrompt): Promise<string | undefined> => {
        if (entry.finished || controller.signal.aborted) return Promise.resolve(undefined)
        return new Promise((resolve) => {
          const onAbort = (): void => {
            settle(undefined)
          }
          const settle = (answer: string | undefined): void => {
            controller.signal.removeEventListener('abort', onAbort)
            entry.answerPending = undefined
            if (!entry.finished) update({ status: 'running', pending: undefined })
            resolve(answer)
          }
          entry.answerPending = settle
          controller.signal.addEventListener('abort', onAbort, { once: true })
          update({ status: 'waiting_for_input', pending: prompt })
          this.emit({ type: 'waiting', snapshot: entry.snapshot })
          for (const listener of [...entry.settleListeners]) listener() // wake whoever waits for the task
        })
      },
    }

    void (async (): Promise<void> => {
      let outcome: Result<unknown, SkillFailure>
      try {
        outcome = await spec.run(context)
      } catch (error) {
        this.logger.error('Task crashed', { task: id, name: spec.name, error })
        outcome = err({
          reason: 'internal_error',
          message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
      if (entry.finished) return // Already released after a cancel that was not honored.
      if (controller.signal.aborted)
        this.finish(entry, { status: 'cancelled', cancelReason: entry.cancelReason })
      else if (outcome.ok) this.finish(entry, { status: 'succeeded', result: outcome.value })
      else this.finish(entry, { status: 'failed', failure: outcome.error })
    })()
    return ok(entry.snapshot)
  }

  /**
   * Waits for the task to finish, up to `timeoutMs`. Resolves with the task's current state
   * (still `running` after a timeout or an abort). Undefined for an unknown id.
   */
  waitFor(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskSnapshot | undefined> {
    const entry = this.tasks.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    if (
      entry.finished ||
      entry.snapshot.status === 'waiting_for_input' ||
      timeoutMs <= 0 ||
      signal?.aborted === true
    )
      return Promise.resolve(entry.snapshot)

    return new Promise((resolve) => {
      let cancelTimer = (): void => undefined
      const done = (): void => {
        cancelTimer()
        signal?.removeEventListener('abort', done)
        const index = entry.settleListeners.indexOf(done)
        if (index >= 0) entry.settleListeners.splice(index, 1)
        resolve(entry.snapshot)
      }
      cancelTimer = this.scheduler.after(timeoutMs, done)
      signal?.addEventListener('abort', done, { once: true })
      entry.settleListeners.push(done)
    })
  }

  /**
   * Gives a waiting task the player's answer, and lets it carry on. Fails when the task is not waiting or the answer is
   * not one of the offered options.
   */
  answer(decision: string, id?: string): Result<TaskSnapshot> {
    const targetId = id ?? this.activeId
    const entry = targetId === undefined ? undefined : this.tasks.get(targetId)
    if (entry === undefined || entry.finished || entry.snapshot.pending === undefined)
      return err(
        targetId === undefined
          ? 'No task is waiting for an answer.'
          : `Task ${targetId} is not waiting for an answer.`,
      )
    const { options } = entry.snapshot.pending
    if (!options.includes(decision)) return err(`Choose one of: ${options.join(', ')}.`)
    entry.answerPending?.(decision)
    this.emit({ type: 'progress', snapshot: entry.snapshot })
    return ok(entry.snapshot)
  }

  /** Cancels the task (default: the running one) and waits until it has stopped. */
  async cancel(id?: string, reason: CancelReason = 'requested'): Promise<TaskSnapshot | undefined> {
    if (reason !== 'preempted') this.suspendedTask = undefined
    const targetId = id ?? this.activeId
    const entry = targetId === undefined ? undefined : this.tasks.get(targetId)
    if (entry === undefined || entry.finished) return entry?.snapshot

    entry.cancelReason = reason
    entry.controller.abort()
    await this.waitFor(entry.snapshot.id, this.cancelGraceMs)
    if (!this.hasFinished(entry)) {
      this.logger.warn('Task did not stop in time; releasing it anyway', {
        task: entry.snapshot.id,
      })
      this.finish(entry, { status: 'cancelled', cancelReason: entry.cancelReason })
    }
    return entry.snapshot
  }

  /** Cancels whatever is running (the owner said "stop"). Does not wait. */
  stopAll(): void {
    this.suspendedTask = undefined
    if (this.activeId !== undefined) void this.cancel(this.activeId)
  }

  /**
   * Stops the running task so a survival reflex can take over, remembering it so it can be resumed.
   * Returns the task, or undefined when nothing was running.
   */
  async suspend(): Promise<TaskSnapshot | undefined> {
    const running = this.current()
    if (running === undefined) return undefined
    const stopped = await this.cancel(running.id, 'preempted')
    this.suspendedTask = stopped
    return stopped
  }

  /** The task waiting to be resumed after a reflex, without taking it. */
  suspended(): TaskSnapshot | undefined {
    return this.suspendedTask
  }

  /** Takes the suspended task's resume descriptor (once). Undefined when nothing waits or it cannot be resumed. */
  takeSuspended(): ResumeDescriptor | undefined {
    const resume = this.suspendedTask?.resume
    this.suspendedTask = undefined
    return resume
  }

  /** Forgets the suspended task (the player stopped everything, so nothing must resume). */
  discardSuspended(): void {
    this.suspendedTask = undefined
  }

  /** Read through a method: the flag changes while `cancel` is awaiting, which control-flow analysis cannot see. */
  private hasFinished(entry: TaskEntry): boolean {
    return entry.finished
  }

  private finish(
    entry: TaskEntry,
    patch: Partial<Pick<TaskSnapshot, 'status' | 'result' | 'failure' | 'cancelReason'>>,
  ): void {
    entry.finished = true
    entry.snapshot = {
      ...entry.snapshot,
      ...patch,
      pending: undefined,
      finishedAt: this.clock.now(),
    }
    if (this.activeId === entry.snapshot.id) this.activeId = undefined
    for (const listener of [...entry.settleListeners]) listener()
    this.emit({ type: 'finished', snapshot: entry.snapshot })
    this.prune()
  }

  private emit(event: TaskEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((entry) => entry.finished)
    const excess = finished.length - this.historyLimit
    for (const entry of finished.slice(0, Math.max(0, excess))) this.tasks.delete(entry.snapshot.id)
  }
}
