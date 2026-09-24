import type { Scheduler } from '../../core/scheduler.port.js'

/** Calls a check every few seconds while the bot is connected. */
export class NightWatch {
  private cancel: (() => void) | undefined

  constructor(
    private readonly check: () => Promise<void>,
    private readonly scheduler: Scheduler,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.cancel !== undefined) return
    this.schedule()
  }

  stop(): void {
    this.cancel?.()
    this.cancel = undefined
  }

  private schedule(): void {
    this.cancel = this.scheduler.after(this.intervalMs, () => {
      // A failing check must not end the watch.
      void this.check()
        .catch(() => undefined)
        .finally(() => {
          if (this.cancel !== undefined) this.schedule()
        })
    })
  }
}
