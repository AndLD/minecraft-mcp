import type { Clock } from '../core/clock.port.js'
import type { EntityScanner } from '../core/entity-scanner.port.js'
import type { Logger } from '../core/logger.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { VitalsReader } from '../core/vitals.port.js'
import type { ResumeDescriptor, TaskSnapshot } from '../tasks/task.types.js'
import type { Reflex, ReflexContext, ReflexState } from './reflex.types.js'

/** What the engine needs from the task manager. */
export interface TaskPreemption {
  suspend(): Promise<TaskSnapshot | undefined>
  takeSuspended(): ResumeDescriptor | undefined
  suspended(): TaskSnapshot | undefined
}

/** Starts a task again from its resume descriptor. */
export type TaskResumer = (resume: ResumeDescriptor) => Promise<boolean>

export interface ReflexEngineOptions {
  readonly reflexes: readonly Reflex[]
  readonly vitals: VitalsReader
  readonly entities: EntityScanner
  readonly tasks: TaskPreemption
  readonly resume: TaskResumer
  /** Tells the agent what happened (becomes an event in wait_for_chat). */
  readonly emit: (message: string) => void
  readonly scheduler: Scheduler
  readonly clock: Clock
  readonly logger: Logger
  readonly tickMs?: number
  /** How far to look for entities that reflexes may care about. */
  readonly scanRadius?: number
}

interface Running {
  readonly reflex: Reflex
  readonly controller: AbortController
  readonly done: Promise<void>
}

const DEFAULT_TICK_MS = 250
const DEFAULT_SCAN_RADIUS = 32

/**
 * Runs the survival reflexes. Each tick it reads the bot's state and lets the most important reflex that wants to act do so.
 * A reflex that needs the bot's movement stops the running task first, and the task is resumed afterwards when the
 * reflex says so. Works with no MCP client attached.
 */
export class ReflexEngine {
  private readonly options: ReflexEngineOptions
  private readonly reflexes: readonly Reflex[]
  private readonly tickMs: number
  private readonly scanRadius: number
  private running: Running | undefined
  private cancelTick: (() => void) | undefined
  private started = false
  private ticking = false
  /** Whether every reflex in the current episode allows resuming the task that was stopped. */
  private allowResume = true

  constructor(options: ReflexEngineOptions) {
    this.options = options
    this.reflexes = [...options.reflexes].sort((a, b) => b.priority - a.priority)
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.scanRadius = options.scanRadius ?? DEFAULT_SCAN_RADIUS
  }

  /** The reflex that is acting right now, if any. */
  activeReflex(): string | undefined {
    return this.running?.reflex.name
  }

  get isStarted(): boolean {
    return this.started
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.scheduleTick()
  }

  /** Stops ticking and aborts whatever reflex is running. */
  async stop(): Promise<void> {
    this.started = false
    this.cancelTick?.()
    this.cancelTick = undefined
    await this.abortRunning()
    this.options.tasks.takeSuspended()
  }

  private scheduleTick(): void {
    if (!this.started) return
    this.cancelTick = this.options.scheduler.after(this.tickMs, () => {
      void this.tick().finally(() => {
        this.scheduleTick()
      })
    })
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.started) return
    this.ticking = true
    try {
      const state = this.readState()
      if (state === undefined) {
        await this.abortRunning()
        return
      }
      const running = this.running
      if (running !== undefined && !running.reflex.wants(state)) {
        await this.abortRunning()
      }
      const wanting = this.reflexes.find((reflex) => reflex.wants(state))
      const current = this.running
      if (
        wanting !== undefined &&
        (current === undefined || wanting.priority > current.reflex.priority)
      ) {
        await this.abortRunning()
        await this.begin(wanting, state)
      } else if (wanting === undefined && this.running === undefined) {
        await this.finishEpisode()
      }
    } catch (error) {
      this.options.logger.error('Reflex engine tick failed', { error })
    } finally {
      this.ticking = false
    }
  }

  private readState(): ReflexState | undefined {
    const vitals = this.options.vitals.read()
    if (vitals === undefined) return undefined
    return {
      vitals,
      entities: this.options.entities.nearby(this.scanRadius),
      now: this.options.clock.now(),
    }
  }

  private async begin(reflex: Reflex, state: ReflexState): Promise<void> {
    if (reflex.preemptsTask) {
      const stopped = await this.options.tasks.suspend()
      if (stopped !== undefined) {
        this.options.emit(
          `Paused "${stopped.description}" for a survival reaction (${reflex.name}).`,
        )
      }
    }
    const controller = new AbortController()
    const context = this.contextFor(reflex, controller)
    const done = reflex
      .run(context, state)
      .then((outcome) => {
        if (!outcome.resumeTask) this.allowResume = false
      })
      .catch((error: unknown) => {
        this.options.logger.error('Reflex crashed', { reflex: reflex.name, error })
        this.allowResume = false
      })
      .finally(() => {
        if (this.running?.controller === controller) this.running = undefined
      })
    this.running = { reflex, controller, done }
  }

  private async abortRunning(): Promise<void> {
    const running = this.running
    if (running === undefined) return
    running.controller.abort()
    await running.done
  }

  /** No reflex wants to act any more: resume the task that was paused, unless a reflex said not to. */
  private async finishEpisode(): Promise<void> {
    const waiting = this.options.tasks.suspended()
    const allow = this.allowResume
    this.allowResume = true
    if (waiting === undefined) return
    const resume = this.options.tasks.takeSuspended()
    if (!allow || resume === undefined) {
      this.options.emit(
        `"${waiting.description}" was stopped for a survival reaction and was not resumed${resume === undefined ? ' (it cannot be restarted automatically)' : ''}; ask the player what to do.`,
      )
      return
    }
    const started = await this.options.resume(resume)
    this.options.emit(
      started
        ? `Resumed "${waiting.description}".`
        : `Could not resume "${waiting.description}"; ask the player what to do.`,
    )
  }

  private contextFor(reflex: Reflex, controller: AbortController): ReflexContext {
    return {
      signal: controller.signal,
      emit: (message) => {
        this.options.emit(message)
      },
      state: () => this.readState(),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          if (controller.signal.aborted) {
            resolve()
            return
          }
          let cancel = (): void => undefined
          const done = (): void => {
            cancel()
            controller.signal.removeEventListener('abort', done)
            resolve()
          }
          cancel = this.options.scheduler.after(ms, done)
          controller.signal.addEventListener('abort', done, { once: true })
        }),
      withTimeout: (ms) => {
        const inner = new AbortController()
        const abort = (): void => {
          inner.abort()
        }
        if (controller.signal.aborted) inner.abort()
        const cancelTimer = this.options.scheduler.after(ms, abort)
        controller.signal.addEventListener('abort', abort, { once: true })
        return {
          signal: inner.signal,
          dispose: () => {
            cancelTimer()
            controller.signal.removeEventListener('abort', abort)
          },
        }
      },
    }
  }
}
