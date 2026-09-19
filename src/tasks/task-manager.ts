import type { Clock } from '../core/clock.port.js'
import type { Logger } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { SkillFailure } from '../core/skill.types.js'
import type { StopHandler } from '../core/stop-handler.port.js'
import type { TaskSnapshot, TaskSpec } from './task.types.js'

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

  constructor(options: TaskManagerOptions) {
    this.clock = options.clock
    this.scheduler = options.scheduler
    this.logger = options.logger
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS
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
        startedAt: this.clock.now(),
        finishedAt: undefined,
      },
      controller,
      settleListeners,
      finished: false,
    }
    this.tasks.set(id, entry)
    this.activeId = id

    const update = (patch: Partial<TaskSnapshot>): void => {
      entry.snapshot = { ...entry.snapshot, ...patch }
    }
    const context = {
      signal: controller.signal,
      progress: (message: string): void => {
        if (!entry.finished) update({ progress: message })
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
      if (controller.signal.aborted) this.finish(entry, { status: 'cancelled' })
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
    if (entry.finished || timeoutMs <= 0 || signal?.aborted === true)
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

  /** Cancels the task (default: the running one) and waits until it has stopped. */
  async cancel(id?: string): Promise<TaskSnapshot | undefined> {
    const targetId = id ?? this.activeId
    const entry = targetId === undefined ? undefined : this.tasks.get(targetId)
    if (entry === undefined || entry.finished) return entry?.snapshot

    entry.controller.abort()
    await this.waitFor(entry.snapshot.id, this.cancelGraceMs)
    if (!this.hasFinished(entry)) {
      this.logger.warn('Task did not stop in time; releasing it anyway', {
        task: entry.snapshot.id,
      })
      this.finish(entry, { status: 'cancelled' })
    }
    return entry.snapshot
  }

  /** Cancels whatever is running (the owner said "stop"). Does not wait. */
  stopAll(): void {
    if (this.activeId !== undefined) void this.cancel(this.activeId)
  }

  /** Read through a method: the flag changes while `cancel` is awaiting, which control-flow analysis cannot see. */
  private hasFinished(entry: TaskEntry): boolean {
    return entry.finished
  }

  private finish(
    entry: TaskEntry,
    patch: Partial<Pick<TaskSnapshot, 'status' | 'result' | 'failure'>>,
  ): void {
    entry.finished = true
    entry.snapshot = { ...entry.snapshot, ...patch, finishedAt: this.clock.now() }
    if (this.activeId === entry.snapshot.id) this.activeId = undefined
    for (const listener of [...entry.settleListeners]) listener()
    this.prune()
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((entry) => entry.finished)
    const excess = finished.length - this.historyLimit
    for (const entry of finished.slice(0, Math.max(0, excess))) this.tasks.delete(entry.snapshot.id)
  }
}
