import type { Connection } from '../core/connection.port.js'
import type { Logger } from '../core/logger.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { SessionService } from './session-service.js'

/** Waits between attempts, in seconds: quick at first (a server restart), then a minute apart (a closed world). */
export const RECONNECT_DELAYS_S = [5, 10, 20, 40, 60, 60, 60, 60, 60, 60] as const

export interface ReconnectSupervisorDeps {
  readonly connection: Connection
  readonly session: Pick<SessionService, 'connect'>
  readonly scheduler: Scheduler
  readonly logger: Logger
  /** How many attempts to make after a lost connection; 0 turns the supervisor off. */
  readonly attempts: number
  /** Tells the agent (an inbox event). */
  readonly emit: (type: string, message: string) => void
}

/**
 * Rejoins the world when the connection is lost (the server restarted, the network dropped, the LAN world was closed
 * and opened again). It never reconnects after a `disconnect` or shutdown, nor after a kick (a ban or a whitelist would
 * only repeat), and stops as soon as somebody connects by hand. It does not resume any task: the tasks that were
 * running are recorded as interrupted and the agent decides, as after a restart. Every step is told to the agent.
 */
export class ReconnectSupervisor {
  private cancelTimer: (() => void) | undefined
  private trying = false
  private kicked = false
  private attempt = 0
  private stopListening: (() => void) | undefined

  constructor(private readonly deps: ReconnectSupervisorDeps) {}

  start(): void {
    if (this.stopListening !== undefined || this.deps.attempts === 0) return
    this.stopListening = this.deps.connection.onEvent((event) => {
      if (event.type === 'kicked') this.kicked = true
      else if (event.type === 'connected') this.reset()
      else if (event.type === 'disconnected') {
        const kicked = this.kicked
        this.kicked = false
        if (event.intentional === true || kicked) return
        this.begin(event.reason)
      }
    })
  }

  /** True while it is waiting to retry or retrying: the agent should keep listening, not give up. */
  get reconnecting(): boolean {
    return this.cancelTimer !== undefined || this.trying
  }

  dispose(): void {
    this.stopListening?.()
    this.stopListening = undefined
    this.reset()
  }

  private reset(): void {
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.attempt = 0
  }

  private begin(reason: string): void {
    const target = this.deps.connection.target
    if (target === undefined) return
    this.reset()
    this.deps.emit(
      'reconnecting',
      `The connection was lost (${reason}). Trying to rejoin ${target.host}:${String(target.port)}: up to ${String(this.deps.attempts)} attempts. Tasks that were running are interrupted; nothing resumes by itself.`,
    )
    this.schedule()
  }

  private schedule(): void {
    const delay = RECONNECT_DELAYS_S[Math.min(this.attempt, RECONNECT_DELAYS_S.length - 1)] ?? 60
    this.cancelTimer = this.deps.scheduler.after(delay * 1000, () => {
      this.cancelTimer = undefined
      void this.tryOnce()
    })
  }

  private async tryOnce(): Promise<void> {
    const { connection, session, logger, emit } = this.deps
    const target = connection.target
    if (connection.state !== 'disconnected' || target === undefined) return
    this.attempt += 1
    this.trying = true
    const result = await session.connect({ host: target.host, port: target.port })
    this.trying = false
    if (result.ok) {
      logger.info('Reconnected', { attempt: this.attempt })
      emit(
        'reconnected',
        `Rejoined ${target.host}:${String(target.port)} on attempt ${String(this.attempt)}. Check get_session_briefing for interrupted tasks before doing anything else.`,
      )
      this.reset()
      return
    }
    logger.warn('Reconnect attempt failed', { attempt: this.attempt, reason: result.error })
    if (this.attempt >= this.deps.attempts) {
      emit(
        'reconnect_failed',
        `Could not rejoin after ${String(this.attempt)} attempts (last: ${result.error}). Ask the player whether the world is open, then call connect.`,
      )
      this.reset()
      return
    }
    if (this.down()) this.schedule()
  }

  /** Read through a method so the compiler does not assume the state is still what it was before the attempt. */
  private down(): boolean {
    return this.deps.connection.state === 'disconnected'
  }
}
