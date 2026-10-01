import type {
  Connection,
  ConnectionEvent,
  ConnectionInfo,
  ConnectionState,
  ConnectTarget,
  Unsubscribe,
} from '../core/connection.port.js'
import type { Logger } from '../core/logger.js'
import { err, ok, type Result } from '../core/result.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { BotFactory, BotHolder, BotLike } from './bot-like.types.js'
import { formatReason } from './format-reason.js'

export interface MineflayerConnectionOptions {
  readonly factory: BotFactory
  readonly scheduler: Scheduler
  readonly logger: Logger
  /** How long to wait for the bot to spawn before giving up. */
  readonly connectTimeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DISCONNECT_TIMEOUT_MS = 3_000

export class MineflayerConnection implements Connection, BotHolder {
  private readonly factory: BotFactory
  private readonly scheduler: Scheduler
  private readonly logger: Logger
  private readonly connectTimeoutMs: number
  private readonly eventListeners = new Set<(event: ConnectionEvent) => void>()
  private readonly botListeners = new Set<(bot: BotLike | undefined) => void>()
  private bot: BotLike | undefined
  private currentState: ConnectionState = 'disconnected'
  private currentTarget: ConnectTarget | undefined
  private intentionalDisconnect = false

  constructor(options: MineflayerConnectionOptions) {
    this.factory = options.factory
    this.scheduler = options.scheduler
    this.logger = options.logger
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  get state(): ConnectionState {
    return this.currentState
  }

  get target(): ConnectTarget | undefined {
    return this.currentTarget
  }

  current(): BotLike | undefined {
    return this.currentState === 'connected' ? this.bot : undefined
  }

  onChange(listener: (bot: BotLike | undefined) => void): Unsubscribe {
    this.botListeners.add(listener)
    return () => {
      this.botListeners.delete(listener)
    }
  }

  onEvent(listener: (event: ConnectionEvent) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  connect(target: ConnectTarget): Promise<Result<ConnectionInfo>> {
    if (this.currentState !== 'disconnected') {
      return Promise.resolve(err(`Cannot connect while ${this.currentState}. Disconnect first.`))
    }
    this.currentState = 'connecting'
    this.currentTarget = target
    this.intentionalDisconnect = false

    let bot: BotLike
    try {
      bot = this.factory(target)
    } catch (error) {
      this.currentState = 'disconnected'
      return Promise.resolve(err(`Could not create the bot: ${formatReason(error)}`))
    }
    this.bot = bot

    return new Promise<Result<ConnectionInfo>>((resolve) => {
      let settled = false
      const cleanups: (() => void)[] = []

      const settle = (result: Result<ConnectionInfo>): void => {
        if (settled) return
        settled = true
        for (const cleanup of cleanups) cleanup()
        if (result.ok) {
          this.currentState = 'connected'
          this.attachRuntimeListeners(bot)
          this.notifyBot(bot)
          this.emit({ type: 'connected', username: result.value.username })
        } else {
          this.currentState = 'disconnected'
          this.bot = undefined
          try {
            bot.quit()
          } catch {
            // The bot may already be gone.
          }
        }
        resolve(result)
      }

      const fail = (reason: string): void => {
        settle(err(reason))
      }
      const onSpawn = (): void => {
        settle(ok({ username: bot.username, version: bot.version }))
      }
      const onError = (error: Error): void => {
        fail(`Connection error: ${error.message}`)
      }
      const onKicked = (reason: unknown): void => {
        fail(`Kicked while joining: ${formatReason(reason)}`)
      }
      const onEnd = (reason: string): void => {
        fail(`Connection closed before joining: ${reason}`)
      }

      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('kicked', onKicked)
      bot.once('end', onEnd)
      cleanups.push(
        () => bot.removeListener('spawn', onSpawn),
        () => bot.removeListener('error', onError),
        () => bot.removeListener('kicked', onKicked),
        () => bot.removeListener('end', onEnd),
        this.scheduler.after(this.connectTimeoutMs, () => {
          fail(
            `Timed out after ${String(this.connectTimeoutMs / 1000)} s waiting to join ${target.host}:${String(target.port)}`,
          )
        }),
      )
    })
  }

  disconnect(): Promise<void> {
    const bot = this.bot
    if (bot === undefined || this.currentState === 'disconnected') return Promise.resolve()
    this.intentionalDisconnect = true

    return new Promise<void>((resolve) => {
      let cancelTimer = (): void => undefined
      const done = (): void => {
        cancelTimer()
        bot.removeListener('end', done)
        resolve()
      }
      bot.once('end', done)
      cancelTimer = this.scheduler.after(DISCONNECT_TIMEOUT_MS, () => {
        this.markDisconnected('Disconnected by request', true)
        done()
      })
      bot.quit()
    })
  }

  private attachRuntimeListeners(bot: BotLike): void {
    bot.on('end', (reason) => {
      if (this.bot !== bot) return
      this.markDisconnected(
        this.intentionalDisconnect ? 'Disconnected by request' : reason,
        this.intentionalDisconnect,
      )
    })
    bot.on('kicked', (reason) => {
      this.emit({ type: 'kicked', reason: formatReason(reason) })
    })
    bot.on('error', (error) => {
      this.logger.warn('Bot error', { message: error.message })
      this.emit({ type: 'error', message: error.message })
    })
  }

  private markDisconnected(reason: string, intentional = false): void {
    if (this.currentState === 'disconnected') return
    this.currentState = 'disconnected'
    this.bot = undefined
    this.notifyBot(undefined)
    this.emit({
      type: 'disconnected',
      reason,
      ...(intentional ? { intentional: true as const } : {}),
    })
  }

  private notifyBot(bot: BotLike | undefined): void {
    for (const listener of this.botListeners) listener(bot)
  }

  private emit(event: ConnectionEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }
}
