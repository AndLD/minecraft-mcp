import type { Clock } from '../core/clock.port.js'
import type { Scheduler } from '../core/scheduler.port.js'
import type { BotEvent, ChatMessage, InboxBatch } from './chat-message.types.js'

export interface AgentInboxOptions {
  readonly clock: Clock
  readonly scheduler: Scheduler
  /** Maximum buffered chat messages and events (each); the oldest are dropped first. */
  readonly capacity?: number
}

export interface WaitResult extends InboxBatch {
  /** True when nothing arrived before the timeout (or the wait was aborted). */
  readonly timedOut: boolean
}

interface Waiter {
  resolve(result: WaitResult): void
}

const DEFAULT_CAPACITY = 200

/**
 * Buffers what the agent has not seen yet: chat from the owner and bot events.
 * Delivery is once-only: a wait drains everything buffered. With several concurrent
 * waiters the earliest one gets the next batch.
 */
export class AgentInbox {
  private readonly clock: Clock
  private readonly scheduler: Scheduler
  private readonly capacity: number
  private messages: ChatMessage[] = []
  private events: BotEvent[] = []
  private dropped = 0
  private readonly waiters: Waiter[] = []

  constructor(options: AgentInboxOptions) {
    this.clock = options.clock
    this.scheduler = options.scheduler
    this.capacity = options.capacity ?? DEFAULT_CAPACITY
  }

  get pendingCount(): number {
    return this.messages.length + this.events.length
  }

  pushMessage(message: Omit<ChatMessage, 'receivedAt'>): void {
    this.messages.push({ ...message, receivedAt: this.clock.now() })
    if (this.messages.length > this.capacity) {
      this.messages.shift()
      this.dropped += 1
    }
    this.flushToWaiter()
  }

  pushEvent(event: Omit<BotEvent, 'at'>): void {
    this.events.push({ ...event, at: this.clock.now() })
    if (this.events.length > this.capacity) {
      this.events.shift()
      this.dropped += 1
    }
    this.flushToWaiter()
  }

  /** Returns what is buffered without waiting. */
  drain(): InboxBatch {
    const batch: InboxBatch = {
      messages: this.messages,
      events: this.events,
      dropped: this.dropped,
    }
    this.messages = []
    this.events = []
    this.dropped = 0
    return batch
  }

  /** Resolves as soon as something is buffered, or with an empty result after `timeoutMs`. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    if (this.pendingCount > 0) return Promise.resolve({ ...this.drain(), timedOut: false })
    if (signal?.aborted === true) return Promise.resolve(emptyResult())

    return new Promise<WaitResult>((resolve) => {
      let cancelTimer = (): void => undefined
      const finish = (result: WaitResult): void => {
        cancelTimer()
        signal?.removeEventListener('abort', onAbort)
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve(result)
      }
      const waiter: Waiter = { resolve: finish }
      const onAbort = (): void => {
        finish(emptyResult())
      }
      cancelTimer = this.scheduler.after(timeoutMs, () => {
        finish(emptyResult())
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private flushToWaiter(): void {
    const waiter = this.waiters[0]
    if (waiter === undefined) return
    waiter.resolve({ ...this.drain(), timedOut: false })
  }
}

function emptyResult(): WaitResult {
  return { messages: [], events: [], dropped: 0, timedOut: true }
}
